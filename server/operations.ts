import type { Env } from "./types";
import { now, DAY, HOUR, MINUTE } from "./types";
import { sendMail, sha } from "./security";
import { siteUrl } from "./config";
import { json } from "./db";
import { readState, writeState } from "./ops-state";
import { GRANT_PREFIX, RENEWAL_GRACE } from "./billing";
import { PRODUCT } from "../shared/brand";

// What the operator needs to know without reading logs: the hourly "Maintenance attention" summary (also e-mailed to
// ADMIN_EMAILS), work set aside for a manual check, and the operations view for administrators. Ported from rech-bg;
// the signals are Hookstreak's: runs, publishing, connected accounts, post stats, transcription, cleanup and Stripe.

export type ReviewArea = "runs" | "cleanup";
/**
 * Sets work aside for a manual check: provider work a failed run may have left running (and billing), or a storage
 * cleanup that was refused. Shown in the operations view and counted in the alert; never throws.
 */
export async function flagForReview(e: Env, area: ReviewArea, ref: string, requestId: string | null, reason: string) {
  try {
    await e.DB.prepare("INSERT OR IGNORE INTO manual_reviews(area,ref,request_id,reason,created_at) VALUES (?,?,?,?,?)")
      .bind(area, ref.slice(0, 200), requestId?.slice(0, 200) ?? null, reason, now()).run();
  } catch {
    console.error("Manual review not recorded", { area });
  }
}

type MaintenanceRun = { startedAt: number; finishedAt: number; failed: string[] };
export const lastMaintenanceRun = (e: Env) => readState<MaintenanceRun>(e, "maintenance");
/** The end of an hourly maintenance run: its time and failed stages. Manual checks are kept 90 days. */
export async function recordMaintenanceRun(e: Env, startedAt: number, failed: string[]) {
  await writeState(e, "maintenance", { startedAt, finishedAt: now(), failed } satisfies MaintenanceRun);
  await e.DB.prepare("DELETE FROM manual_reviews WHERE created_at<?").bind(now() - 90 * DAY).run();
}
/** Stages that threw in any maintenance pass (every minute or hourly): name → last time, for a day. */
export async function recordStageFailures(e: Env, failed: string[]) {
  if (!failed.length) return;
  const t = now(), previous = (await readState<Record<string, number>>(e, "stages")) || {};
  const merged: Record<string, number> = { ...previous, ...Object.fromEntries(failed.map((name) => [name, t])) };
  await writeState(e, "stages", Object.fromEntries(Object.entries(merged).filter(([, at]) => at > t - DAY)));
}

export type ServiceArea = "heygen" | "fal" | "elevenlabs" | "renderer" | "other";
/** The service a run's failure code points at (its prefix, see server/providers/http.ts failureCode). */
export function serviceOf(code: string): ServiceArea {
  if (code.startsWith("AVATAR_")) return "heygen";
  if (code.startsWith("GENERATION_")) return "fal";
  if (code.startsWith("VOICE_")) return "elevenlabs";
  if (code.startsWith("RENDER") || code === "MEDIA_TIMEOUT") return "renderer";
  return "other";
}
/** Failures caused by what was asked for (a refused prompt, a deleted file), never a sign of an outage. */
export const userCaused = (code: string) =>
  /_REJECTED$|_NOT_FOUND$/.test(code) || ["POST_INVALID", "MEDIA_INPUT", "MEDIA_FORMAT", "MEDIA_TOO_LARGE", "MEDIA_SIZE", "MEDIA_EMPTY"].includes(code);

// Several failures in one hour point at an outage rather than at one person's post.
export const FAILURE_BURST = 3;
// Many connections ending in a day point at a network revoking tokens or the app's credentials, not at one person.
export const RECONNECT_BURST = 5;
// Post stats are read 40 at a time every 5 minutes; this many failed reads in an hour is more than one account.
export const METRICS_BURST = 5;
/** Runs are failed (and refunded) by maintenance after 3 hours; still open later means maintenance isn't reaching them. */
const RUN_OVERDUE = 3 * HOUR + 15 * MINUTE;
const PUBLISH_OVERDUE = 15 * MINUTE;

const serviceNames: Record<ServiceArea, string> = {
  heygen: "HeyGen (talking creators)", fal: "fal (AI images and clips)", elevenlabs: "ElevenLabs (voices)",
  renderer: "Renderer (video and slides)", other: "Other run failures",
};
const labels: Record<string, string> = {
  runsStuck: "AI or render runs still open after 3 hours (maintenance should have ended and refunded them)",
  publishOverdue: "Scheduled posts more than 15 minutes overdue (the publishing cron isn't starting them)",
  publishFailed: "Failed publications in the last hour",
  reconnect: "Social accounts that need reconnecting, marked in the last 24 hours",
  metrics: "Post stats reads that failed in the last hour",
  transcription: "Speech transcriptions that failed in the last hour",
  cleanup: "Storage cleanup waiting for more than 1 day",
  review: "Work set aside for a manual check in the last 24 hours (provider work that may still bill, or a refused cleanup)",
  stripe: "Stripe: failed reconciliations in the last nightly run, or paid periods overdue for renewal by over 4 days",
  stages: "Maintenance stages that failed in the last hour",
};
const burst = (n: number, from: number) => (n >= from ? n : 0);

/** Everything overdue or suspicious right now; all zero means nothing to report. */
export async function attention(e: Env) {
  const t = now();
  const r = await e.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM runs WHERE status IN ('queued','running') AND created_at<?1) runsStuck,
      (SELECT COUNT(*) FROM publications WHERE status='scheduled' AND scheduled_at<?2) publishOverdue,
      (SELECT COUNT(*) FROM publications WHERE status='failed' AND scheduled_at>?3 AND updated_at>?4) publishFailed,
      (SELECT COUNT(*) FROM social_accounts WHERE status IN ('expired','revoked') AND updated_at>?5) reconnect,
      (SELECT COUNT(*) FROM publications WHERE status='published' AND published_at>?6 AND metrics_error='failed' AND metrics_checked_at>?4) metrics,
      (SELECT COUNT(*) FROM media_assets WHERE rowid>(SELECT COALESCE(MAX(rowid),0) FROM media_assets)-5000 AND json_valid(meta)
        AND json_extract(meta,'$.speech.status')='failed' AND json_extract(meta,'$.speech.at')>?4) transcription,
      (SELECT COUNT(*) FROM cleanup_tasks WHERE created_at<?5) cleanup,
      (SELECT COUNT(*) FROM manual_reviews WHERE created_at>?5) review,
      (SELECT COUNT(*) FROM subscriptions WHERE substr(id,1,6)<>?7 AND status='active' AND cancel_at_period_end=0 AND period_end<?8) renewals`,
  ).bind(t - RUN_OVERDUE, t - PUBLISH_OVERDUE, t - 7 * DAY, t - HOUR, t - DAY, t - 31 * DAY, GRANT_PREFIX, t - RENEWAL_GRACE - DAY)
    .first<Record<string, number>>();
  const n = (k: string) => Number(r?.[k]) || 0;
  // Failed runs of the last hour by code (runs live 3 hours at most, so the created_at bound keeps it on the index).
  const codes = (await e.DB.prepare("SELECT error AS code,COUNT(*) AS n FROM runs WHERE status='failed' AND created_at>? AND updated_at>? GROUP BY error")
    .bind(t - 4 * HOUR, t - HOUR).all<{ code: string | null; n: number }>()).results;
  const services: Record<ServiceArea, Record<string, number>> = { heygen: {}, fal: {}, elevenlabs: {}, renderer: {}, other: {} };
  for (const c of codes) {
    const code = c.code || "INTERNAL";
    if (!userCaused(code)) services[serviceOf(code)][code] = (services[serviceOf(code)][code] || 0) + Number(c.n);
  }
  const stripe = await readState<{ at: number; failed: number }>(e, "stripe");
  const stages = Object.entries((await readState<Record<string, number>>(e, "stages")) || {})
    .filter(([, at]) => at > t - HOUR - 5 * MINUTE).map(([name]) => name).sort();
  const counts: Record<string, number> = {
    runsStuck: n("runsStuck"),
    ...Object.fromEntries((Object.keys(services) as ServiceArea[]).map((s) => [s, burst(Object.values(services[s]).reduce((a, b) => a + b, 0), FAILURE_BURST)])),
    publishOverdue: n("publishOverdue"),
    publishFailed: burst(n("publishFailed"), FAILURE_BURST),
    reconnect: burst(n("reconnect"), RECONNECT_BURST),
    metrics: burst(n("metrics"), METRICS_BURST),
    transcription: burst(n("transcription"), FAILURE_BURST),
    cleanup: n("cleanup"),
    review: n("review"),
    stripe: n("renewals") + (stripe && stripe.at > t - 26 * HOUR ? Number(stripe.failed) || 0 : 0),
    stages: stages.length,
  };
  return { counts, services, stages };
}

const recipients = (list?: string) =>
  [...new Set((list || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s)))].slice(0, 10);
/** The summary's lines, as e-mailed (codes are our own short codes, never provider text). */
function attentionLines({ counts, services, stages }: Awaited<ReturnType<typeof attention>>) {
  return Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => {
    if (k in serviceNames) {
      const by = Object.entries(services[k as ServiceArea]).sort((a, b) => b[1] - a[1]).map(([code, c]) => `${code} ${c}`).join(", ");
      return `- ${serviceNames[k as ServiceArea]}: ${n} failed runs in the last hour (${by})`;
    }
    return `- ${labels[k] || k}: ${n}${k === "stages" ? ` (${stages.join(", ")})` : ""}`;
  });
}
/**
 * Logs "Maintenance attention" and e-mails ADMIN_EMAILS when something needs a look: at once when the summary
 * changes, otherwise at most every 6 hours. A mail failure is logged and retried next hour, never thrown.
 */
export async function reportAttention(e: Env) {
  const summary = await attention(e);
  const lines = attentionLines(summary);
  if (!lines.length) {
    // Resolved: the same problem coming back later is news again.
    await e.DB.prepare("DELETE FROM operations_state WHERE key='alert'").run();
    return;
  }
  console.error("Maintenance attention", Object.fromEntries(Object.entries(summary.counts).filter(([, n]) => n > 0)));
  const hash = await sha(JSON.stringify(lines));
  const previous = await readState<{ hash: string; at: number }>(e, "alert");
  if (previous?.hash === hash && previous.at > now() - 6 * HOUR) return;
  const to = recipients(e.ADMIN_EMAILS);
  if (!to.length) return;
  const text = [
    `${PRODUCT.name}'s hourly maintenance found something to check:`,
    "",
    ...lines,
    "",
    `Details: ${siteUrl(e)}/app/admin?tab=operations (administrators only).`,
    "In Cloudflare's Workers Logs, search for \"Maintenance attention\", \"Maintenance stage failed\" and \"Run failed\".",
    "A changed summary is sent at once; the same one again at most every 6 hours. See docs/OPERATIONS.md.",
  ].join("\n");
  let sent = 0;
  for (const address of to) {
    try {
      await sendMail(e, address, `${PRODUCT.name}: maintenance needs a look`, text);
      sent++;
    } catch {
      console.error("Operator alert not sent", { recipients: to.length });
    }
  }
  if (sent) await writeState(e, "alert", { hash, at: now() });
}

/** The first sentence of a stored, plain-English failure message (publications keep the message, not a code). */
export function firstSentence(message: string | null) {
  return (message || "").split(/(?<=\.)\s/)[0].trim().slice(0, 100) || "—";
}
/**
 * Failed runs that may have left paid work running at a provider (a HeyGen video or a fal request still in its
 * queue): the run gave up and refunded the credits, but the provider may finish and bill. Each is set aside once.
 */
export async function reviewRuns(e: Env) {
  const t = now();
  const rows = (await e.DB.prepare(
    "SELECT id,error,provider FROM runs WHERE status='failed' AND created_at>? AND updated_at>? AND error IN ('AVATAR_TIMEOUT','GENERATION_TIMEOUT','GENERATION_UNCERTAIN','MEDIA_TIMEOUT','INTERNAL') LIMIT 200",
  ).bind(t - 6 * HOUR, t - 2 * HOUR).all<{ id: string; error: string; provider: string }>()).results;
  for (const r of rows) {
    const s = json<{ tickets?: Record<string, any>; claims?: Record<string, boolean>; assets?: Record<string, string> }>(r.provider, {});
    const open: string[] = [];
    for (const [name, ticket] of Object.entries(s.tickets || {})) {
      if (s.assets?.[name] || !ticket || typeof ticket !== "object") continue;
      if (typeof ticket.video_id === "string") open.push(`HeyGen video ${ticket.video_id}`);
      else if (typeof ticket.request_id === "string") open.push(`fal request ${ticket.request_id}`);
    }
    // Claimed but no ticket stored: the provider may have accepted it (the answer was lost).
    const uncertain = Object.keys(s.claims || {}).filter((name) => name !== "voice" && !name.endsWith("-accepted") && !s.tickets?.[name] && !s.assets?.[name]);
    if (!open.length && !uncertain.length) continue;
    await flagForReview(e, "runs", r.id, open.length ? open.join("; ") : null, uncertain.length && !open.length ? "uncertain" : r.error.endsWith("TIMEOUT") ? "timeout" : "failed");
  }
}

type Failure = { area: string; code: string; count: number };
/** The administrators' operations view: failures of the last 24 hours, open work, accounts, cleanup, Stripe, checks. */
export async function operationsSnapshot(e: Env) {
  const t = now(), since = t - DAY;
  const [runs, publications, metrics, transcription] = await Promise.all([
    e.DB.prepare("SELECT error AS code,COUNT(*) AS n FROM runs WHERE status='failed' AND created_at>? AND updated_at>? GROUP BY error")
      .bind(since - 3 * HOUR, since).all<{ code: string | null; n: number }>(),
    e.DB.prepare("SELECT platform,error FROM publications WHERE status='failed' AND scheduled_at>? AND updated_at>? ORDER BY updated_at DESC LIMIT 2000")
      .bind(t - 7 * DAY, since).all<{ platform: string; error: string | null }>(),
    e.DB.prepare("SELECT platform,metrics_error AS code,COUNT(*) AS n FROM publications WHERE status='published' AND published_at>? AND metrics_error IS NOT NULL AND metrics_checked_at>? GROUP BY platform,metrics_error")
      .bind(t - 31 * DAY, since).all<{ platform: string; code: string; n: number }>(),
    e.DB.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE rowid>(SELECT COALESCE(MAX(rowid),0) FROM media_assets)-5000 AND json_valid(meta) AND json_extract(meta,'$.speech.status')='failed' AND json_extract(meta,'$.speech.at')>?")
      .bind(since).first<{ n: number }>(),
  ]);
  const failures: Failure[] = [];
  for (const r of runs.results) failures.push({ area: serviceOf(r.code || "INTERNAL"), code: r.code || "INTERNAL", count: Number(r.n) });
  const published = new Map<string, Failure>();
  for (const p of publications.results) {
    const key = `${p.platform}\n${firstSentence(p.error)}`;
    const f = published.get(key) ?? { area: `publish:${p.platform}`, code: firstSentence(p.error), count: 0 };
    f.count++;
    published.set(key, f);
  }
  failures.push(...published.values());
  for (const m of metrics.results) failures.push({ area: `stats:${m.platform}`, code: m.code, count: Number(m.n) });
  if (transcription?.n) failures.push({ area: "speech", code: "Transcription failed", count: Number(transcription.n) });
  const r = await e.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM runs WHERE status IN ('queued','running') AND created_at<?1) runs,
      (SELECT COUNT(*) FROM publications WHERE status='publishing' AND COALESCE(claimed_at,updated_at)<?1) publishing,
      (SELECT COUNT(*) FROM publications WHERE status='scheduled' AND scheduled_at<?3) overdue,
      (SELECT COUNT(*) FROM cleanup_tasks) cleanup,
      (SELECT COUNT(*) FROM cleanup_tasks WHERE created_at<?2) cleanupOverdue,
      (SELECT MIN(created_at) FROM cleanup_tasks) cleanupOldest,
      (SELECT COUNT(*) FROM subscriptions WHERE substr(id,1,6)<>?4 AND status='active' AND cancel_at_period_end=0 AND period_end<?5) renewals,
      (SELECT COUNT(*) FROM subscriptions WHERE substr(id,1,6)=?4 AND period_end>?6) grants,
      (SELECT MAX(created_at) FROM billing_events) lastWebhook`,
  ).bind(t - HOUR, since, t - PUBLISH_OVERDUE, GRANT_PREFIX, t - RENEWAL_GRACE - DAY, t).first<Record<string, number | null>>();
  const accounts = (await e.DB.prepare(
    "SELECT platform,COUNT(*) AS total,SUM(updated_at>?) AS recent FROM social_accounts WHERE status IN ('expired','revoked') GROUP BY platform ORDER BY platform",
  ).bind(since).all<{ platform: string; total: number; recent: number | null }>()).results;
  const reviews = (await e.DB.prepare("SELECT area,ref,request_id,reason,created_at FROM manual_reviews WHERE created_at>? ORDER BY created_at DESC LIMIT 50")
    .bind(t - 7 * DAY).all<{ area: ReviewArea; ref: string; request_id: string | null; reason: string; created_at: number }>()).results;
  const stages = Object.entries((await readState<Record<string, number>>(e, "stages")) || {}).map(([name, at]) => ({ name, at })).sort((a, b) => b.at - a.at);
  const n = (k: string) => Number(r?.[k]) || 0;
  return {
    now: t,
    maintenance: await lastMaintenanceRun(e),
    stages,
    failures: failures.sort((a, b) => b.count - a.count || a.area.localeCompare(b.area) || a.code.localeCompare(b.code)),
    active: { runs: n("runs"), publishing: n("publishing"), overdue: n("overdue") },
    accounts: accounts.map((a) => ({ platform: a.platform, total: Number(a.total), recent: Number(a.recent) || 0 })),
    cleanup: { pending: n("cleanup"), overdue: n("cleanupOverdue"), oldest: r?.cleanupOldest ?? null },
    stripe: {
      reconciliation: await readState<{ at: number; checked: number; updated: number; failed: number }>(e, "stripe"),
      renewalsOverdue: n("renewals"), grants: n("grants"), lastWebhook: r?.lastWebhook ?? null,
    },
    reviews: reviews.map((x) => ({ area: x.area, ref: x.ref, requestId: x.request_id, reason: x.reason, createdAt: x.created_at })),
  };
}
