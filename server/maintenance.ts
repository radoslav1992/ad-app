import type { DbUser, Env } from "./types";
import { now, DAY, HOUR, MINUTE } from "./types";
import { dispatchDue, refreshAccounts } from "./publishing";
import { reconcileStripe, allowance } from "./billing";
import { dispatchRun } from "./posts";
import { failRun } from "./content-workflow";
import { failAsset } from "./media";
import { createBatch, workspaceSettings, writeSpecs } from "./workspaces";

// Cron (every minute): due posts are published at once; every five minutes stuck work is recovered; once an hour
// files are cleaned up, automations make their daily posts and (at 03:17 UTC) Stripe is reconciled.
async function stage(name: string, work: () => Promise<unknown>) {
  try {
    await work();
  } catch (error) {
    console.error("Maintenance stage failed", { stage: name, error: (error as Error)?.name, message: String((error as Error)?.message || "").slice(0, 120) });
  }
}
export async function maintenance(e: Env, at = Date.now()) {
  const d = new Date(at), minute = d.getUTCMinutes();
  await stage("publish", () => dispatchDue(e));
  if (minute % 5 === 0) await stage("runs", () => reconcileRuns(e));
  if (minute === 17) {
    await stage("cleanup", () => drainCleanup(e));
    await stage("uploads", () => expireUploads(e));
    await stage("housekeeping", () => housekeeping(e));
    await stage("automations", () => runAutomations(e));
    if (d.getUTCHours() === 3) {
      await stage("stripe", () => reconcileStripe(e));
      // Renews long-lived social tokens (Instagram's last 60 days) and marks ended connections expired.
      await stage("social-tokens", () => refreshAccounts(e));
    }
  }
}

const RUN_CEILING = 3 * HOUR;
/** Runs whose workflow never started are started again; runs stuck for hours are failed (and refunded). */
export async function reconcileRuns(e: Env) {
  if (!e.CONTENT) return;
  const rows = (await e.DB.prepare("SELECT id,status,created_at FROM runs WHERE status IN ('queued','running') AND updated_at<? ORDER BY created_at LIMIT 50")
    .bind(now() - 10 * MINUTE).all<{ id: string; status: string; created_at: number }>()).results;
  for (const r of rows) {
    if (r.created_at < now() - RUN_CEILING) {
      try { await (await e.CONTENT.get(r.id)).terminate(); } catch { /* already gone */ }
      await failRun(e, r.id, "MEDIA_TIMEOUT");
      continue;
    }
    let status: string | null = null;
    try { status = (await (await e.CONTENT.get(r.id)).status()).status; } catch { status = null; }
    if (status === null) await dispatchRun(e, r.id);
    else if (["errored", "terminated", "complete"].includes(status)) await failRun(e, r.id, "INTERNAL");
  }
  // A post left "being made" without any active run (an interrupted edit) is marked failed so it can be retried.
  await e.DB.prepare(
    "UPDATE posts SET render_status='failed',render_error='This post was interrupted. Try again.',updated_at=? WHERE render_status IN ('queued','running') AND updated_at<? AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.post_id=posts.id AND r.status IN ('queued','running'))",
  ).bind(now(), now() - 30 * MINUTE).run();
}

/** Deletes the R2 files of deleted rows (exact keys and prefixes), a batch at a time. */
export async function drainCleanup(e: Env) {
  const tasks = (await e.DB.prepare("SELECT prefix FROM cleanup_tasks ORDER BY created_at LIMIT 50").all<{ prefix: string }>()).results;
  for (const { prefix } of tasks) {
    if (!/^(media|library)\/[A-Za-z0-9._/-]+$/.test(prefix)) {
      await e.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(prefix).run();
      continue;
    }
    let cursor: string | undefined, rounds = 0;
    do {
      const page = await e.MEDIA.list({ prefix, cursor, limit: 1000 });
      if (page.objects.length) await e.MEDIA.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && ++rounds < 20);
    if (!cursor) await e.DB.prepare("DELETE FROM cleanup_tasks WHERE prefix=?").bind(prefix).run();
  }
}
/** Uploads never finished in a day are dropped; checks that never answered are failed. */
async function expireUploads(e: Env) {
  const stale = (await e.DB.prepare("SELECT id,object_key,upload_id FROM media_assets WHERE status='uploading' AND created_at<? LIMIT 100").bind(now() - DAY).all<any>()).results;
  for (const a of stale) {
    if (a.upload_id) await e.MEDIA.resumeMultipartUpload(a.object_key, a.upload_id).abort().catch(() => {});
    await e.DB.prepare("DELETE FROM media_assets WHERE id=?").bind(a.id).run();
  }
  const checking = (await e.DB.prepare("SELECT id FROM media_assets WHERE status='checking' AND updated_at<? LIMIT 100").bind(now() - HOUR).all<{ id: string }>()).results;
  for (const a of checking) await failAsset(e, a.id, "Checking this file took too long. Try uploading it again.");
  // Failed uploads are kept a week so people can see why, then removed.
  await e.DB.prepare("DELETE FROM media_assets WHERE status='failed' AND updated_at<?").bind(now() - 7 * DAY).run();
}
async function housekeeping(e: Env) {
  const t = now();
  await e.DB.batch([
    e.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(t),
    e.DB.prepare("DELETE FROM auth_tokens WHERE expires_at<?").bind(t),
    e.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(t),
    e.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(t),
    e.DB.prepare("DELETE FROM billing_events WHERE created_at<?").bind(t - 90 * DAY),
  ]);
}

/** Automations: once a day, workspaces that asked for it get fresh posts for review (when their queue runs low). */
export async function runAutomations(e: Env, limit = 10) {
  if (e.MEDIA_ENABLED !== "true" || !e.CONTENT) return;
  const rows = (await e.DB.prepare(
    "SELECT w.*,u.id AS uid FROM workspaces w JOIN users u ON u.id=w.user_id WHERE w.settings LIKE '%\"automation\":{\"enabled\":true%' AND (w.automated_at IS NULL OR w.automated_at<?) AND u.verified=1 ORDER BY COALESCE(w.automated_at,0) LIMIT ?",
  ).bind(now() - 20 * HOUR, limit).all<any>()).results;
  for (const w of rows) {
    await e.DB.prepare("UPDATE workspaces SET automated_at=? WHERE id=?").bind(now(), w.id).run();
    try {
      const settings = workspaceSettings(w);
      if (!settings.automation.enabled) continue;
      const user = await e.DB.prepare("SELECT * FROM users WHERE id=?").bind(w.user_id).first<DbUser>();
      if (!user) continue;
      const a = await allowance(e, user);
      const waiting = (await e.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE workspace_id=? AND status='pending' AND render_status<>'failed'").bind(w.id).first<{ n: number }>())?.n || 0;
      const count = Math.min(settings.automation.postsPerDay, settings.automation.postsPerDay * 2 - waiting, a.postsLimit - a.postsUsed);
      if (a.trialEnded || count < 1) continue;
      const { specs } = await writeSpecs(e, user, w, {
        count, formats: settings.formats, mention: true, useCredits: settings.automation.useCredits, inputs: {},
      });
      const result = await createBatch(e, user, w.id, specs);
      console.log("Automation made posts", { workspaceId: w.id, created: result.created.length, skipped: result.skipped.length });
    } catch (error) {
      console.error("Automation failed", { workspaceId: w.id, error: (error as Error)?.message?.slice(0, 120) });
    }
  }
}
