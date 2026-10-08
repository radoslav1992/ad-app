import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, DbUser, Env } from "./types";
import { DAY, HOUR, MINUTE, now, uid } from "./types";
import { json, ownedPost, ownedWorkspace } from "./db";
import { allowance } from "./billing";
import { safeEqual, token } from "./security";
import { planById } from "../shared/plans";
import { isPlatform, platforms, postsAsPhotos, type PlatformId } from "../shared/social";
import { nextFreeSlot, settingsSchema, slots, type Schedule } from "../shared/schedule";
import { failureMessage } from "./social";
import { freshTokens, markExpired, type AccountRow } from "./social/credentials";
import { unfit, type PostRow } from "./social/post";

// Scheduling approved posts on connected accounts, the calendar, and the cron that hands due posts to the
// Publication workflow (publish-workflow.ts).

export const publishing = new Hono<App>();
/** Capability links the networks fetch media from (no session; publications.token). */
export const publishMedia = new Hono<{ Bindings: Env }>();

/** The earliest and latest a post can be scheduled, from now. */
const LEAD = MINUTE, HORIZON = 180 * DAY;
/** A media link works this long after the publication was claimed. */
const LINK_TTL = 24 * HOUR;
/** A publication 'publishing' this long is given up (the workflow polls for at most about an hour). */
const STUCK = 2 * HOUR;
const BATCH = 25;

const id = z.string().regex(/^[0-9a-f-]{36}$/i);
const atSchema = z.number().int().positive();

/** The workspace's posting rhythm (defaults when the settings are missing or damaged). */
export function workspaceSchedule(settings: string | null | undefined): Schedule {
  const parsed = settingsSchema.safeParse(json(settings, {}));
  return (parsed.success ? parsed.data : settingsSchema.parse({})).schedule;
}
/** Times already taken by a scheduled post in the workspace. */
async function taken(env: Env, workspaceId: string) {
  const rows = await env.DB.prepare("SELECT DISTINCT scheduled_at FROM publications WHERE workspace_id=? AND status IN ('scheduled','publishing')")
    .bind(workspaceId).all<{ scheduled_at: number }>();
  return rows.results.map((r) => r.scheduled_at);
}
async function canSchedule(env: Env, user: DbUser) {
  return planById((await allowance(env, user)).plan).scheduling;
}
const NEEDS_PLAN = () => new HTTPException(402, { message: "Scheduling and auto-publishing need a paid plan." });
function checkTime(at: number) {
  const t = now();
  if (at < t + LEAD || at > t + HORIZON) throw new HTTPException(400, { message: "Pick a time at least a minute from now and within the next 180 days." });
}
/** Accounts by ID, owned by the user; missing ones are left out. */
async function accountsById(env: Env, userId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await env.DB.prepare(`SELECT * FROM social_accounts WHERE user_id=? AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(userId, ...ids).all<AccountRow>();
  return rows.results;
}
/** One 'scheduled' publication per account; null when the post is already scheduled or published there. */
async function insertPublications(env: Env, post: PostRow, accounts: AccountRow[], at: number, ignoreDuplicates: boolean) {
  const t = now();
  const created = accounts.map((a) => ({ id: uid(), account: a }));
  const statements = created.map(({ id, account }) =>
    env.DB.prepare(`INSERT ${ignoreDuplicates ? "OR IGNORE " : ""}INTO publications(id,user_id,workspace_id,post_id,account_id,platform,scheduled_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'scheduled',?,?)`)
      .bind(id, post.user_id, post.workspace_id, post.id, account.id, account.platform, at, t, t));
  try {
    const results = await env.DB.batch(statements);
    return created.filter((_, i) => (results[i] as any)?.meta?.changes !== 0).map((c) => c.id);
  } catch (e) {
    if (String((e as Error)?.message || e).includes("UNIQUE"))
      throw new HTTPException(409, { message: "This post is already scheduled or published on one of these accounts." });
    throw e;
  }
}
/** A publication with its account, as the browser sees it. */
const SELECT_PUBLICATION =
  "SELECT p.id,p.post_id AS postId,p.account_id AS accountId,p.platform,p.scheduled_at AS scheduledAt,p.status,p.attempts,p.url,p.external_id AS externalId,p.error,p.published_at AS publishedAt,a.name AS accountName,a.handle AS accountHandle FROM publications p JOIN social_accounts a ON a.id=p.account_id";

publishing.post("/posts/:id/schedule", async (c) => {
  const user = c.get("user");
  const body = z.object({ accountIds: z.array(z.uuid()).min(1).max(30), at: atSchema.optional() }).parse(await c.req.json());
  const post: PostRow = await ownedPost(c.env, user.id, c.req.param("id"));
  if (post.status !== "approved") throw new HTTPException(409, { message: "Approve this post before scheduling it." });
  if (post.render_status !== "ready") throw new HTTPException(409, { message: "This post is still being made. Schedule it when it's ready." });
  if (!(await canSchedule(c.env, user))) throw NEEDS_PLAN();
  const ids = [...new Set(body.accountIds)];
  const accounts = await accountsById(c.env, user.id, ids);
  if (accounts.length !== ids.length) throw new HTTPException(404, { message: "Social account not found." });
  for (const a of accounts) {
    if (a.workspace_id !== post.workspace_id) throw new HTTPException(400, { message: "Choose accounts connected to this post's workspace." });
    if (a.status !== "active" || (a.expires_at && a.expires_at < now()))
      throw new HTTPException(409, { message: `Reconnect your ${platforms[a.platform].name} account (${a.name}) before scheduling to it.` });
    const problem = unfit(post, a.platform);
    if (problem) throw new HTTPException(400, { message: problem });
  }
  let at = body.at;
  if (at === undefined) {
    const ws = await ownedWorkspace(c.env, user.id, post.workspace_id);
    const slot = nextFreeSlot(workspaceSchedule(ws.settings), now() + LEAD, await taken(c.env, post.workspace_id));
    if (slot === null) throw new HTTPException(400, { message: "Add posting times to this workspace's schedule, or pick a time." });
    at = slot;
  }
  checkTime(at);
  const created = await insertPublications(c.env, post, accounts, at, false);
  const rows = await c.env.DB.prepare(`${SELECT_PUBLICATION} WHERE p.post_id=? AND p.user_id=? AND p.id IN (${created.map(() => "?").join(",")}) ORDER BY p.scheduled_at`)
    .bind(post.id, user.id, ...created).all();
  return c.json({ scheduledAt: at, publications: rows.results }, 201);
});

publishing.get("/workspaces/:id/calendar", async (c) => {
  const user = c.get("user");
  const ws = await ownedWorkspace(c.env, user.id, c.req.param("id"));
  const t = now();
  const q = z.object({
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
  }).parse({ from: c.req.query("from") || undefined, to: c.req.query("to") || undefined });
  const from = q.from ?? t - 7 * DAY;
  const to = q.to ?? from + 42 * DAY;
  if (to <= from || to - from > 100 * DAY) throw new HTTPException(400, { message: "Choose a range of up to 100 days." });
  const rows = await c.env.DB.prepare(
    `${SELECT_PUBLICATION.replace(" FROM publications p", ",posts.hook,posts.format,posts.cover_asset AS coverAsset FROM publications p JOIN posts ON posts.id=p.post_id")} WHERE p.workspace_id=? AND p.user_id=? AND p.scheduled_at>=? AND p.scheduled_at<? AND p.status!='canceled' ORDER BY p.scheduled_at LIMIT 1000`,
  ).bind(ws.id, user.id, from, to).all();
  const schedule = workspaceSchedule(ws.settings);
  const busy = await taken(c.env, ws.id);
  const free = slots(schedule, t + LEAD, 14).filter((s) => !busy.some((b) => Math.abs(b - s) < 600));
  return c.json({ publications: rows.results, slots: free, timezone: schedule.timezone });
});

publishing.get("/posts/:id/publications", async (c) => {
  const user = c.get("user");
  const post = await ownedPost(c.env, user.id, c.req.param("id"));
  const rows = await c.env.DB.prepare(`${SELECT_PUBLICATION} WHERE p.post_id=? AND p.user_id=? ORDER BY p.scheduled_at DESC LIMIT 200`).bind(post.id, user.id).all();
  return c.json({ publications: rows.results });
});

async function ownedPublication(env: Env, userId: string, publicationId: string) {
  const p = id.safeParse(publicationId).success
    ? await env.DB.prepare("SELECT * FROM publications WHERE id=? AND user_id=?").bind(publicationId, userId).first<any>()
    : null;
  if (!p) throw new HTTPException(404, { message: "Scheduled post not found." });
  return p;
}

publishing.patch("/publications/:id", async (c) => {
  const user = c.get("user");
  const { at } = z.object({ at: atSchema }).parse(await c.req.json());
  const p = await ownedPublication(c.env, user.id, c.req.param("id"));
  checkTime(at);
  const r = await c.env.DB.prepare("UPDATE publications SET scheduled_at=?,updated_at=? WHERE id=? AND user_id=? AND status='scheduled'").bind(at, now(), p.id, user.id).run();
  if (!r.meta.changes) throw new HTTPException(409, { message: "Only posts that are still scheduled can be moved." });
  return c.json({ ok: true, scheduledAt: at });
});

publishing.delete("/publications/:id", async (c) => {
  const user = c.get("user");
  const p = await ownedPublication(c.env, user.id, c.req.param("id"));
  const r = await c.env.DB.prepare("UPDATE publications SET status='canceled',updated_at=? WHERE id=? AND user_id=? AND status='scheduled'").bind(now(), p.id, user.id).run();
  if (!r.meta.changes) throw new HTTPException(409, { message: "This post is already being published or done, so it can't be canceled." });
  return c.json({ ok: true });
});

publishing.post("/publications/:id/retry", async (c) => {
  const user = c.get("user");
  const p = await ownedPublication(c.env, user.id, c.req.param("id"));
  if (p.status !== "failed") throw new HTTPException(409, { message: "Only failed posts can be retried." });
  if (!(await canSchedule(c.env, user))) throw NEEDS_PLAN();
  const account = await c.env.DB.prepare("SELECT * FROM social_accounts WHERE id=? AND user_id=?").bind(p.account_id, user.id).first<AccountRow>();
  if (!account || account.status !== "active") {
    const name = isPlatform(String(p.platform)) ? platforms[p.platform as PlatformId].name : "social";
    throw new HTTPException(409, { message: `Reconnect your ${name} account, then try again.` });
  }
  const post = await ownedPost(c.env, user.id, p.post_id);
  if (post.status !== "approved" || post.render_status !== "ready") throw new HTTPException(409, { message: "This post isn't ready to publish." });
  try {
    const r = await c.env.DB.prepare(
      "UPDATE publications SET status='scheduled',scheduled_at=?,error=NULL,ticket=NULL,token=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND user_id=? AND status='failed'",
    ).bind(now() + LEAD, now(), p.id, user.id).run();
    if (!r.meta.changes) throw new HTTPException(409, { message: "Only failed posts can be retried." });
  } catch (e) {
    if (String((e as Error)?.message || e).includes("UNIQUE"))
      throw new HTTPException(409, { message: "This post is already scheduled or published on that account." });
    throw e;
  }
  return c.json({ ok: true, scheduledAt: now() + LEAD });
});

/** Parses a single "bytes=a-b" range against a file of `size` bytes; null when absent, "invalid" when unsatisfiable. */
function byteRange(header: string | undefined, size: number): { offset: number; length: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return "invalid";
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!suffix) return "invalid";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

publishMedia.get("/:publicationId/:file", async (c) => {
  const notFound = () => c.json({ error: "Not found." }, 404);
  const file = /^(\d{1,2})(?:\.(?:mp4|jpg|png|webp|bin))?$/.exec(c.req.param("file"));
  const given = c.req.query("token") || "";
  if (!file || !id.safeParse(c.req.param("publicationId")).success || !/^[0-9a-f]{64}$/.test(given)) return notFound();
  const n = Number(file[1]);
  const row = await c.env.DB.prepare(
    "SELECT p.status,p.token,p.claimed_at,p.platform,p.user_id,posts.format,posts.video_asset,posts.slides FROM publications p JOIN posts ON posts.id=p.post_id WHERE p.id=?",
  ).bind(c.req.param("publicationId")).first<any>();
  if (!row || row.status !== "publishing" || !row.token || !safeEqual(row.token, given) || !row.claimed_at || row.claimed_at + LINK_TTL < now() || !isPlatform(row.platform))
    return notFound();
  const assetId = postsAsPhotos(row.format, row.platform) ? json<unknown[]>(row.slides, [])[n] : n === 0 ? row.video_asset : null;
  if (typeof assetId !== "string") return notFound();
  const asset = await c.env.DB.prepare("SELECT object_key,mime FROM media_assets WHERE id=? AND user_id=?").bind(assetId, row.user_id).first<{ object_key: string; mime: string }>();
  const head = asset ? await c.env.MEDIA.head(asset.object_key) : null;
  if (!asset || !head) return notFound();
  const size = head.size;
  const range = byteRange(c.req.header("Range"), size);
  const headers = new Headers({
    "Content-Type": asset.mime || head.httpMetadata?.contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
  });
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const object = await c.env.MEDIA.get(asset.object_key, range ? { range } : {});
  if (!object || !("body" in object)) return notFound();
  headers.set("Content-Length", String(range ? range.length : size));
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
  return new Response(c.req.method === "HEAD" ? null : object.body, { status: range ? 206 : 200, headers });
});

/**
 * Called when a post is approved in the swipe review: with auto-scheduling on (and a plan that includes it), the post
 * goes into the workspace's next free slot on its default accounts. Returns how many publications were created.
 */
export async function autoSchedule(env: Env, userId: string, postId: string): Promise<number> {
  const post = await env.DB.prepare("SELECT * FROM posts WHERE id=? AND user_id=?").bind(postId, userId).first<PostRow>();
  if (!post || post.status !== "approved" || post.render_status !== "ready") return 0;
  const ws = await env.DB.prepare("SELECT settings FROM workspaces WHERE id=? AND user_id=?").bind(post.workspace_id, userId).first<{ settings: string }>();
  if (!ws) return 0;
  const schedule = workspaceSchedule(ws.settings);
  if (!schedule.autoSchedule || !schedule.accounts.length) return 0;
  const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(userId).first<DbUser>();
  if (!user || !(await canSchedule(env, user))) return 0;
  const t = now();
  const already = await env.DB.prepare("SELECT account_id FROM publications WHERE post_id=? AND status IN ('scheduled','publishing','published')").bind(post.id).all<{ account_id: string }>();
  const skip = new Set(already.results.map((r) => r.account_id));
  // The workspace's accounts filtered here: D1 binds at most 100 parameters, and a default list can hold 100 IDs.
  const chosen = new Set(schedule.accounts);
  const all = await env.DB.prepare("SELECT * FROM social_accounts WHERE user_id=? AND workspace_id=? AND status='active'").bind(userId, post.workspace_id).all<AccountRow>();
  const accounts = all.results.filter((a) =>
    chosen.has(a.id) && !(a.expires_at && a.expires_at < t) && !skip.has(a.id) && !unfit(post, a.platform));
  if (!accounts.length) return 0;
  const slot = nextFreeSlot(schedule, t + LEAD, await taken(env, post.workspace_id));
  if (slot === null || slot > t + HORIZON) return 0;
  return (await insertPublications(env, post, accounts, slot, true)).length;
}

/**
 * Cron, every minute: claims due publications (each gets a media-link token and its attempt number) and starts a
 * Publication workflow for each; gives up on publications stuck in 'publishing'.
 */
export async function dispatchDue(env: Env): Promise<void> {
  const t = now();
  const stuck = await env.DB.prepare("SELECT id,platform FROM publications WHERE status='publishing' AND COALESCE(claimed_at,updated_at)<? LIMIT 100")
    .bind(t - STUCK).all<{ id: string; platform: string }>();
  for (const s of stuck.results) {
    await env.DB.prepare("UPDATE publications SET status='failed',error=?,token=NULL,updated_at=? WHERE id=? AND status='publishing' AND COALESCE(claimed_at,updated_at)<?")
      .bind(failureMessage(isPlatform(s.platform) ? s.platform : null, "TIMEOUT"), t, s.id, t - STUCK).run();
    console.warn("Publication timed out", { publicationId: s.id, code: "TIMEOUT" });
  }
  if (!env.PUBLISH) {
    console.error("Publishing is not configured: the PUBLISH workflow binding is missing");
    return;
  }
  const due = await env.DB.prepare("SELECT id FROM publications WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT ?").bind(t, BATCH).all<{ id: string }>();
  for (const { id: pubId } of due.results) {
    const claimed = await env.DB.prepare(
      "UPDATE publications SET status='publishing',claimed_at=?,token=?,ticket=NULL,attempts=attempts+1,updated_at=? WHERE id=? AND status='scheduled' AND scheduled_at<=? RETURNING attempts",
    ).bind(t, token(), t, pubId, t).first<{ attempts: number }>();
    if (!claimed) continue;
    const instance = `pub-${pubId}-${claimed.attempts}`;
    try {
      await env.PUBLISH.create({ id: instance, params: { publicationId: pubId } });
    } catch (e) {
      // Created before the error arrived: it runs. Otherwise the publication waits for the next minute.
      const exists = await env.PUBLISH.get(instance).then(() => true, () => false);
      if (exists) continue;
      console.error("Publication workflow could not start", { publicationId: pubId, error: (e as Error)?.name });
      await env.DB.prepare("UPDATE publications SET status='scheduled',token=NULL,claimed_at=NULL,updated_at=? WHERE id=? AND status='publishing'").bind(now(), pubId).run();
    }
  }
}

/**
 * Maintenance (daily is enough): renews Instagram's 60-day tokens in their last 10 days, so accounts that rarely
 * publish stay connected, and marks connections that ended as expired.
 */
export async function refreshAccounts(env: Env): Promise<void> {
  const t = now();
  await env.DB.prepare("UPDATE social_accounts SET status='expired',updated_at=? WHERE status='active' AND expires_at IS NOT NULL AND expires_at<?").bind(t, t).run();
  const due = await env.DB.prepare("SELECT * FROM social_accounts WHERE status='active' AND platform='instagram' AND expires_at<? ORDER BY expires_at LIMIT 50")
    .bind(t + 10 * DAY).all<AccountRow>();
  for (const account of due.results) {
    try {
      await freshTokens(env, account);
    } catch (e) {
      const code = (e as Error)?.message || "ERROR";
      console.warn("Social token renewal failed", { platform: account.platform, account: account.id, code });
      if (code === "SOCIAL_AUTH_EXPIRED") await markExpired(env, account.id);
    }
  }
}
