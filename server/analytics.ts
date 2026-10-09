import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env } from "./types";
import { DAY, now } from "./types";
import { json, ownedWorkspace } from "./db";
import { siteUrl } from "./config";
import { analyticsSite, checkedTarget, linkTarget, siteSnippet, trackedLink } from "./tracking";
import { isPlatform, platformIds, platforms, type PlatformId } from "../shared/social";
import {
  bioPlatforms, dayLabel, dayOf, statsPlatforms,
  type AnalyticsRange, type AnalyticsResponse, type Counts, type Money, type NetworkNote, type NetworkRow, type PostStatsResponse, type SetupResponse, type TopPost,
} from "../shared/analytics";

// The analytics page: post stats from the networks, clicks on tracked links and the sales they led to, per workspace.
// Only stored numbers are added up; a number nobody reported stays null and shows as "–".

export const analytics = new Hono<App>();

type Acc = { views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; clicks: number; conversions: number; revenue: Map<string, number> };
const blank = (): Acc => ({ views: null, likes: null, comments: null, shares: null, saves: null, clicks: 0, conversions: 0, revenue: new Map() });
const plus = (a: number | null, b: number | null) => (b === null || b === undefined ? a : (a ?? 0) + Number(b));
/** Hundredths per currency → amounts, largest first. */
const money = (m: Map<string, number>): Money[] =>
  [...m].map(([currency, cents]) => ({ currency, amount: cents / 100 })).sort((a, b) => b.amount - a.amount);
/** Likes, comments and shares together (what the networks report of people reacting). */
const engagement = (a: { likes: number | null; comments: number | null; shares: number | null }) => (a.likes ?? 0) + (a.comments ?? 0) + (a.shares ?? 0);
/** Most views first; posts without view counts (LinkedIn, Instagram without insights) by their engagement. */
const byReach = (a: Pick<Acc, "views" | "likes" | "comments" | "shares">, b: Pick<Acc, "views" | "likes" | "comments" | "shares">) =>
  (b.views ?? -1) - (a.views ?? -1) || engagement(b) - engagement(a);
const counts = (a: Acc): Counts => ({ views: a.views, likes: a.likes, comments: a.comments, shares: a.shares, saves: a.saves, clicks: a.clicks, conversions: a.conversions, revenue: money(a.revenue) });
const addSales = (a: Acc, n: number, currency: string | null, amount: number) => {
  a.conversions += n;
  if (currency && amount) a.revenue.set(currency, (a.revenue.get(currency) || 0) + amount);
};

type PubRow = {
  post_id: string; platform: string; url: string | null; published_at: number;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; metrics_at: number | null; metrics_error: string | null;
};

/** Notes for a network: why some numbers are missing and what to do about it. */
function notes(platform: PlatformId, pubs: PubRow[], accountExpired: boolean, t: number): NetworkNote[] {
  const name = platforms[platform].name;
  const out: NetworkNote[] = [];
  const has = (code: string) => pubs.some((p) => p.metrics_error === code);
  if (platform === "linkedin") out.push({ tone: "info", text: "LinkedIn doesn't share post stats with apps like this one, so only clicks and sales show here." });
  if (accountExpired || has("reconnect")) out.push({ tone: "warn", text: `Reconnect your ${name} account to keep its stats up to date.`, action: "reconnect" });
  else if (has("scope"))
    out.push({ tone: "warn", text: platform === "instagram" ? "Reconnect Instagram to allow views, shares and saves." : `Reconnect ${name} to allow post stats.`, action: "reconnect" });
  if (has("not_found"))
    out.push({ tone: "info", text: platform === "tiktok" ? "TikTok shares stats for public posts only." : `Some posts are no longer on ${name}.` });
  if (platform !== "linkedin" && pubs.some((p) => p.metrics_at === null && !p.metrics_error && p.published_at > t - DAY))
    out.push({ tone: "info", text: "New posts get their first stats within a few hours." });
  return out;
}

/** Everything the analytics page shows for a range of days (UTC days, today included). */
export async function workspaceAnalytics(env: Env, workspaceId: string, userId: string, days: AnalyticsRange, t = now()): Promise<AnalyticsResponse> {
  const firstDay = dayOf(t) - days + 1, since = firstDay * DAY;
  const [pubs, clicks, sales, accounts] = await Promise.all([
    env.DB.prepare(
      "SELECT post_id,platform,url,published_at,views,likes,comments,shares,saves,metrics_at,metrics_error FROM publications WHERE workspace_id=? AND user_id=? AND status='published' AND published_at>=? ORDER BY published_at DESC LIMIT 3000",
    ).bind(workspaceId, userId, since).all<PubRow>(),
    env.DB.prepare(
      "SELECT l.post_id,l.platform,k.day,SUM(k.clicks) AS clicks FROM link_clicks k JOIN tracked_links l ON l.code=k.code WHERE l.workspace_id=? AND k.day>=? GROUP BY l.post_id,l.platform,k.day",
    ).bind(workspaceId, firstDay).all<{ post_id: string; platform: string; day: number; clicks: number }>(),
    env.DB.prepare(
      "SELECT post_id,platform,currency,created_at/86400 AS day,COUNT(*) AS n,SUM(amount) AS amount FROM conversions WHERE workspace_id=? AND created_at>=? GROUP BY post_id,platform,currency,day",
    ).bind(workspaceId, since).all<{ post_id: string | null; platform: string | null; currency: string | null; day: number; n: number; amount: number }>(),
    env.DB.prepare("SELECT platform,status,expires_at FROM social_accounts WHERE workspace_id=? AND user_id=?")
      .bind(workspaceId, userId).all<{ platform: string; status: string; expires_at: number | null }>(),
  ]);

  const total = blank(), unattributed = blank();
  const networks = new Map<PlatformId, { acc: Acc; pubs: PubRow[] }>();
  const network = (p: PlatformId) => {
    if (!networks.has(p)) networks.set(p, { acc: blank(), pubs: [] });
    return networks.get(p)!;
  };
  const posts = new Map<string, { acc: Acc; postId: string; platform: PlatformId; url: string | null; publishedAt: number | null }>();
  const post = (postId: string, platform: PlatformId) => {
    const key = `${postId}|${platform}`;
    if (!posts.has(key)) posts.set(key, { acc: blank(), postId, platform, url: null, publishedAt: null });
    return posts.get(key)!;
  };
  const daily = new Map<number, { clicks: number; conversions: number }>();
  for (let d = firstDay; d <= dayOf(t); d++) daily.set(d, { clicks: 0, conversions: 0 });
  const addStats = (a: Acc, p: PubRow) => {
    a.views = plus(a.views, p.views); a.likes = plus(a.likes, p.likes); a.comments = plus(a.comments, p.comments); a.shares = plus(a.shares, p.shares); a.saves = plus(a.saves, p.saves);
  };

  let withStats = 0, lastUpdated: number | null = null;
  for (const p of pubs.results) {
    if (!isPlatform(p.platform)) continue;
    addStats(total, p);
    const n = network(p.platform);
    n.pubs.push(p);
    addStats(n.acc, p);
    const row = post(p.post_id, p.platform);
    addStats(row.acc, p);
    // The newest publication of the post on that network gives the link (only https links are passed on).
    if (!row.url && p.url && /^https:\/\//.test(p.url)) row.url = p.url;
    row.publishedAt = Math.max(row.publishedAt ?? 0, p.published_at);
    if (p.metrics_at !== null) {
      withStats++;
      lastUpdated = Math.max(lastUpdated ?? 0, p.metrics_at);
    }
  }
  for (const c of clicks.results) {
    const n = Number(c.clicks) || 0;
    total.clicks += n;
    const day = daily.get(c.day);
    if (day) day.clicks += n;
    if (!isPlatform(c.platform)) continue;
    network(c.platform).acc.clicks += n;
    if (c.post_id) post(c.post_id, c.platform).acc.clicks += n;
  }
  for (const s of sales.results) {
    const n = Number(s.n) || 0, amount = Number(s.amount) || 0;
    addSales(total, n, s.currency, amount);
    const day = daily.get(s.day);
    if (day) day.conversions += n;
    if (!s.platform || !isPlatform(s.platform)) {
      addSales(unattributed, n, s.currency, amount);
      continue;
    }
    addSales(network(s.platform).acc, n, s.currency, amount);
    if (s.post_id) addSales(post(s.post_id, s.platform).acc, n, s.currency, amount);
  }
  const expired = new Set<string>();
  for (const a of accounts.results) {
    if (!isPlatform(a.platform)) continue;
    network(a.platform);
    if (a.status !== "active" || (a.expires_at && a.expires_at < t)) expired.add(a.platform);
  }

  const networkRows: NetworkRow[] = platformIds.filter((p) => networks.has(p)).map((p) => {
    const { acc, pubs: list } = networks.get(p)!;
    const stamps = list.map((x) => x.metrics_at).filter((x): x is number => x !== null);
    return {
      platform: p, ...counts(acc), posts: list.length, withStats: stamps.length,
      statsAvailable: (statsPlatforms as readonly string[]).includes(p),
      lastUpdated: stamps.length ? Math.max(...stamps) : null,
      notes: notes(p, list, expired.has(p), t),
    };
  });

  // The best posts by views, clicks and sales (up to 20 rows; the page sorts them by the column people pick).
  const all = [...posts.values()];
  const sorted = (order: (a: Acc, b: Acc) => number) => [...all].sort((x, y) => order(x.acc, y.acc));
  const chosen = new Set([
    ...sorted(byReach).slice(0, 10),
    ...sorted((a, b) => b.clicks - a.clicks).filter((x) => x.acc.clicks > 0).slice(0, 5),
    ...sorted((a, b) => b.conversions - a.conversions).filter((x) => x.acc.conversions > 0).slice(0, 5),
  ]);
  const ids = [...new Set([...chosen].map((x) => x.postId))];
  const info = new Map<string, { hook: string; format: string; cover_asset: string | null; slides: string }>();
  if (ids.length) {
    const rows = await env.DB.prepare(`SELECT id,hook,format,cover_asset,slides FROM posts WHERE workspace_id=? AND user_id=? AND id IN (${ids.map(() => "?").join(",")})`)
      .bind(workspaceId, userId, ...ids).all<{ id: string; hook: string; format: string; cover_asset: string | null; slides: string }>();
    for (const r of rows.results) info.set(r.id, r);
  }
  const top: TopPost[] = [...chosen].map((x) => {
    const p = info.get(x.postId);
    return {
      postId: x.postId, platform: x.platform, ...counts(x.acc), hook: p?.hook || "", format: p?.format || null,
      thumbAssetId: p ? json<string[]>(p.slides, [])[0] || p.cover_asset : null, url: x.url, publishedAt: x.publishedAt, deleted: !p,
    };
  }).sort((a, b) => byReach(a, b) || b.clicks - a.clicks || b.conversions - a.conversions);

  return {
    days, since,
    totals: { ...counts(total), posts: pubs.results.length, withStats },
    networks: networkRows,
    daily: [...daily].map(([d, v]) => ({ day: dayLabel(d), ...v })),
    top,
    unattributed: { conversions: unattributed.conversions, revenue: money(unattributed.revenue) },
    lastUpdated,
  };
}

analytics.get("/workspaces/:id/analytics", async (c) => {
  const user = c.get("user");
  const ws = await ownedWorkspace(c.env, user.id, c.req.param("id"));
  return c.json(await workspaceAnalytics(c.env, ws.id, user.id, c.req.query("days") === "7" ? 7 : 30));
});

/** Views and clicks per post (all time), for the content cards and the calendar. */
analytics.get("/workspaces/:id/analytics/posts", async (c) => {
  const user = c.get("user");
  const ws = await ownedWorkspace(c.env, user.id, c.req.param("id"));
  const [views, clicks] = await Promise.all([
    c.env.DB.prepare(
      "SELECT post_id,SUM(views) AS views FROM publications WHERE workspace_id=? AND user_id=? AND status='published' GROUP BY post_id ORDER BY MAX(published_at) DESC LIMIT 500",
    ).bind(ws.id, user.id).all<{ post_id: string; views: number | null }>(),
    c.env.DB.prepare(
      "SELECT l.post_id,SUM(k.clicks) AS clicks FROM tracked_links l JOIN link_clicks k ON k.code=l.code WHERE l.workspace_id=? AND l.post_id!='' GROUP BY l.post_id ORDER BY MAX(k.day) DESC LIMIT 500",
    ).bind(ws.id).all<{ post_id: string; clicks: number }>(),
  ]);
  const out: PostStatsResponse["posts"] = {};
  for (const v of views.results) out[v.post_id] = { views: v.views === null ? null : Number(v.views), clicks: 0 };
  for (const k of clicks.results) out[k.post_id] = { views: out[k.post_id]?.views ?? null, clicks: Number(k.clicks) || 0 };
  return c.json({ posts: out } satisfies PostStatsResponse);
});

async function setupView(env: Env, ws: { id: string; website: string | null }, request: Request): Promise<SetupResponse> {
  const site = await analyticsSite(env, ws.id);
  const base = siteUrl(env, request);
  const codes: { platform: PlatformId; code: string }[] = [];
  for (const platform of bioPlatforms) codes.push({ platform, code: await trackedLink(env, ws.id, platform) });
  const clicks = await env.DB.prepare(
    "SELECT l.platform,SUM(k.clicks) AS clicks FROM tracked_links l JOIN link_clicks k ON k.code=l.code WHERE l.workspace_id=? AND l.post_id='' AND k.day>=? GROUP BY l.platform",
  ).bind(ws.id, dayOf(now()) - 29).all<{ platform: string; clicks: number }>();
  return {
    siteKey: site.site_key,
    scriptUrl: `${base}/t.js`,
    endpoint: `${base}/api/t/${site.site_key}`,
    snippet: siteSnippet(base, site.site_key),
    linksEnabled: !!site.links_enabled,
    targetUrl: site.target_url,
    website: ws.website,
    target: linkTarget(env, site, ws.website),
    bioLinks: codes.map(({ platform, code }) => ({
      platform, url: `${base}/go/${code}`, clicks: Number(clicks.results.find((r) => r.platform === platform)?.clicks) || 0,
    })),
    testedAt: site.tested_at,
  };
}

analytics.get("/workspaces/:id/analytics/setup", async (c) => {
  const ws = await ownedWorkspace(c.env, c.get("user").id, c.req.param("id"));
  return c.json(await setupView(c.env, ws, c.req.raw));
});

analytics.patch("/workspaces/:id/analytics/setup", async (c) => {
  const ws = await ownedWorkspace(c.env, c.get("user").id, c.req.param("id"));
  const d = z.object({
    linksEnabled: z.boolean().optional(),
    targetUrl: z.string().trim().max(300).nullable().optional(),
  }).parse(await c.req.json());
  const site = await analyticsSite(c.env, ws.id);
  let target = site.target_url;
  if (d.targetUrl !== undefined) {
    target = d.targetUrl ? checkedTarget(c.env, d.targetUrl) : null;
    if (d.targetUrl && !target) throw new HTTPException(400, { message: "Enter the address of your own website, like https://yourbrand.com." });
  }
  const enabled = d.linksEnabled ?? !!site.links_enabled;
  if (enabled && !linkTarget(c.env, { target_url: target }, ws.website))
    throw new HTTPException(400, { message: "Add your website address first, so tracked links have somewhere to go." });
  await c.env.DB.prepare("UPDATE analytics_sites SET target_url=?,links_enabled=?,updated_at=? WHERE workspace_id=?")
    .bind(target, enabled ? 1 : 0, now(), ws.id).run();
  return c.json(await setupView(c.env, ws, c.req.raw));
});

/** Old daily click counts and sales are dropped after 13 months (maintenance). */
export async function pruneAnalytics(env: Env, t = now()) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM link_clicks WHERE day<?").bind(dayOf(t) - 400),
    env.DB.prepare("DELETE FROM conversions WHERE created_at<?").bind(t - 400 * DAY),
  ]);
}
