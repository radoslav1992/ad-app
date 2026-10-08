import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import worker from "../server/index";
import { open, seal } from "../server/crypto";
import { tiktokChunks } from "../server/social/tiktok";
import { commentary } from "../server/social/linkedin";
import { SITE, call, signedIn, subscribe, testEnv } from "./helpers";

const KEYS = {
  TIKTOK_CLIENT_KEY: "tt-key",
  TIKTOK_CLIENT_SECRET: "tt-secret",
  INSTAGRAM_APP_ID: "ig-app",
  INSTAGRAM_APP_SECRET: "ig-secret",
  GOOGLE_CLIENT_ID: "g-client",
  GOOGLE_CLIENT_SECRET: "g-secret",
  LINKEDIN_CLIENT_ID: "li-client",
  LINKEDIN_CLIENT_SECRET: "li-secret",
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Call = { method: string; url: URL; headers: Headers; body: any; redirect?: string };
type Route = [method: string, prefix: string, reply: (c: Call) => Response | Promise<Response>];
/** Replaces fetch with fixed provider answers; records every call (and fails on an unexpected one). */
function mockFetch(routes: Route[]) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const c: Call = { method: (init.method || "GET").toUpperCase(), url: new URL(String(input)), headers: new Headers(init.headers), body: init.body, redirect: init.redirect };
    calls.push(c);
    const route = routes.find(([m, prefix]) => m === c.method && c.url.href.startsWith(prefix));
    if (!route) throw new Error(`Unexpected request ${c.method} ${c.url.href}`);
    return route[2](c);
  });
  return calls;
}
const ok = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
afterEach(() => vi.unstubAllGlobals());

function setup(overrides: Record<string, unknown> = {}, plan: "starter" | "growth" | "pro" | null = "starter") {
  const { env, sqlite } = testEnv({ ...KEYS, ...overrides });
  const user = signedIn(sqlite);
  if (plan) subscribe(sqlite, user.id, plan);
  const workspace = crypto.randomUUID();
  const t = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(workspace, user.id, "Brand", t, t);
  return { env, sqlite, user, workspace };
}
async function connect(s: ReturnType<typeof setup>, platform: string, cookie = s.user.cookie) {
  const r = await call(worker, s.env, "POST", "/api/accounts/connect", { workspaceId: s.workspace, platform }, cookie);
  expect(r.status).toBe(200);
  return new URL(r.data.url);
}
const tiktokRoutes = (openId = "open-1"): Route[] => [
  ["POST", "https://open.tiktokapis.com/v2/oauth/token/", () =>
    ok({ access_token: "tt-access", expires_in: 86400, open_id: openId, refresh_token: "tt-refresh", refresh_expires_in: 31536000, scope: "user.info.basic,video.publish", token_type: "Bearer" })],
  ["GET", "https://open.tiktokapis.com/v2/user/info/", () =>
    ok({ data: { user: { open_id: openId, display_name: "Brand Co", avatar_url: "https://p16.tiktokcdn.com/a.jpg" } }, error: { code: "ok", message: "" } })],
  ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", () =>
    ok({ data: { creator_username: "brandco", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] }, error: { code: "ok" } })],
];

describe("token encryption", () => {
  it("round-trips JSON and refuses changed or foreign values", async () => {
    const { env } = testEnv();
    const sealed = await seal(env, { accessToken: "secret-token", n: 1 });
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain("secret-token");
    expect(await open(env, sealed)).toEqual({ accessToken: "secret-token", n: 1 });
    // A fresh IV each time.
    expect(await seal(env, { a: 1 })).not.toBe(await seal(env, { a: 1 }));
    const [v, iv, data] = sealed.split(".");
    const flipped = data.slice(0, -2) + (data.at(-2) === "A" ? "B" : "A") + data.at(-1);
    await expect(open(env, [v, iv, flipped].join("."))).rejects.toThrow();
    const other = testEnv().env;
    await expect(open(other, sealed)).rejects.toThrow();
  });
  it("explains a missing or invalid key as not set up", async () => {
    for (const key of [undefined, "short", btoa("x".repeat(31))]) {
      const { env } = testEnv({ TOKEN_ENCRYPTION_KEY: key });
      await expect(seal(env, {})).rejects.toMatchObject({ status: 503, message: "Social publishing is not set up yet." });
    }
  });
});

describe("connecting accounts", () => {
  it("needs a paid plan", async () => {
    const s = setup({}, null);
    const r = await call(worker, s.env, "POST", "/api/accounts/connect", { workspaceId: s.workspace, platform: "tiktok" }, s.user.cookie);
    expect(r.status).toBe(402);
    expect(r.data.error).toBe("Connecting social accounts needs a paid plan.");
  });

  it("is unavailable when the network or the encryption key is not set up", async () => {
    const s = setup({ TIKTOK_CLIENT_KEY: undefined });
    const r = await call(worker, s.env, "POST", "/api/accounts/connect", { workspaceId: s.workspace, platform: "tiktok" }, s.user.cookie);
    expect(r.status).toBe(503);
    const s2 = setup({ TOKEN_ENCRYPTION_KEY: "" });
    const r2 = await call(worker, s2.env, "POST", "/api/accounts/connect", { workspaceId: s2.workspace, platform: "youtube" }, s2.user.cookie);
    expect(r2.status).toBe(503);
    expect(r2.data.error).toBe("Social publishing is not set up yet.");
  });

  it("refuses another user's workspace", async () => {
    const s = setup();
    const other = signedIn(s.sqlite);
    subscribe(s.sqlite, other.id, "starter");
    const r = await call(worker, s.env, "POST", "/api/accounts/connect", { workspaceId: s.workspace, platform: "tiktok" }, other.cookie);
    expect(r.status).toBe(404);
  });

  it("builds TikTok's authorize URL with state, redirect and a hex PKCE challenge", async () => {
    const s = setup();
    const url = await connect(s, "tiktok");
    expect(url.origin + url.pathname).toBe("https://www.tiktok.com/v2/auth/authorize/");
    const q = url.searchParams;
    expect(q.get("client_key")).toBe("tt-key");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe("user.info.basic,video.publish");
    expect(q.get("redirect_uri")).toBe(`${SITE}/api/accounts/callback/tiktok`);
    expect(q.get("code_challenge_method")).toBe("S256");
    const state = q.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const row: any = s.sqlite.prepare("SELECT * FROM oauth_states").get();
    expect(row.state_hash).toBe(sha256(state));
    expect(row.user_id).toBe(s.user.id);
    expect(row.workspace_id).toBe(s.workspace);
    expect(row.platform).toBe("tiktok");
    expect(row.expires_at).toBeGreaterThan(Date.now() / 1000 + 500);
    expect(q.get("code_challenge")).toBe(sha256(row.verifier));
  });

  it("builds Google's authorize URL for offline access with an S256 challenge", async () => {
    const s = setup();
    const url = await connect(s, "youtube");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("scope")).toBe("https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("redirect_uri")).toBe(`${SITE}/api/accounts/callback/youtube`);
    const row: any = s.sqlite.prepare("SELECT verifier FROM oauth_states").get();
    expect(q.get("code_challenge")).toBe(createHash("sha256").update(row.verifier).digest("base64url"));
  });

  it("builds Instagram's and LinkedIn's authorize URLs", async () => {
    const s = setup();
    const ig = await connect(s, "instagram");
    expect(ig.origin + ig.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(ig.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_content_publish");
    expect(ig.searchParams.get("client_id")).toBe("ig-app");
    const li = await connect(s, "linkedin");
    expect(li.origin + li.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(li.searchParams.get("scope")).toBe("openid profile w_member_social");
    expect(li.searchParams.get("redirect_uri")).toBe(`${SITE}/api/accounts/callback/linkedin`);
  });

  it("connects a TikTok account from the callback, once per state", async () => {
    const s = setup();
    const state = (await connect(s, "tiktok")).searchParams.get("state")!;
    const verifier = (s.sqlite.prepare("SELECT verifier FROM oauth_states").get() as any).verifier;
    const calls = mockFetch(tiktokRoutes());
    const r = await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=auth-code&state=${state}`, undefined, s.user.cookie);
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(`/app/accounts?workspace=${s.workspace}&connected=tiktok`);
    const exchange = calls.find((c) => c.url.pathname === "/v2/oauth/token/")!;
    expect(exchange.body.get("code")).toBe("auth-code");
    expect(exchange.body.get("code_verifier")).toBe(verifier);
    expect(exchange.body.get("redirect_uri")).toBe(`${SITE}/api/accounts/callback/tiktok`);
    expect(exchange.body.get("grant_type")).toBe("authorization_code");
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
    const account: any = s.sqlite.prepare("SELECT * FROM social_accounts").get();
    expect(account).toMatchObject({ platform: "tiktok", external_id: "open-1", name: "Brand Co", handle: "brandco", status: "active", workspace_id: s.workspace });
    expect(account.credentials).not.toContain("tt-access");
    expect(await open(s.env, account.credentials)).toMatchObject({ accessToken: "tt-access", refreshToken: "tt-refresh" });
    expect(account.expires_at).toBeGreaterThan(Date.now() / 1000 + 300 * 86400);
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM oauth_states").get()).toMatchObject({ n: 0 });

    // The same state again is refused.
    const again = await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=auth-code&state=${state}`, undefined, s.user.cookie);
    expect(again.headers.get("Location")).toBe("/app/accounts?error=expired");
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM social_accounts").get()).toMatchObject({ n: 1 });
  });

  it("refuses expired states, other users' states and states of another network", async () => {
    const s = setup();
    mockFetch(tiktokRoutes());
    const expired = (await connect(s, "tiktok")).searchParams.get("state")!;
    s.sqlite.prepare("UPDATE oauth_states SET expires_at=?").run(Math.floor(Date.now() / 1000) - 1);
    const r1 = await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=c&state=${expired}`, undefined, s.user.cookie);
    expect(r1.headers.get("Location")).toBe(`/app/accounts?workspace=${s.workspace}&error=expired`);

    const theirs = (await connect(s, "tiktok")).searchParams.get("state")!;
    const intruder = signedIn(s.sqlite);
    const r2 = await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=c&state=${theirs}`, undefined, intruder.cookie);
    expect(r2.headers.get("Location")).toBe("/app/accounts?error=expired");

    const forYoutube = (await connect(s, "youtube")).searchParams.get("state")!;
    const r3 = await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=c&state=${forYoutube}`, undefined, s.user.cookie);
    expect(r3.headers.get("Location")).toContain("error=expired");

    const r4 = await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=c&state=${"0".repeat(64)}`, undefined, s.user.cookie);
    expect(r4.headers.get("Location")).toBe("/app/accounts?error=expired");
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM social_accounts").get()).toMatchObject({ n: 0 });
  });

  it("reports a declined consent without calling the network", async () => {
    const s = setup();
    const calls = mockFetch([]);
    const state = (await connect(s, "tiktok")).searchParams.get("state")!;
    const r = await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?error=access_denied&error_description=Nope&state=${state}`, undefined, s.user.cookie);
    expect(r.headers.get("Location")).toBe(`/app/accounts?workspace=${s.workspace}&error=denied`);
    expect(calls).toHaveLength(0);
  });

  it("reconnecting renews the same account", async () => {
    const s = setup();
    mockFetch(tiktokRoutes());
    for (let i = 0; i < 2; i++) {
      const state = (await connect(s, "tiktok")).searchParams.get("state")!;
      await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=c&state=${state}`, undefined, s.user.cookie);
      s.sqlite.prepare("UPDATE social_accounts SET status='expired'").run();
    }
    s.sqlite.prepare("UPDATE social_accounts SET status='expired'").run();
    const state = (await connect(s, "tiktok")).searchParams.get("state")!;
    await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=c&state=${state}`, undefined, s.user.cookie);
    const rows: any[] = s.sqlite.prepare("SELECT * FROM social_accounts").all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  it("keeps to the plan's account limit (Starter: 4)", async () => {
    const s = setup();
    const t = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 4; i++)
      s.sqlite.prepare("INSERT INTO social_accounts(id,user_id,workspace_id,platform,external_id,name,credentials,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), s.user.id, s.workspace, "linkedin", `member-${i}`, `Member ${i}`, "x", t, t);
    const r = await call(worker, s.env, "POST", "/api/accounts/connect", { workspaceId: s.workspace, platform: "tiktok" }, s.user.cookie);
    expect(r.status).toBe(402);
    expect(r.data.error).toBe("Your plan includes 4 social accounts. Disconnect one or upgrade to connect more.");
    // An account that needs reconnecting can be renewed at the limit, but no new one is added.
    s.sqlite.prepare("UPDATE social_accounts SET status='expired' WHERE external_id='member-0'").run();
    const li = await connect(s, "linkedin");
    mockFetch([
      ["POST", "https://www.linkedin.com/oauth/v2/accessToken", () => ok({ access_token: "li-access", expires_in: 5184000, scope: "openid,profile,w_member_social" })],
      ["GET", "https://api.linkedin.com/v2/userinfo", () => ok({ sub: "member-9", name: "Someone New" })],
    ]);
    const r2 = await call(worker, s.env, "GET", `/api/accounts/callback/linkedin?code=c&state=${li.searchParams.get("state")}`, undefined, s.user.cookie);
    expect(r2.headers.get("Location")).toBe(`/app/accounts?workspace=${s.workspace}&error=limit`);
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM social_accounts").get()).toMatchObject({ n: 4 });
  });

  it("connects Instagram with a long-lived token and the professional account ID", async () => {
    const s = setup();
    const state = (await connect(s, "instagram")).searchParams.get("state")!;
    const calls = mockFetch([
      ["POST", "https://api.instagram.com/oauth/access_token", () =>
        ok({ data: [{ access_token: "ig-short", user_id: "9001", permissions: "instagram_business_basic,instagram_business_content_publish" }] })],
      ["GET", "https://graph.instagram.com/access_token", () => ok({ access_token: "ig-long", token_type: "bearer", expires_in: 5184000 })],
      ["GET", "https://graph.instagram.com/v23.0/me", () =>
        ok({ user_id: "17841400000000000", username: "brand.co", name: "Brand Co", profile_picture_url: "https://scontent.cdninstagram.com/p.jpg", id: "9001" })],
    ]);
    const r = await call(worker, s.env, "GET", `/api/accounts/callback/instagram?code=ig-code%23_&state=${state}`, undefined, s.user.cookie);
    expect(r.headers.get("Location")).toBe(`/app/accounts?workspace=${s.workspace}&connected=instagram`);
    expect(calls[0].body.get("code")).toBe("ig-code");
    const longLived = calls[1].url.searchParams;
    expect(longLived.get("grant_type")).toBe("ig_exchange_token");
    expect(longLived.get("access_token")).toBe("ig-short");
    expect(calls[2].headers.get("Authorization")).toBe("Bearer ig-long");
    expect(calls[2].url.searchParams.get("fields")).toBe("user_id,username,name,profile_picture_url");
    const account: any = s.sqlite.prepare("SELECT * FROM social_accounts").get();
    expect(account).toMatchObject({ platform: "instagram", external_id: "17841400000000000", handle: "brand.co" });
    expect((await open<any>(s.env, account.credentials)).accessToken).toBe("ig-long");
  });

  it("connects a YouTube channel, and explains missing permissions or channels", async () => {
    const s = setup();
    const token = (scope: string) => ok({ access_token: "g-access", expires_in: 3599, refresh_token: "g-refresh", scope, token_type: "Bearer" });
    let state = (await connect(s, "youtube")).searchParams.get("state")!;
    mockFetch([["POST", "https://oauth2.googleapis.com/token", () => token("https://www.googleapis.com/auth/youtube.readonly")]]);
    let r = await call(worker, s.env, "GET", `/api/accounts/callback/youtube?code=c&state=${state}`, undefined, s.user.cookie);
    expect(r.headers.get("Location")).toBe(`/app/accounts?workspace=${s.workspace}&error=permissions`);

    const full = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
    state = (await connect(s, "youtube")).searchParams.get("state")!;
    mockFetch([["POST", "https://oauth2.googleapis.com/token", () => token(full)], ["GET", "https://www.googleapis.com/youtube/v3/channels", () => ok({ items: [] })]]);
    r = await call(worker, s.env, "GET", `/api/accounts/callback/youtube?code=c&state=${state}`, undefined, s.user.cookie);
    expect(r.headers.get("Location")).toBe(`/app/accounts?workspace=${s.workspace}&error=no_channel`);

    state = (await connect(s, "youtube")).searchParams.get("state")!;
    const calls = mockFetch([
      ["POST", "https://oauth2.googleapis.com/token", () => token(full)],
      ["GET", "https://www.googleapis.com/youtube/v3/channels", () =>
        ok({ items: [{ id: "UC123", snippet: { title: "Brand Channel", customUrl: "@brandchannel", thumbnails: { default: { url: "https://yt3.ggpht.com/x" } } } }] })],
    ]);
    r = await call(worker, s.env, "GET", `/api/accounts/callback/youtube?code=c&state=${state}`, undefined, s.user.cookie);
    expect(r.headers.get("Location")).toBe(`/app/accounts?workspace=${s.workspace}&connected=youtube`);
    expect(calls[0].body.get("code_verifier")).toMatch(/^[\w-]{43,128}$/);
    expect(calls[1].url.searchParams.get("mine")).toBe("true");
    const account: any = s.sqlite.prepare("SELECT * FROM social_accounts").get();
    expect(account).toMatchObject({ external_id: "UC123", name: "Brand Channel", handle: "brandchannel", expires_at: null });
  });

  it("maps a failed code exchange to a short error code, never the provider's text", async () => {
    const s = setup();
    const state = (await connect(s, "linkedin")).searchParams.get("state")!;
    mockFetch([["POST", "https://www.linkedin.com/oauth/v2/accessToken", () =>
      new Response(JSON.stringify({ error: "invalid_request", error_description: "Secret <script> details" }), { status: 400 })]]);
    const r = await call(worker, s.env, "GET", `/api/accounts/callback/linkedin?code=c&state=${state}`, undefined, s.user.cookie);
    expect(r.headers.get("Location")).toBe(`/app/accounts?workspace=${s.workspace}&error=failed`);
  });

  it("lists accounts without credentials, with the networks and the limit", async () => {
    const s = setup({ LINKEDIN_CLIENT_ID: undefined });
    mockFetch(tiktokRoutes());
    const state = (await connect(s, "tiktok")).searchParams.get("state")!;
    await call(worker, s.env, "GET", `/api/accounts/callback/tiktok?code=c&state=${state}`, undefined, s.user.cookie);
    const r = await call(worker, s.env, "GET", `/api/accounts?workspace=${s.workspace}`, undefined, s.user.cookie);
    expect(r.status).toBe(200);
    expect(r.data.accounts).toHaveLength(1);
    expect(r.data.accounts[0]).toMatchObject({ platform: "tiktok", name: "Brand Co", handle: "brandco", status: "active" });
    expect(JSON.stringify(r.data)).not.toMatch(/credentials|tt-access|tt-refresh/);
    expect(r.data.platforms).toEqual([
      { id: "tiktok", name: "TikTok", configured: true },
      { id: "instagram", name: "Instagram", configured: true },
      { id: "youtube", name: "YouTube", configured: true },
      { id: "linkedin", name: "LinkedIn", configured: false },
    ]);
    expect(r.data.limit).toEqual({ max: 4, used: 1 });
  });

  it("disconnects an account, unless a post is being published to it", async () => {
    const s = setup();
    const t = Math.floor(Date.now() / 1000);
    const accountId = crypto.randomUUID(), postId = crypto.randomUUID();
    s.sqlite.prepare("INSERT INTO social_accounts(id,user_id,workspace_id,platform,external_id,name,credentials,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(accountId, s.user.id, s.workspace, "tiktok", "open-1", "Brand", "x", t, t);
    s.sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,posts_quota) VALUES (?,?,?,?,?)").run(`${s.user.id}:trial`, s.user.id, "free", 10, 15);
    s.sqlite.prepare("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(postId, s.user.id, s.workspace, `${s.user.id}:trial`, "text", "{}", t, t);
    const pubId = crypto.randomUUID();
    s.sqlite.prepare("INSERT INTO publications(id,user_id,workspace_id,post_id,account_id,platform,scheduled_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(pubId, s.user.id, s.workspace, postId, accountId, "tiktok", t, "publishing", t, t);
    const busy = await call(worker, s.env, "DELETE", `/api/accounts/${accountId}`, undefined, s.user.cookie);
    expect(busy.status).toBe(409);
    expect(busy.data.error).toBe("A post is being published to this account right now. Try again in a minute.");
    s.sqlite.prepare("UPDATE publications SET status='scheduled'").run();
    const other = signedIn(s.sqlite);
    expect((await call(worker, s.env, "DELETE", `/api/accounts/${accountId}`, undefined, other.cookie)).status).toBe(404);
    const done = await call(worker, s.env, "DELETE", `/api/accounts/${accountId}`, undefined, s.user.cookie);
    expect(done.status).toBe(200);
    // A post still scheduled to it is cancelled and kept (with the account's name), not deleted.
    expect(s.sqlite.prepare("SELECT status,account_id FROM publications").get()).toEqual({ status: "canceled", account_id: null });
  });
});

describe("platform details", () => {
  it("cuts TikTok uploads by the media transfer rules", () => {
    const MiB = 1024 * 1024;
    expect(tiktokChunks(3 * MiB)).toEqual({ chunkSize: 3 * MiB, count: 1 });
    expect(tiktokChunks(10 * MiB)).toEqual({ chunkSize: 10 * MiB, count: 1 });
    const big = 50 * MiB + 123;
    const { chunkSize, count } = tiktokChunks(big);
    expect(chunkSize).toBe(10 * MiB);
    expect(count).toBe(5);
    // The last chunk takes the rest and stays under 128 MB.
    expect(big - (count - 1) * chunkSize).toBeLessThan(2 * chunkSize);
    expect(tiktokChunks(19 * MiB)).toEqual({ chunkSize: 10 * MiB, count: 1 });
  });

  it("writes LinkedIn commentary in the little text format", () => {
    const text = commentary("Save 20% (today) on *everything* @ shop_now", ["#launch", "#small_biz"]);
    expect(text).toBe("Save 20% \\(today\\) on \\*everything\\* \\@ shop\\_now\n\n{hashtag|\\#|launch} {hashtag|\\#|small\\_biz}");
    expect(commentary("x".repeat(4000), []).length).toBeLessThanOrEqual(3000);
  });
});
