import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import worker from "../server/index";
import { seal } from "../server/crypto";
import { hit } from "../server/security";
import { maintenance } from "../server/maintenance";
import { dueForStats, refreshMetrics, FIRST_READ } from "../server/metrics";
import { SITE_SCRIPT, captionLink, trackedLink } from "../server/tracking";
import { Publication } from "../server/publish-workflow";
import { dispatchDue } from "../server/publishing";
import { socialPlatforms, type Tokens } from "../server/social";
import { count } from "../server/social/http";
import { youtubeStats } from "../server/social/youtube";
import { tiktokStats } from "../server/social/tiktok";
import { instagramInsights } from "../server/social/instagram";
import { commentary } from "../server/social/linkedin";
import { postText, type PostRow } from "../server/social/post";
import { SITE, call, signedIn, subscribe, testEnv } from "./helpers";

const KEYS = {
  TIKTOK_CLIENT_KEY: "tt-key", TIKTOK_CLIENT_SECRET: "tt-secret", INSTAGRAM_APP_ID: "ig-app", INSTAGRAM_APP_SECRET: "ig-secret",
  GOOGLE_CLIENT_ID: "g-client", GOOGLE_CLIENT_SECRET: "g-secret", LINKEDIN_CLIENT_ID: "li-client", LINKEDIN_CLIENT_SECRET: "li-secret",
};
const now = () => Math.floor(Date.now() / 1000);
const MINUTE = 60, HOUR = 3600, DAY = 86400;
const today = () => Math.floor(now() / DAY);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_36.1.0";

type Call = { method: string; url: URL; headers: Headers; body: any };
type Route = [method: string, prefix: string, reply: (c: Call) => Response | Promise<Response>];
function mockFetch(routes: Route[]) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const c: Call = { method: (init.method || "GET").toUpperCase(), url: new URL(String(input)), headers: new Headers(init.headers), body: init.body };
    calls.push(c);
    const route = routes.find(([m, prefix]) => m === c.method && c.url.href.startsWith(prefix));
    if (!route) throw new Error(`Unexpected request ${c.method} ${c.url.href}`);
    return route[2](c);
  });
  return calls;
}
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

/** A request as another site, a browser or a crawler sends it (no session cookie, any headers). */
async function raw(env: any, method: string, path: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(new Request(SITE + path, { method, headers: init.headers, body: init.body }), env,
    { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {} } as any);
  await Promise.all(waits);
  const text = method === "HEAD" ? "" : await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
async function setup(website: string | null = "https://brand.co/") {
  const { env, sqlite } = testEnv(KEYS);
  const user = signedIn(sqlite);
  subscribe(sqlite, user.id, "starter");
  const workspace = crypto.randomUUID(), t = now();
  sqlite.prepare("INSERT INTO workspaces(id,user_id,name,website,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(workspace, user.id, "Brand", website, JSON.stringify({ schedule: { timezone: "UTC" } }), t, t);
  sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,posts_quota) VALUES (?,?,?,?,?)").run(`${user.id}:trial`, user.id, "free", 10, 50);
  sqlite.prepare("INSERT INTO media_limits(user_id,max_bytes) VALUES (?,?)").run(user.id, 10 * 1024 ** 3);
  return { env, sqlite, user, workspace };
}
function addPost(s: Ctx, o: { hook?: string; cover?: string; caption?: string } = {}) {
  const id = crypto.randomUUID(), t = now();
  const spec = { caption: o.caption ?? "Meet the new blender.", hashtags: ["#kitchen"] };
  s.sqlite.prepare("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,hook,caption,status,render_status,cover_asset,duration,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.user.id, s.workspace, `${s.user.id}:trial`, "text", JSON.stringify(spec), o.hook ?? "Stop scrolling", spec.caption, "approved", "ready", o.cover ?? null, 12, t, t);
  return id;
}
async function addAccount(s: Ctx, platform: string, o: { tokens?: Partial<Tokens>; status?: string } = {}) {
  const id = crypto.randomUUID(), t = now();
  const tokens: Tokens = { accessToken: `${platform}-access`, refreshToken: `${platform}-refresh`, expiresAt: t + 30 * DAY, ...o.tokens };
  s.sqlite.prepare("INSERT INTO social_accounts(id,user_id,workspace_id,platform,external_id,name,handle,credentials,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.user.id, s.workspace, platform, `${platform}-${id.slice(0, 8)}`, `${platform} account`, "brandco", await seal(s.env, tokens), o.status ?? "active", t, t);
  return id;
}
type PubOptions = { status?: string; publishedAgo?: number; checkedAgo?: number | null; externalId?: string | null; url?: string | null; metrics?: Record<string, unknown> };
function addPublication(s: Ctx, postId: string, accountId: string | null, platform: string, o: PubOptions = {}) {
  const id = crypto.randomUUID(), t = now();
  const published = o.publishedAgo === undefined ? t - 2 * HOUR : t - o.publishedAgo;
  s.sqlite.prepare("INSERT INTO publications(id,user_id,workspace_id,post_id,account_id,platform,scheduled_at,status,external_id,url,published_at,metrics_checked_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.user.id, s.workspace, postId, accountId, platform, published, o.status ?? "published", o.externalId === undefined ? `${platform}-${id.slice(0, 8)}` : o.externalId,
      o.url ?? null, published, o.checkedAgo == null ? null : t - o.checkedAgo, t, t);
  for (const [k, v] of Object.entries(o.metrics || {})) s.sqlite.prepare(`UPDATE publications SET ${k}=? WHERE id=?`).run(v as any, id);
  return id;
}
const pub = (s: Ctx, id: string) => s.sqlite.prepare("SELECT * FROM publications WHERE id=?").get(id) as any;
/** Turns on tracked links (and sets a target) the way the analytics page does. */
async function enableLinks(s: Ctx, targetUrl: string | null = "https://brand.co/launch") {
  const r = await call(worker, s.env, "PATCH", `/api/workspaces/${s.workspace}/analytics/setup`, { linksEnabled: true, targetUrl }, s.user.cookie);
  expect(r.status).toBe(200);
  return r.data;
}
const siteKey = async (s: Ctx) => (await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics/setup`, undefined, s.user.cookie)).data.siteKey as string;
const click = (s: Ctx, code: string, ip = "198.51.100.7", headers: Record<string, string> = {}) =>
  raw(s.env, "GET", `/go/${code}`, { headers: { "User-Agent": CHROME, "CF-Connecting-IP": ip, ...headers } });
const clicksOf = (s: Ctx, code: string) =>
  (s.sqlite.prepare("SELECT COALESCE(SUM(clicks),0) AS n FROM link_clicks WHERE code=?").get(code) as any).n as number;
const report = (s: Ctx, key: string, body: unknown, headers: Record<string, string> = {}) =>
  raw(s.env, "POST", `/api/t/${key}`, {
    headers: { "Content-Type": "text/plain", Origin: "https://brand.co", "CF-Connecting-IP": "203.0.113.9", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("migration 0002", () => {
  const dir = new URL("../migrations/", import.meta.url);
  it("applies on top of 0001 without disturbing what the deployed code reads and writes", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("0001_initial.sql", dir), "utf8"));
    const t = now();
    // Rows as the code before 0002 writes them.
    db.prepare("INSERT INTO users(id,email,name,password_hash,created_at) VALUES ('u1','a@b.co','A','x',?)").run(t);
    db.prepare("INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES ('w1','u1','W',?,?)").run(t, t);
    db.prepare("INSERT INTO usage_windows(id,user_id,quota,posts_quota) VALUES ('u1:trial','u1',10,10)").run();
    db.prepare("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,created_at,updated_at) VALUES ('p1','u1','w1','u1:trial','text','{}',?,?)").run(t, t);
    db.prepare("INSERT INTO publications(id,user_id,workspace_id,post_id,platform,scheduled_at,status,published_at,created_at,updated_at) VALUES ('x1','u1','w1','p1','youtube',?,'published',?,?,?)").run(t, t, t, t);

    const sql = readFileSync(new URL("0002_analytics.sql", dir), "utf8");
    // Only additions: the deployed code keeps working while this is applied before it ships.
    const statements = sql.replace(/--.*$/gm, "").split(";").map((x) => x.trim().replace(/\s+/g, " ")).filter(Boolean);
    for (const st of statements) expect(st).toMatch(/^(ALTER TABLE publications ADD COLUMN \w+ \w+|CREATE (UNIQUE )?INDEX \w+ ON|CREATE TABLE \w+ \()/);
    db.exec(sql);

    const columns = (db.prepare("PRAGMA table_info(publications)").all() as any[]).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(["views", "likes", "comments", "shares", "metrics_at", "metrics_checked_at", "metrics_error"]));
    expect(db.prepare("SELECT * FROM publications WHERE id='x1'").get()).toMatchObject({ status: "published", views: null, metrics_at: null });
    // The publishing code's insert (explicit columns) and update still work.
    db.prepare("INSERT INTO publications(id,user_id,workspace_id,post_id,account_id,account_name,platform,scheduled_at,status,created_at,updated_at) VALUES ('x2','u1','w1','p1',NULL,'',?,?,'scheduled',?,?)").run("tiktok", t, t, t);
    db.prepare("UPDATE publications SET status='published',external_id='1',url=NULL,published_at=?,ticket=NULL,token=NULL,error=NULL,updated_at=? WHERE id='x2'").run(t, t);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["analytics_sites", "tracked_links", "link_clicks", "conversions"]));

    // Tracking rows go with their workspace.
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("INSERT INTO analytics_sites(workspace_id,site_key,created_at,updated_at) VALUES ('w1','k',?,?)").run(t, t);
    db.prepare("INSERT INTO tracked_links(code,workspace_id,post_id,platform,created_at) VALUES ('c1','w1','p1','youtube',?)").run(t);
    db.prepare("INSERT INTO link_clicks(code,day,clicks) VALUES ('c1',1,3)").run();
    db.prepare("INSERT INTO conversions(id,workspace_id,amount,created_at) VALUES ('v1','w1',100,?)").run(t);
    db.prepare("DELETE FROM posts WHERE id='p1'").run();
    // A deleted post keeps its published link working.
    expect(db.prepare("SELECT COUNT(*) AS n FROM tracked_links").get()).toEqual({ n: 1 });
    db.prepare("DELETE FROM workspaces WHERE id='w1'").run();
    for (const table of ["analytics_sites", "tracked_links", "link_clicks", "conversions"])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });
});

describe("stats parsers", () => {
  it("count only whole, non-negative numbers", () => {
    expect([count(12), count("12"), count(0), count(-1), count(1.5), count("1e3"), count(null), count(undefined), count("")]).toEqual([12, 12, 0, null, null, null, null, null, null]);
  });

  it("read YouTube statistics, leaving hidden likes and turned-off comments out", () => {
    const m = youtubeStats({
      kind: "youtube#videoListResponse",
      items: [
        { kind: "youtube#video", id: "dQw4w9WgXcQ", statistics: { viewCount: "1234", likeCount: "56", favoriteCount: "0", commentCount: "7" } },
        { kind: "youtube#video", id: "abcdefghijk", statistics: { viewCount: "10" } },
        { id: "<script>", statistics: { viewCount: "1" } },
      ],
      pageInfo: { totalResults: 3, resultsPerPage: 3 },
    });
    expect([...m]).toEqual([
      ["dQw4w9WgXcQ", { views: 1234, likes: 56, comments: 7, shares: null }],
      ["abcdefghijk", { views: 10, likes: null, comments: null, shares: null }],
    ]);
    expect(youtubeStats(null).size).toBe(0);
    expect(youtubeStats({ items: "nope" }).size).toBe(0);
  });

  it("read TikTok video stats without losing the last digits of 64-bit IDs", () => {
    const text = `{"data":{"videos":[{"id":7212345678901234567,"view_count":980,"like_count":12,"comment_count":3,"share_count":4},
      {"id":"7298765432109876543","view_count":5,"like_count":0,"comment_count":0,"share_count":0},{"id":"x1","view_count":1}],"cursor":0,"has_more":false},
      "error":{"code":"ok","message":"","log_id":"20261008"}}`;
    expect([...tiktokStats(text)]).toEqual([
      ["7212345678901234567", { views: 980, likes: 12, comments: 3, shares: 4 }],
      ["7298765432109876543", { views: 5, likes: 0, comments: 0, shares: 0 }],
    ]);
    expect(tiktokStats("<html>").size).toBe(0);
  });

  it("read Instagram insights in both answer shapes", () => {
    expect(instagramInsights({
      data: [
        { name: "views", period: "lifetime", values: [{ value: 4321 }], title: "Views", id: "1/insights/views/lifetime" },
        { name: "shares", period: "lifetime", values: [{ value: 12 }], title: "Shares", id: "1/insights/shares/lifetime" },
      ],
    })).toEqual({ views: 4321, shares: 12, saves: null });
    expect(instagramInsights({ data: [{ name: "views", total_value: { value: 9 } }] })).toEqual({ views: 9, shares: null, saves: null });
    expect(instagramInsights({})).toEqual({ views: null, shares: null, saves: null });
  });
});

describe("reading stats from the networks", () => {
  const tokens = (o: Partial<Tokens> = {}): Tokens => ({ accessToken: "at", expiresAt: now() + DAY, ...o });

  it("asks YouTube for up to 50 videos a call, and needs the read scope", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `video${String(i).padStart(6, "0")}`);
    const calls = mockFetch([["GET", "https://www.googleapis.com/youtube/v3/videos", (c) => ok({
      items: c.url.searchParams.get("id")!.split(",").map((id) => ({ id, statistics: { viewCount: "3", likeCount: "1", commentCount: "0" } })),
    })]]);
    const found = await socialPlatforms.youtube.stats!({} as any, tokens(), [...ids, "bad id!"]);
    expect(found.size).toBe(51);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get("part")).toBe("statistics");
    expect(calls[0].url.searchParams.get("id")!.split(",")).toHaveLength(50);
    expect(calls[0].headers.get("Authorization")).toBe("Bearer at");
    // Unticked on Google's consent screen: nothing is asked.
    await expect(socialPlatforms.youtube.stats!({} as any, tokens({ scope: "https://www.googleapis.com/auth/youtube.upload" }), ids)).rejects.toMatchObject({ code: "PERMISSION" });
    expect(calls).toHaveLength(2);
    mockFetch([["GET", "https://www.googleapis.com/youtube/v3/videos", () =>
      ok({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }], message: "Insufficient Permission" } }, 403)]]);
    await expect(socialPlatforms.youtube.stats!({} as any, tokens(), ids.slice(0, 1))).rejects.toMatchObject({ code: "PERMISSION" });
  });

  it("asks TikTok's video query for public videos only, 20 a call, and needs video.list", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => String(7212345678901234000n + BigInt(i)));
    const calls = mockFetch([["POST", "https://open.tiktokapis.com/v2/video/query/", (c) => {
      const asked: string[] = JSON.parse(c.body).filters.video_ids;
      return new Response(`{"data":{"videos":[${asked.map((id) => `{"id":${id},"view_count":10,"like_count":2,"comment_count":1,"share_count":1}`).join(",")}]},"error":{"code":"ok"}}`);
    }]]);
    // A private post only has a publish ID.
    const found = await socialPlatforms.tiktok.stats!({} as any, tokens({ scope: "user.info.basic,video.publish,video.list" }), [...ids, "v_pub_file~v2-1.7212"]);
    expect([...found.keys()]).toEqual(ids);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get("fields")).toBe("id,view_count,like_count,comment_count,share_count");
    expect(JSON.parse(calls[0].body).filters.video_ids).toHaveLength(20);
    expect(calls[0].headers.get("Content-Type")).toContain("application/json");
    // A connection from before video.list was asked for: reconnect.
    await expect(socialPlatforms.tiktok.stats!({} as any, tokens({ scope: "user.info.basic,video.publish" }), ids)).rejects.toMatchObject({ code: "PERMISSION" });
    expect(calls).toHaveLength(2);
    mockFetch([["POST", "https://open.tiktokapis.com/v2/video/query/", () => ok({ data: {}, error: { code: "scope_not_authorized", message: "" } }, 401)]]);
    await expect(socialPlatforms.tiktok.stats!({} as any, tokens(), ids.slice(0, 1))).rejects.toMatchObject({ code: "PERMISSION" });
  });

  it("reads Instagram likes and comments, and views and shares with the insights permission", async () => {
    const calls = mockFetch([
      ["GET", "https://graph.instagram.com/v23.0/111/insights", () => ok({ data: [{ name: "views", values: [{ value: 900 }] }, { name: "shares", values: [{ value: 4 }] }] })],
      ["GET", "https://graph.instagram.com/v23.0/222/insights", () => ok({ error: { message: "(#10) Application does not have permission for this action", type: "OAuthException", code: 10 } }, 400)],
      ["GET", "https://graph.instagram.com/v23.0/333", () => ok({ error: { message: "Unsupported get request.", type: "GraphMethodException", code: 100, error_subcode: 33 } }, 400)],
      ["GET", "https://graph.instagram.com/v23.0/", (c) => ok({ like_count: Number(c.url.pathname.split("/")[2]) / 111, comments_count: 1, id: c.url.pathname.split("/")[2] })],
    ]);
    const found = await socialPlatforms.instagram.stats!({} as any, tokens(), ["111", "222", "333", "not-a-media-id"]);
    expect(Object.fromEntries(found)).toEqual({
      "111": { views: 900, likes: 1, comments: 1, shares: 4, saves: null },
      // An older connection without insights: likes and comments still count; reconnect for the rest.
      "222": { views: null, likes: 2, comments: 1, shares: null, limited: true },
    });
    expect(calls.find((c) => c.url.pathname === "/v23.0/111")!.url.searchParams.get("fields")).toBe("like_count,comments_count");
    expect(calls.find((c) => c.url.pathname === "/v23.0/111/insights")!.url.searchParams.get("metric")).toBe("views,shares,saved");
    // A connection known to lack the insights permission isn't asked for insights at all.
    const before = calls.length;
    const limited = await socialPlatforms.instagram.stats!({} as any, tokens({ scope: "instagram_business_basic,instagram_business_content_publish" }), ["111"]);
    expect(limited.get("111")).toEqual({ views: null, likes: 1, comments: 1, shares: null, limited: true });
    expect(calls.length - before).toBe(1);
  });
});

describe("refreshing stats from the cron", () => {
  it("picks published posts by age: soon after publishing, every 3 hours for 2 days, then daily, for 30 days", async () => {
    const s = await setup();
    const yt = await addAccount(s, "youtube"), li = await addAccount(s, "linkedin");
    // One post each: a post goes out once per account.
    const make = (o: PubOptions, platform = "youtube", account: string | null = yt) => addPublication(s, addPost(s), account, platform, o);
    make({ publishedAgo: FIRST_READ - 60 }); // too new
    const neverRead = make({ publishedAgo: 2 * HOUR });
    make({ publishedAgo: DAY, checkedAgo: HOUR }); // fresh, read an hour ago
    const freshDue = make({ publishedAgo: DAY, checkedAgo: 4 * HOUR });
    make({ publishedAgo: 5 * DAY, checkedAgo: 5 * HOUR }); // older, read today
    const dailyDue = make({ publishedAgo: 5 * DAY, checkedAgo: 25 * HOUR });
    make({ publishedAgo: 31 * DAY }); // too old
    make({ publishedAgo: 2 * HOUR }, "linkedin", li); // no stats from LinkedIn
    make({ publishedAgo: 2 * HOUR, status: "failed" });
    make({ publishedAgo: 2 * HOUR, externalId: null });
    make({ publishedAgo: 2 * HOUR }, "youtube", null); // disconnected account
    expect((await dueForStats(s.env, 50)).map((r) => r.id)).toEqual([neverRead, dailyDue, freshDue]);
    expect((await dueForStats(s.env, 2)).map((r) => r.id)).toEqual([neverRead, dailyDue]);
  });

  it("reads each network's stats once per interval and saves them", async () => {
    const s = await setup();
    const yt = await addAccount(s, "youtube"), tt = await addAccount(s, "tiktok"), ig = await addAccount(s, "instagram");
    const p = addPost(s);
    const a = addPublication(s, p, yt, "youtube", { externalId: "dQw4w9WgXcQ" });
    const b = addPublication(s, addPost(s), yt, "youtube", { externalId: "gone0000000" });
    const c = addPublication(s, p, tt, "tiktok", { externalId: "7212345678901234567" });
    const d = addPublication(s, p, ig, "instagram", { externalId: "17900000000000001" });
    const calls = mockFetch([
      ["GET", "https://www.googleapis.com/youtube/v3/videos", () => ok({ items: [{ id: "dQw4w9WgXcQ", statistics: { viewCount: "1500", likeCount: "40", commentCount: "3" } }] })],
      ["POST", "https://open.tiktokapis.com/v2/video/query/", () => new Response(`{"data":{"videos":[{"id":7212345678901234567,"view_count":8000,"like_count":600,"comment_count":25,"share_count":30}]},"error":{"code":"ok"}}`)],
      ["GET", "https://graph.instagram.com/v23.0/17900000000000001/insights", () => ok({ data: [{ name: "views", values: [{ value: 2200 }] }, { name: "shares", values: [{ value: 9 }] }] })],
      ["GET", "https://graph.instagram.com/v23.0/17900000000000001", () => ok({ like_count: 120, comments_count: 8, id: "17900000000000001" })],
    ]);
    expect(await refreshMetrics(s.env)).toEqual({ accounts: 3, read: 3 });
    expect(pub(s, a)).toMatchObject({ views: 1500, likes: 40, comments: 3, shares: null, metrics_error: null });
    expect(pub(s, a).metrics_at).toBeGreaterThan(now() - 5);
    expect(pub(s, b)).toMatchObject({ views: null, metrics_at: null, metrics_error: "not_found" });
    expect(pub(s, b).metrics_checked_at).toBeGreaterThan(now() - 5);
    expect(pub(s, c)).toMatchObject({ views: 8000, likes: 600, comments: 25, shares: 30 });
    expect(pub(s, d)).toMatchObject({ views: 2200, likes: 120, comments: 8, shares: 9 });
    // One videos.list call for both YouTube posts; nothing is due again until the next interval.
    expect(calls.filter((x) => x.url.hostname === "www.googleapis.com")).toHaveLength(1);
    const before = calls.length;
    expect(await refreshMetrics(s.env)).toEqual({ accounts: 0, read: 0 });
    expect(calls.length).toBe(before);
    // A number missing from the next answer keeps its last value.
    s.sqlite.prepare("UPDATE publications SET metrics_checked_at=? WHERE id=?").run(now() - 4 * HOUR, a);
    mockFetch([["GET", "https://www.googleapis.com/youtube/v3/videos", () => ok({ items: [{ id: "dQw4w9WgXcQ", statistics: { viewCount: "1600" } }] })]]);
    await refreshMetrics(s.env);
    expect(pub(s, a)).toMatchObject({ views: 1600, likes: 40, comments: 3 });
  });

  it("stays within its batch, and one account's failure doesn't stop the others", async () => {
    const s = await setup();
    const p = addPost(s);
    const accounts = [await addAccount(s, "youtube"), await addAccount(s, "youtube"), await addAccount(s, "youtube")];
    // Oldest check first: the third account's post waits for the next run.
    const pubs = accounts.map((acc, i) => addPublication(s, p, acc, "youtube", { externalId: `video0000${i}0`, publishedAgo: 3 * DAY, checkedAgo: (30 - i) * HOUR }));
    mockFetch([["GET", "https://www.googleapis.com/youtube/v3/videos", (c) => c.headers.get("Authorization") === "Bearer youtube-access"
      && c.url.searchParams.get("id") === "video000000" ? ok({ error: { code: 500, errors: [{ reason: "backendError" }] } }, 500)
      : ok({ items: [{ id: c.url.searchParams.get("id"), statistics: { viewCount: "7" } }] })]]);
    expect(await refreshMetrics(s.env, { accounts: 2 })).toEqual({ accounts: 2, read: 1 });
    expect(pub(s, pubs[0])).toMatchObject({ views: null, metrics_error: "failed" });
    expect(pub(s, pubs[0]).metrics_checked_at).toBeGreaterThan(now() - 5);
    expect(pub(s, pubs[1])).toMatchObject({ views: 7, metrics_error: null });
    expect(pub(s, pubs[2]).metrics_checked_at).toBe(now() - 28 * HOUR);
    expect(await refreshMetrics(s.env, { accounts: 2 })).toEqual({ accounts: 1, read: 1 });
    expect(pub(s, pubs[2]).views).toBe(7);
  });

  it("marks an account expired when its token can't be renewed, and asks to reconnect for a missing scope", async () => {
    const s = await setup();
    const p = addPost(s);
    const expiring = await addAccount(s, "tiktok", { tokens: { expiresAt: now() + 60 } });
    const old = await addAccount(s, "tiktok", { tokens: { scope: "user.info.basic,video.publish" } });
    const gone = await addAccount(s, "youtube", { status: "expired" });
    const x = addPublication(s, p, expiring, "tiktok", { externalId: "7212345678901234567" });
    const y = addPublication(s, p, old, "tiktok", { externalId: "7212345678901234568" });
    const z = addPublication(s, p, gone, "youtube", { externalId: "dQw4w9WgXcQ" });
    const calls = mockFetch([["POST", "https://open.tiktokapis.com/v2/oauth/token/", () => ok({ error: "invalid_grant", error_description: "Refresh token is invalid" }, 400)]]);
    await refreshMetrics(s.env);
    expect(pub(s, x).metrics_error).toBe("reconnect");
    expect((s.sqlite.prepare("SELECT status FROM social_accounts WHERE id=?").get(expiring) as any).status).toBe("expired");
    expect(pub(s, y).metrics_error).toBe("scope");
    expect(pub(s, z).metrics_error).toBe("reconnect");
    // Only the token renewal was attempted: no stats call without the scope or a working account.
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/oauth/token/"]);
  });

  it("reads a reconnected account's posts again on the next pass", async () => {
    const s = await setup();
    // Connected before video.list was asked for: its posts ask to reconnect.
    const account = await addAccount(s, "tiktok", { tokens: { scope: "user.info.basic,video.publish" } });
    s.sqlite.prepare("UPDATE social_accounts SET external_id='open-1' WHERE id=?").run(account);
    const x = addPublication(s, addPost(s), account, "tiktok", { externalId: "7212345678901234567", checkedAgo: HOUR, metrics: { metrics_error: "scope" } });
    const old = addPublication(s, addPost(s), account, "tiktok", { publishedAgo: 40 * DAY, checkedAgo: HOUR, metrics: { metrics_error: "scope" } });
    const r = await call(worker, s.env, "POST", "/api/accounts/connect", { workspaceId: s.workspace, platform: "tiktok" }, s.user.cookie);
    const state = new URL(r.data.url).searchParams.get("state");
    mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/oauth/token/", () => ok({ access_token: "tt-access", expires_in: 86400, open_id: "open-1", refresh_token: "tt-refresh", refresh_expires_in: 31536000, scope: "user.info.basic,video.publish,video.list" })],
      ["GET", "https://open.tiktokapis.com/v2/user/info/", () => ok({ data: { user: { open_id: "open-1", display_name: "Brand Co" } }, error: { code: "ok" } })],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", () => ok({ data: { creator_username: "brandco", privacy_level_options: ["PUBLIC_TO_EVERYONE"] }, error: { code: "ok" } })],
    ]);
    const back = await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=auth-code&state=${state}`, undefined, s.user.cookie);
    expect(back.headers.get("Location")).toBe(`/app/accounts?workspace=${s.workspace}&connected=tiktok`);
    expect(pub(s, x)).toMatchObject({ metrics_error: null, metrics_checked_at: null });
    expect(pub(s, old).metrics_error).toBe("scope");
    expect((await dueForStats(s.env, 10)).map((d) => d.id)).toEqual([x]);
  });

  it("runs from the cron every five minutes", async () => {
    const s = await setup();
    const p = addPublication(s, addPost(s), await addAccount(s, "youtube"), "youtube", { externalId: "dQw4w9WgXcQ" });
    mockFetch([["GET", "https://www.googleapis.com/youtube/v3/videos", () => ok({ items: [{ id: "dQw4w9WgXcQ", statistics: { viewCount: "42" } }] })]]);
    await maintenance(s.env, Date.UTC(2026, 9, 8, 12, 3));
    expect(pub(s, p).views).toBeNull();
    await maintenance(s.env, Date.UTC(2026, 9, 8, 12, 7));
    expect(pub(s, p).views).toBe(42);
  });
});

describe("tracked links", () => {
  it("redirect to the workspace's site with UTM tags and count real clicks only", async () => {
    const s = await setup();
    await enableLinks(s, "https://brand.co/launch?ref=bio#top");
    const post = addPost(s);
    const code = await trackedLink(s.env, s.workspace, "youtube", post);
    expect(code).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(await trackedLink(s.env, s.workspace, "youtube", post)).toBe(code);

    const r = await click(s, code);
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get("Location")!);
    // The target is stored without its #fragment.
    expect(to.origin + to.pathname + to.hash).toBe("https://brand.co/launch");
    expect(Object.fromEntries(to.searchParams)).toEqual({
      ref: "bio", utm_source: "youtube", utm_medium: "social", utm_campaign: "hookstreak", utm_content: post, hs: code,
    });
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(clicksOf(s, code)).toBe(1);
    // The same visitor again within minutes counts once; someone else counts.
    await click(s, code);
    expect(clicksOf(s, code)).toBe(1);
    await click(s, code, "198.51.100.8");
    expect(clicksOf(s, code)).toBe(2);
    // Link previews, prefetches, HEAD requests and scripts are followed but not counted.
    for (const headers of <Record<string, string>[]>[
      { "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" },
      { "User-Agent": "Mozilla/5.0 (compatible; LinkedInBot/1.0)" },
      { "User-Agent": "curl/8.5.0" },
      { "User-Agent": "" },
      { "Sec-Purpose": "prefetch" },
      { Purpose: "prefetch" },
    ]) {
      const x = await click(s, code, `192.0.2.${Math.floor(Math.random() * 200) + 1}`, headers);
      expect(x.status).toBe(302);
    }
    const head = await raw(s.env, "HEAD", `/go/${code}`, { headers: { "User-Agent": CHROME, "CF-Connecting-IP": "192.0.2.250" } });
    expect(head.status).toBe(302);
    expect(clicksOf(s, code)).toBe(2);
    // One address counts at most 120 clicks an hour.
    for (let i = 0; i < 120; i++) await hit(s.env, "go-ip", HOUR, "198.51.100.99");
    await click(s, code, "198.51.100.99");
    expect(clicksOf(s, code)).toBe(2);
    // A bio link names no post.
    const bio = await trackedLink(s.env, s.workspace, "tiktok");
    expect(new URL((await click(s, bio)).headers.get("Location")!).searchParams.get("utm_content")).toBe("bio");
  });

  it("only ever lead to the workspace's own checked address", async () => {
    const s = await setup("https://brand.co/");
    const code = await trackedLink(s.env, s.workspace, "tiktok");
    // Without a target the website is used; nothing in the request can change where it goes.
    let r = await click(s, `${code}?url=https://evil.example/&to=//evil.example`);
    expect(new URL(r.headers.get("Location")!).origin).toBe("https://brand.co");
    for (const targetUrl of ["javascript:alert(1)", "ftp://brand.co/", "https://127.0.0.1/x", "http://localhost:8787/", "https://user:pw@brand.co/", "https://app.test/go/abc", "https://www.app.test/", "data:text/html,hi"]) {
      const x = await call(worker, s.env, "PATCH", `/api/workspaces/${s.workspace}/analytics/setup`, { targetUrl }, s.user.cookie);
      expect(x.status, targetUrl).toBe(400);
      expect(x.data.error).toBe("Enter the address of your own website, like https://yourbrand.com.");
    }
    const saved = await call(worker, s.env, "PATCH", `/api/workspaces/${s.workspace}/analytics/setup`, { targetUrl: "shop.brand.co/spring" }, s.user.cookie);
    expect(saved.data).toMatchObject({ targetUrl: "https://shop.brand.co/spring", target: "https://shop.brand.co/spring" });
    // A stored value that isn't a public web page (changed outside the app) is never followed.
    s.sqlite.prepare("UPDATE analytics_sites SET target_url='javascript:alert(1)' WHERE workspace_id=?").run(s.workspace);
    r = await click(s, code);
    expect(r.headers.get("Location")).toMatch(/^https:\/\/brand\.co\/\?/);
    s.sqlite.prepare("UPDATE workspaces SET website='http://10.0.0.1/' WHERE id=?").run(s.workspace);
    r = await click(s, code);
    expect(r.status).toBe(404);
    expect(r.headers.get("Location")).toBeNull();
    expect((await click(s, "nothere1")).status).toBe(404);
    expect((await click(s, "a".repeat(30))).status).toBe(404);
  });

  it("need a website before captions get them", async () => {
    const s = await setup(null);
    const r = await call(worker, s.env, "PATCH", `/api/workspaces/${s.workspace}/analytics/setup`, { linksEnabled: true }, s.user.cookie);
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("Add your website address first, so tracked links have somewhere to go.");
    const other = signedIn(s.sqlite);
    expect((await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics/setup`, undefined, other.cookie)).status).toBe(404);
  });
});

describe("tracked links in captions", () => {
  const row = (caption: string): PostRow => ({
    id: "p", user_id: "u", workspace_id: "w", format: "text", spec: JSON.stringify({ caption, hashtags: ["#kitchen", "#launch"] }), hook: "", caption,
    title: "", status: "approved", render_status: "ready", video_asset: null, cover_asset: null, slides: "[]", duration: 10,
  });
  it("go between the caption and the hashtags, whole", () => {
    const link = "https://app.test/go/AbCd2345";
    expect(postText(row("Meet the blender."), "youtube", link)).toMatchObject({
      text: `Meet the blender.\n\n${link}\n\n#kitchen #launch`, caption: "Meet the blender.", link,
    });
    // Without a link nothing changes.
    expect(postText(row("Meet the blender."), "youtube").text).toBe("Meet the blender.\n\n#kitchen #launch");
    expect(postText(row("Meet the blender."), "youtube")).not.toHaveProperty("link");
    const long = postText(row("x".repeat(6000)), "youtube", link).text;
    expect(long.length).toBe(5000);
    expect(long.endsWith(`\n\n${link}\n\n#kitchen #launch`)).toBe(true);
    expect(commentary("Our new (quiet) blender", ["#kitchen"], link))
      .toBe(`Our new \\(quiet\\) blender\n\n${link}\n\n{hashtag|\\#|kitchen}`);
    expect(commentary("y".repeat(4000), [], link).endsWith(`\n\n${link}`)).toBe(true);
  });

  it("are added for YouTube and LinkedIn only when the workspace turns them on", async () => {
    const s = await setup();
    const post = { id: addPost(s), workspace_id: s.workspace };
    expect(await captionLink(s.env, post, "youtube")).toBeNull();
    await enableLinks(s);
    const link = await captionLink(s.env, post, "youtube");
    expect(link).toMatch(new RegExp(`^${SITE}/go/[A-Za-z0-9]{8}$`));
    expect(await captionLink(s.env, post, "youtube")).toBe(link);
    expect(await captionLink(s.env, post, "linkedin")).toMatch(/\/go\//);
    expect(await captionLink(s.env, post, "tiktok")).toBeNull();
    expect(await captionLink(s.env, post, "instagram")).toBeNull();
  });

  it("go into the published YouTube description", async () => {
    const s = await setup();
    await enableLinks(s);
    const account = await addAccount(s, "youtube");
    const postId = addPost(s);
    const asset = crypto.randomUUID(), key = `media/${s.user.id}/${postId}/${asset}`;
    s.sqlite.prepare("INSERT INTO media_assets(id,user_id,workspace_id,post_id,kind,name,object_key,mime,bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(asset, s.user.id, s.workspace, postId, "render", "render", key, "video/mp4", 2048, now(), now());
    await s.env.MEDIA.put(key, new Uint8Array(2048));
    s.sqlite.prepare("UPDATE posts SET video_asset=? WHERE id=?").run(asset, postId);
    const pubId = addPublication(s, postId, account, "youtube", { status: "scheduled", externalId: null });
    s.sqlite.prepare("UPDATE publications SET scheduled_at=?,published_at=NULL WHERE id=?").run(now() - 5, pubId);
    const session = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=xyz";
    const calls = mockFetch([
      ["POST", "https://www.googleapis.com/upload/youtube/v3/videos", () => new Response(null, { status: 200, headers: { Location: session } })],
      ["PUT", session, () => ok({ id: "dQw4w9WgXcQ", status: { uploadStatus: "uploaded" } })],
    ]);
    await dispatchDue(s.env);
    const attempts = pub(s, pubId).attempts;
    const step = { do: async (_n: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
    await new Publication({} as any, s.env).run({ payload: { publicationId: pubId }, instanceId: `pub-${pubId}-${attempts}` } as any, step as any);
    expect(pub(s, pubId).status).toBe("published");
    const code = (s.sqlite.prepare("SELECT code FROM tracked_links WHERE post_id=? AND platform='youtube'").get(postId) as any).code;
    const meta = JSON.parse(calls[0].body);
    expect(meta.snippet.description).toBe(`Meet the new blender.\n\n${SITE}/go/${code}\n\n#kitchen #Shorts`);
  });
});

describe("sale reports", () => {
  async function clicked(s: Ctx, platform: "youtube" | "tiktok" = "youtube", postId = "") {
    const code = await trackedLink(s.env, s.workspace, platform, postId);
    await click(s, code);
    return code;
  }

  it("answer CORS preflights and work from any site without a session", async () => {
    const s = await setup();
    const key = await siteKey(s);
    const pre = await raw(s.env, "OPTIONS", `/api/t/${key}`, {
      headers: { Origin: "https://brand.co", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(pre.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(pre.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    expect(pre.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const r = await report(s, key, { type: "conversion", value: 5, currency: "usd" }, { "Content-Type": "application/json", Origin: "https://shop.other.co" });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ ok: true, attributed: false, duplicate: false });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    // Other API routes still refuse a foreign origin.
    expect((await raw(s.env, "POST", "/api/contact", { headers: { Origin: "https://brand.co" }, body: "{}" })).status).toBe(403);
  });

  it("credit the last tracked click within 30 days to its post and network, once per order", async () => {
    const s = await setup();
    const key = await siteKey(s);
    const post = addPost(s);
    const code = await clicked(s, "youtube", post);
    const r = await report(s, key, { type: "conversion", code, clickedAt: now() - HOUR, value: "49.90", currency: "eur", orderId: "A-1001" });
    expect(r.data).toEqual({ ok: true, attributed: true, duplicate: false });
    const rows = s.sqlite.prepare("SELECT * FROM conversions").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspace_id: s.workspace, code, post_id: post, platform: "youtube", amount: 4990, currency: "EUR" });
    // The order ID itself is never kept, only a hash to spot repeats.
    expect(rows[0].order_hash).toBe(sha256(`${s.workspace}:A-1001`));
    expect(JSON.stringify(rows[0])).not.toContain("A-1001");
    expect((await report(s, key, { type: "conversion", code, value: 49.9, currency: "EUR", orderId: "A-1001" })).data).toEqual({ ok: true, attributed: true, duplicate: true });
    // From the shop's server (no Origin, JSON, a numeric order ID).
    expect((await report(s, key, { code, value: 10, currency: "EUR", orderId: 1002 }, { Origin: "", "Content-Type": "application/json" })).data)
      .toMatchObject({ ok: true, attributed: true });
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM conversions").get()).toEqual({ n: 2 });
    // Not credited: a click over 30 days ago, a link nobody clicked, another workspace's link, an unknown code.
    const other = await setup();
    const theirs = await clicked(other, "youtube", addPost(other));
    const idle = await trackedLink(s.env, s.workspace, "tiktok");
    for (const body of [
      { code, clickedAt: now() - 31 * DAY }, { code: idle }, { code: theirs }, { code: "Zzzzzzz9" }, { code: "<script>" },
    ]) expect((await report(s, key, { type: "conversion", ...body })).data, JSON.stringify(body)).toEqual({ ok: true, attributed: false, duplicate: false });
    const credited = s.sqlite.prepare("SELECT COUNT(*) AS n FROM conversions WHERE code IS NOT NULL").get();
    expect(credited).toEqual({ n: 2 });
  });

  it("refuse bad values, unknown sites, oversized bodies and floods", async () => {
    const s = await setup();
    const key = await siteKey(s);
    const cases: [unknown, number, string?][] = [
      [{ value: -1, currency: "USD" }, 400, "value must be a number from 0 to 1000000."],
      [{ value: 2_000_000, currency: "USD" }, 400, "value must be a number from 0 to 1000000."],
      [{ value: "12abc", currency: "USD" }, 400],
      [{ value: 10 }, 400, "Send a currency (such as USD) with the value."],
      [{ value: 10, currency: "DOLLARS" }, 400, "currency must be a 3-letter code such as USD."],
      [{ type: "pageview" }, 400],
      [{ orderId: "x".repeat(101) }, 400],
      ["not json", 400, "Send the report as JSON."],
      [JSON.stringify({ orderId: "y".repeat(3000) }), 413],
    ];
    for (const [body, status, error] of cases) {
      const r = await report(s, key, body);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(status);
      expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
      if (error) expect(r.data.error).toBe(error);
    }
    expect((await report(s, "A".repeat(24), {})).status).toBe(404);
    expect((await report(s, "short", {})).status).toBe(404);
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM conversions").get()).toEqual({ n: 0 });
    // A sign-up without a value is a conversion too.
    expect((await report(s, key, { type: "conversion" })).status).toBe(200);
    for (let i = 0; i < 300; i++) await hit(s.env, "t-ip", HOUR, "203.0.113.50");
    const flooded = await report(s, key, { type: "conversion" }, { "CF-Connecting-IP": "203.0.113.50" });
    expect(flooded.status).toBe(429);
    expect(flooded.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("record the site script's test call without counting a sale", async () => {
    const s = await setup();
    const key = await siteKey(s);
    expect((await report(s, key, { type: "test" })).data).toEqual({ ok: true });
    const setup2 = await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics/setup`, undefined, s.user.cookie);
    expect(setup2.data.testedAt).toBeGreaterThan(now() - 5);
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM conversions").get()).toEqual({ n: 0 });
  });
});

describe("the site script", () => {
  it("is served to any site with a strict policy", async () => {
    const s = await setup();
    const r = await raw(s.env, "GET", "/t.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(r.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(r.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(r.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(r.data).toBe(SITE_SCRIPT);
    expect(SITE_SCRIPT.length).toBeLessThan(2500);
  });

  it("keeps the code from the landing URL for 30 days in the site's storage and reports sales, never touching cookies", async () => {
    const store = new Map<string, string>();
    const sent: { url: string; init: any }[] = [];
    const sandbox: any = {
      document: {
        currentScript: { src: `${SITE}/t.js`, getAttribute: (n: string) => (n === "data-site" ? "SiteKey000000000000000000" : null) },
        get cookie(): string { throw new Error("cookies are not used"); },
        set cookie(_v: string) { throw new Error("cookies are not used"); },
      },
      location: { search: "?utm_source=tiktok&hs=AbCd2345" },
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)) },
      URL, URLSearchParams, JSON, Date, Math, Promise,
      fetch: async (url: string, init: any) => { sent.push({ url, init }); return { ok: true }; },
    };
    sandbox.window = sandbox;
    // A call made before the script loaded waits in the queue of the snippet's stub.
    vm.runInNewContext("window.hookstreak=window.hookstreak||function(){(hookstreak.q=hookstreak.q||[]).push(arguments)}; hookstreak('conversion', { value: 20, currency: 'EUR', orderId: 'q-1' });", sandbox);
    vm.runInNewContext(SITE_SCRIPT, sandbox);
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(store.get("hookstreak")!)).toMatchObject({ c: "AbCd2345" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`${SITE}/api/t/SiteKey000000000000000000`);
    expect(sent[0].init).toMatchObject({ method: "POST", keepalive: true, credentials: "omit", headers: { "Content-Type": "text/plain" } });
    const body = JSON.parse(sent[0].init.body);
    expect(body).toMatchObject({ type: "conversion", code: "AbCd2345", value: 20, currency: "EUR", orderId: "q-1" });
    expect(body.clickedAt).toBeGreaterThan(now() - 5);
    expect(sandbox.hookstreak("code")).toBe("AbCd2345");
    expect(await sandbox.hookstreak("test")).toBe(true);
    expect(JSON.parse(sent[1].init.body)).toEqual({ type: "test" });
    // A later visit without a code keeps the stored one until it is 30 days old.
    sandbox.location.search = "";
    store.set("hookstreak", JSON.stringify({ c: "AbCd2345", t: Date.now() - 31 * DAY * 1000 }));
    vm.runInNewContext(SITE_SCRIPT, sandbox);
    expect(sandbox.hookstreak("code")).toBeNull();
    await sandbox.hookstreak("conversion", { value: 1, currency: "EUR" });
    expect(JSON.parse(sent[2].init.body)).toMatchObject({ code: null, clickedAt: null });
  });
});

describe("the analytics API", () => {
  async function scenario() {
    const s = await setup();
    const t = now();
    const yt = await addAccount(s, "youtube"), tt = await addAccount(s, "tiktok"), ig = await addAccount(s, "instagram");
    const li = await addAccount(s, "linkedin", { status: "expired" });
    const p1 = addPost(s, { hook: "Stop scrolling", cover: "cover-1" }), p2 = addPost(s, { hook: "Three reasons" }), p3 = addPost(s, { hook: "On LinkedIn" });
    const old = addPost(s, { hook: "Old" });
    addPublication(s, p1, yt, "youtube", { publishedAgo: 2 * DAY, url: "https://youtube.com/shorts/dQw4w9WgXcQ",
      metrics: { views: 1000, likes: 50, comments: 5, metrics_at: t - HOUR } });
    addPublication(s, p1, tt, "tiktok", { publishedAgo: 2 * DAY, url: "javascript:alert(1)",
      metrics: { views: 3000, likes: 200, comments: 20, shares: 10, metrics_at: t - 2 * HOUR } });
    addPublication(s, p2, ig, "instagram", { publishedAgo: 10 * DAY, metrics: { likes: 30, comments: 3, metrics_at: t - 3 * HOUR, metrics_error: "scope" } });
    addPublication(s, p3, li, "linkedin", { publishedAgo: DAY });
    addPublication(s, old, yt, "youtube", { publishedAgo: 40 * DAY, metrics: { views: 99999, metrics_at: t - HOUR } });
    addPublication(s, p1, yt, "youtube", { status: "failed", metrics: { views: 5 } });
    const other = await setup();
    addPublication(other, addPost(other), await addAccount(other, "youtube"), "youtube", { metrics: { views: 777, metrics_at: t } });

    const link = await trackedLink(s.env, s.workspace, "youtube", p1), bio = await trackedLink(s.env, s.workspace, "tiktok");
    const clicks = (code: string, dayAgo: number, n: number) => s.sqlite.prepare("INSERT INTO link_clicks(code,day,clicks) VALUES (?,?,?)").run(code, today() - dayAgo, n);
    clicks(link, 0, 5); clicks(link, 3, 2); clicks(bio, 10, 7); clicks(link, 40, 100);
    const sale = (o: { code?: string | null; post?: string | null; platform?: string | null; amount: number; currency: string | null; ago: number }) =>
      s.sqlite.prepare("INSERT INTO conversions(id,workspace_id,code,post_id,platform,amount,currency,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), s.workspace, o.code ?? null, o.post ?? null, o.platform ?? null, o.amount, o.currency, t - o.ago);
    sale({ code: link, post: p1, platform: "youtube", amount: 4990, currency: "USD", ago: 60 });
    sale({ code: link, post: p1, platform: "youtube", amount: 2000, currency: "EUR", ago: DAY });
    sale({ code: bio, platform: "tiktok", amount: 1000, currency: "USD", ago: 9 * DAY });
    sale({ amount: 500, currency: "USD", ago: 120 });
    sale({ code: link, post: p1, platform: "youtube", amount: 100000, currency: "USD", ago: 40 * DAY });
    return { s, p1, p2, p3, t };
  }

  it("adds up the last 30 days: network stats, clicks and sales per currency", async () => {
    const { s, p1, p2, p3, t } = await scenario();
    const r = await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics?days=30`, undefined, s.user.cookie);
    expect(r.status).toBe(200);
    const a = r.data;
    expect(a.days).toBe(30);
    expect(a.totals).toEqual({
      posts: 4, withStats: 3, views: 4000, likes: 280, comments: 28, shares: 10, saves: null, clicks: 14, conversions: 4,
      revenue: [{ currency: "USD", amount: 64.9 }, { currency: "EUR", amount: 20 }],
    });
    expect(a.lastUpdated).toBe(t - HOUR);
    expect(a.unattributed).toEqual({ conversions: 1, revenue: [{ currency: "USD", amount: 5 }] });
    const net = Object.fromEntries(a.networks.map((n: any) => [n.platform, n]));
    expect(Object.keys(net)).toEqual(["tiktok", "instagram", "youtube", "linkedin"]);
    expect(net.youtube).toMatchObject({ posts: 1, withStats: 1, views: 1000, clicks: 7, conversions: 2, revenue: [{ currency: "USD", amount: 49.9 }, { currency: "EUR", amount: 20 }], statsAvailable: true, notes: [] });
    expect(net.tiktok).toMatchObject({ views: 3000, shares: 10, clicks: 7, conversions: 1, revenue: [{ currency: "USD", amount: 10 }] });
    expect(net.instagram).toMatchObject({ views: null, likes: 30, notes: [{ tone: "warn", text: "Reconnect Instagram to allow views, shares and saves.", action: "reconnect" }] });
    expect(net.linkedin).toMatchObject({ posts: 1, withStats: 0, views: null, statsAvailable: false });
    expect(net.linkedin.notes.map((n: any) => n.text)).toEqual([
      "LinkedIn doesn't share post stats with apps like this one, so only clicks and sales show here.",
      "Reconnect your LinkedIn account to keep its stats up to date.",
    ]);
    expect(a.daily).toHaveLength(30);
    expect(a.daily.at(-1)).toEqual({ day: new Date(today() * DAY * 1000).toISOString().slice(0, 10), clicks: 5, conversions: 2 });
    expect(a.daily.reduce((n: number, d: any) => n + d.clicks, 0)).toBe(14);
    expect(a.top.map((x: any) => [x.postId, x.platform])).toEqual([[p1, "tiktok"], [p1, "youtube"], [p2, "instagram"], [p3, "linkedin"]]);
    expect(a.top[1]).toMatchObject({ hook: "Stop scrolling", thumbAssetId: "cover-1", views: 1000, clicks: 7, conversions: 2, url: "https://youtube.com/shorts/dQw4w9WgXcQ", deleted: false });
    // Only https links are passed on.
    expect(a.top[0].url).toBeNull();
  });

  it("narrows to 7 days, and keeps numbers nobody reported empty", async () => {
    const { s } = await scenario();
    const a = (await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics?days=7`, undefined, s.user.cookie)).data;
    expect(a.totals).toMatchObject({ posts: 3, views: 4000, likes: 250, comments: 25, shares: 10, clicks: 7, conversions: 3,
      revenue: [{ currency: "USD", amount: 54.9 }, { currency: "EUR", amount: 20 }] });
    expect(a.daily).toHaveLength(7);
    const empty = await setup();
    const e = (await call(worker, empty.env, "GET", `/api/workspaces/${empty.workspace}/analytics`, undefined, empty.user.cookie)).data;
    expect(e.totals).toEqual({ posts: 0, withStats: 0, views: null, likes: null, comments: null, shares: null, saves: null, clicks: 0, conversions: 0, revenue: [] });
    expect(e).toMatchObject({ networks: [], top: [], lastUpdated: null });
    expect((await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics`, undefined, signedIn(s.sqlite).cookie)).status).toBe(404);
    expect((await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics`)).status).toBe(401);
  });

  it("notes posts waiting for their first stats and TikTok's private posts", async () => {
    const s = await setup();
    const tt = await addAccount(s, "tiktok");
    addPublication(s, addPost(s), tt, "tiktok", { publishedAgo: 10 * MINUTE });
    addPublication(s, addPost(s), tt, "tiktok", { publishedAgo: 3 * DAY, metrics: { metrics_error: "not_found" } });
    const a = (await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics`, undefined, s.user.cookie)).data;
    expect(a.networks[0].notes.map((n: any) => n.text)).toEqual(["TikTok shares stats for public posts only.", "New posts get their first stats within a few hours."]);
  });

  it("lists views and clicks per post for the content cards and calendar", async () => {
    const { s, p1, p2, p3 } = await scenario();
    const r = await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics/posts`, undefined, s.user.cookie);
    expect(r.data.posts[p1]).toEqual({ views: 4000, clicks: 107 });
    expect(r.data.posts[p2]).toEqual({ views: null, clicks: 0 });
    expect(r.data.posts[p3]).toEqual({ views: null, clicks: 0 });
    const cal = await call(worker, s.env, "GET", `/api/posts/${p1}/publications`, undefined, s.user.cookie);
    expect(cal.data.publications.find((x: any) => x.platform === "tiktok" && x.status === "published")).toMatchObject({ views: 3000, likes: 200, comments: 20, shares: 10 });
  });

  it("sets up the site key, snippet and link-in-bio URLs once", async () => {
    const s = await setup();
    const first = (await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics/setup`, undefined, s.user.cookie)).data;
    expect(first.siteKey).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(first).toMatchObject({ linksEnabled: false, targetUrl: null, website: "https://brand.co/", target: "https://brand.co/", testedAt: null,
      scriptUrl: `${SITE}/t.js`, endpoint: `${SITE}/api/t/${first.siteKey}` });
    expect(first.snippet).toContain(`<script async src="${SITE}/t.js" data-site="${first.siteKey}"></script>`);
    expect(first.bioLinks.map((b: any) => b.platform)).toEqual(["tiktok", "instagram"]);
    expect(first.bioLinks[0].url).toMatch(new RegExp(`^${SITE}/go/[A-Za-z0-9]{8}$`));
    await click(s, first.bioLinks[0].url.split("/go/")[1]);
    const again = (await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/analytics/setup`, undefined, s.user.cookie)).data;
    expect(again.siteKey).toBe(first.siteKey);
    expect(again.bioLinks.map((b: any) => [b.url, b.clicks])).toEqual([[first.bioLinks[0].url, 1], [first.bioLinks[1].url, 0]]);
    const off = await call(worker, s.env, "PATCH", `/api/workspaces/${s.workspace}/analytics/setup`, { linksEnabled: true, targetUrl: null }, s.user.cookie);
    expect(off.data).toMatchObject({ linksEnabled: true, targetUrl: null, target: "https://brand.co/" });
    // Session routes keep the same-origin check.
    expect((await raw(s.env, "PATCH", `/api/workspaces/${s.workspace}/analytics/setup`, { headers: { Cookie: s.user.cookie, Origin: "https://brand.co" }, body: "{}" })).status).toBe(403);
  });
});
