import type { Env } from "./types";
import { DAY, HOUR, MINUTE, now } from "./types";
import { isPlatform } from "../shared/social";
import { statsPlatforms } from "../shared/analytics";
import { socialPlatforms, SocialError, type PostStats } from "./social";
import { freshTokens, markExpired, type AccountRow } from "./social/credentials";

// Post stats from the networks (views, likes, comments, shares), read by the cron for posts published in the last
// 30 days: new posts every few hours in their first two days, then daily. Each run takes a bounded batch, grouped by
// account (one token refresh and a few calls each), so it stays well inside the Workers subrequest limit.

/** How old a post's stats may get before they are read again. */
export const STATS_WINDOW = 30 * DAY;
/** A post is first read this long after it went out (the first minutes say little). */
export const FIRST_READ = 30 * MINUTE;
/** Read every 3 hours in the first two days, then every day (an hour early, so a daily run never slips a day). */
export const FRESH_FOR = 2 * DAY, FRESH_EVERY = 3 * HOUR, DAILY_EVERY = 23 * HOUR;

type Due = { id: string; account_id: string; platform: string; external_id: string };
/** Why nothing was read for a post: shown on the analytics page as a short note. */
export type MetricsError = "scope" | "reconnect" | "not_found" | "failed";

/** Published posts whose stats are due, oldest check first. */
export async function dueForStats(env: Env, limit: number, t = now()): Promise<Due[]> {
  const platforms = statsPlatforms.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id,account_id,platform,external_id FROM publications
     WHERE status='published' AND published_at>=? AND published_at<=? AND platform IN (${platforms}) AND external_id IS NOT NULL AND account_id IS NOT NULL
       AND (metrics_checked_at IS NULL OR metrics_checked_at<CASE WHEN published_at>=? THEN ? ELSE ? END)
     ORDER BY COALESCE(metrics_checked_at,0),published_at DESC LIMIT ?`,
  ).bind(t - STATS_WINDOW, t - FIRST_READ, ...statsPlatforms, t - FRESH_FOR, t - FRESH_EVERY, t - DAILY_EVERY, limit).all<Due>();
  return rows.results;
}

/**
 * Cron: reads the stats of due posts, at most `limit` posts on `accounts` accounts, and stops starting new accounts
 * after `budgetMs`. A failure affects only its account's posts; an expired token marks the account like publishing.
 */
export async function refreshMetrics(env: Env, o: { limit?: number; accounts?: number; budgetMs?: number } = {}) {
  const { limit = 40, accounts = 10, budgetMs = 60_000 } = o;
  const started = Date.now();
  const groups = new Map<string, Due[]>();
  for (const row of await dueForStats(env, limit)) {
    if (!groups.has(row.account_id) && groups.size >= accounts) continue;
    groups.set(row.account_id, [...(groups.get(row.account_id) || []), row]);
  }
  let read = 0;
  for (const [accountId, rows] of groups) {
    if (Date.now() - started > budgetMs) break;
    try {
      read += await refreshAccount(env, accountId, rows);
    } catch (e) {
      // Never stops the batch: the account's posts are tried again at their next interval.
      console.error("Post stats failed", { account: accountId, error: (e as Error)?.name });
      await settle(env, rows.map((r) => r.id), "failed").catch(() => {});
    }
  }
  return { accounts: groups.size, read };
}

/** Marks posts checked with a reason and nothing read (earlier numbers are kept). */
async function settle(env: Env, ids: string[], error: MetricsError) {
  if (!ids.length) return;
  await env.DB.prepare(`UPDATE publications SET metrics_checked_at=?,metrics_error=? WHERE id IN (${ids.map(() => "?").join(",")})`)
    .bind(now(), error, ...ids).run();
}

async function refreshAccount(env: Env, accountId: string, rows: Due[]): Promise<number> {
  const t = now();
  const ids = rows.map((r) => r.id);
  // Claimed first, so a run that overlaps this one (a slow network) doesn't read the same posts again.
  await env.DB.prepare(`UPDATE publications SET metrics_checked_at=? WHERE id IN (${ids.map(() => "?").join(",")})`).bind(t, ...ids).run();
  const account = await env.DB.prepare("SELECT * FROM social_accounts WHERE id=?").bind(accountId).first<AccountRow>();
  if (!account || account.status !== "active" || (account.expires_at && account.expires_at < t) || !isPlatform(account.platform)) {
    await settle(env, ids, "reconnect");
    return 0;
  }
  const platform = socialPlatforms[account.platform];
  if (!platform.stats || !platform.configured(env)) return settle(env, ids, "failed").then(() => 0);
  let found: Map<string, PostStats>;
  try {
    const tokens = await freshTokens(env, account);
    found = await platform.stats(env, tokens, rows.map((r) => r.external_id));
  } catch (e) {
    if (!(e instanceof SocialError)) throw e;
    if (e.code === "AUTH_EXPIRED") await markExpired(env, account.id);
    await settle(env, ids, e.code === "AUTH_EXPIRED" ? "reconnect" : e.code === "PERMISSION" ? "scope" : "failed");
    return 0;
  }
  const statements = rows.map((r) => {
    const s = found.get(r.external_id);
    if (!s) return env.DB.prepare("UPDATE publications SET metrics_error='not_found' WHERE id=?").bind(r.id);
    // A number the network didn't send this time keeps its last value.
    return env.DB.prepare(
      "UPDATE publications SET views=COALESCE(?,views),likes=COALESCE(?,likes),comments=COALESCE(?,comments),shares=COALESCE(?,shares),metrics_at=?,metrics_error=? WHERE id=?",
    ).bind(s.views, s.likes, s.comments, s.shares, t, s.limited ? "scope" : null, r.id);
  });
  await env.DB.batch(statements);
  return rows.filter((r) => found.has(r.external_id)).length;
}
