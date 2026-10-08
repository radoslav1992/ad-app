import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { seal, open } from "../server/crypto";
import { autoSchedule, dispatchDue, refreshAccounts } from "../server/publishing";
import { Publication } from "../server/publish-workflow";
import { slots, scheduleSchema } from "../shared/schedule";
import type { Tokens } from "../server/social";
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
const now = () => Math.floor(Date.now() / 1000);
const HOUR = 3600, DAY = 86400;

type Call = { method: string; url: URL; headers: Headers; body: any; redirect?: string };
type Route = [method: string, prefix: string, reply: (c: Call) => Response | Promise<Response>];
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
const ok = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init, headers: { "Content-Type": "application/json", ...(init.headers as any) } });
/** Answers from a list, one per call; the last one repeats. */
const sequence = (...replies: (() => Response)[]) => {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)]();
};
const jsonBody = (c: Call) => JSON.parse(String(c.body));
const bytesOf = (c: Call) => new Uint8Array(c.body as ArrayBuffer);
afterEach(() => vi.unstubAllGlobals());

const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };

type Ctx = Awaited<ReturnType<typeof setup>>;
async function setup(plan: "starter" | "growth" | "pro" | null = "starter", schedule: Record<string, unknown> = {}) {
  const { env, sqlite } = testEnv(KEYS);
  const user = signedIn(sqlite);
  if (plan) subscribe(sqlite, user.id, plan);
  const workspace = crypto.randomUUID();
  const t = now();
  sqlite.prepare("INSERT INTO workspaces(id,user_id,name,settings,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(workspace, user.id, "Brand", JSON.stringify({ schedule: { timezone: "UTC", times: ["09:00", "18:00"], ...schedule } }), t, t);
  sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,posts_quota) VALUES (?,?,?,?,?)").run(`${user.id}:trial`, user.id, "free", 10, 15);
  sqlite.prepare("INSERT INTO media_limits(user_id,max_bytes) VALUES (?,?)").run(user.id, 10 * 1024 ** 3);
  return { env, sqlite, user, workspace };
}

async function asset(s: Ctx, postId: string, kind: string, mime: string, bytes: Uint8Array) {
  const id = crypto.randomUUID(), key = `media/${s.user.id}/${postId}/${id}`;
  s.sqlite.prepare("INSERT INTO media_assets(id,user_id,workspace_id,post_id,kind,name,object_key,mime,bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.user.id, s.workspace, postId, kind, kind, key, mime, bytes.length, now(), now());
  await s.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: mime } });
  return id;
}
const fill = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) % 251);

async function addPost(s: Ctx, o: { format?: string; status?: string; render?: string; duration?: number; slides?: number; videoBytes?: number; spec?: Record<string, unknown> } = {}) {
  const id = crypto.randomUUID(), t = now();
  const spec = { caption: "Meet the new blender.\nIt is quiet.", hashtags: ["#kitchen", "#launch"], title: "", ...o.spec };
  s.sqlite.prepare("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,hook,caption,status,render_status,duration,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.user.id, s.workspace, `${s.user.id}:trial`, o.format ?? "text", JSON.stringify(spec), "Stop scrolling", String(spec.caption), o.status ?? "approved", o.render ?? "ready", o.duration ?? 12, t, t);
  const video = await asset(s, id, "render", "video/mp4", fill(o.videoBytes ?? 4096, 1));
  const slides: string[] = [];
  for (let i = 0; i < (o.slides ?? 0); i++) slides.push(await asset(s, id, "slide", "image/jpeg", fill(300 + i, i + 2)));
  s.sqlite.prepare("UPDATE posts SET video_asset=?,slides=? WHERE id=?").run(video, JSON.stringify(slides), id);
  return id;
}

async function addAccount(s: Ctx, platform: string, o: { tokens?: Partial<Tokens>; status?: string; externalId?: string; handle?: string; workspace?: string } = {}) {
  const id = crypto.randomUUID(), t = now();
  const tokens: Tokens = { accessToken: `${platform}-access`, refreshToken: `${platform}-refresh`, expiresAt: t + 30 * DAY, ...o.tokens };
  s.sqlite.prepare("INSERT INTO social_accounts(id,user_id,workspace_id,platform,external_id,name,handle,credentials,expires_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.user.id, o.workspace ?? s.workspace, platform, o.externalId ?? `${platform}-user`, `${platform} account`, o.handle ?? "brandco", await seal(s.env, tokens), null, o.status ?? "active", t, t);
  return id;
}

function addPublication(s: Ctx, postId: string, accountId: string, platform: string, at = now() - 5, status = "scheduled") {
  const id = crypto.randomUUID(), t = now();
  s.sqlite.prepare("INSERT INTO publications(id,user_id,workspace_id,post_id,account_id,platform,scheduled_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, s.user.id, s.workspace, postId, accountId, platform, at, status, t, t);
  return id;
}
const publication = (s: Ctx, id: string) => s.sqlite.prepare("SELECT * FROM publications WHERE id=?").get(id) as any;

/** Claims the due publication like the cron does, then runs its workflow to the end. */
async function publish(s: Ctx, id: string) {
  await dispatchDue(s.env);
  const p = publication(s, id);
  expect(p.status).toBe("publishing");
  expect(s.env.PUBLISH.created.at(-1)).toEqual({ id: `pub-${id}-${p.attempts}`, params: { publicationId: id } });
  await new Publication({} as any, s.env).run({ payload: { publicationId: id }, instanceId: `pub-${id}-${p.attempts}` } as any, step as any);
  return publication(s, id);
}
/** Fetches one of our capability media links like a network would. */
async function fetchMedia(s: Ctx, url: string, headers: Record<string, string> = {}) {
  expect(url.startsWith(`${SITE}/api/publish-media/`)).toBe(true);
  const res = await worker.fetch(new Request(url, { headers }), s.env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe("scheduling", () => {
  it("needs an approved, finished post and a paid plan", async () => {
    const free = await setup(null);
    const account = await addAccount(free, "tiktok");
    const post = await addPost(free);
    let r = await call(worker, free.env, "POST", `/api/posts/${post}/schedule`, { accountIds: [account] }, free.user.cookie);
    expect(r.status).toBe(402);
    expect(r.data.error).toBe("Scheduling and auto-publishing need a paid plan.");

    const s = await setup();
    const acc = await addAccount(s, "tiktok");
    const pending = await addPost(s, { status: "pending" });
    r = await call(worker, s.env, "POST", `/api/posts/${pending}/schedule`, { accountIds: [acc] }, s.user.cookie);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("Approve this post before scheduling it.");
    const rendering = await addPost(s, { render: "running" });
    r = await call(worker, s.env, "POST", `/api/posts/${rendering}/schedule`, { accountIds: [acc] }, s.user.cookie);
    expect(r.status).toBe(409);
    r = await call(worker, s.env, "POST", `/api/posts/${pending}/schedule`, { accountIds: ["nope"] }, s.user.cookie);
    expect(r.status).toBe(400);
  });

  it("puts the post into the next free slot, then the one after", async () => {
    const s = await setup();
    const tiktok = await addAccount(s, "tiktok"), youtube = await addAccount(s, "youtube");
    const first = await addPost(s), second = await addPost(s);
    const expected = slots(scheduleSchema.parse({ timezone: "UTC", times: ["09:00", "18:00"] }), now() + 60);
    let r = await call(worker, s.env, "POST", `/api/posts/${first}/schedule`, { accountIds: [tiktok, youtube] }, s.user.cookie);
    expect(r.status).toBe(201);
    expect(r.data.scheduledAt).toBe(expected[0]);
    expect(r.data.publications).toHaveLength(2);
    expect(r.data.publications[0]).toMatchObject({ postId: first, status: "scheduled", scheduledAt: expected[0], accountName: expect.any(String) });
    r = await call(worker, s.env, "POST", `/api/posts/${second}/schedule`, { accountIds: [tiktok] }, s.user.cookie);
    expect(r.data.scheduledAt).toBe(expected[1]);
    // The same post on the same account again.
    r = await call(worker, s.env, "POST", `/api/posts/${first}/schedule`, { accountIds: [tiktok], at: now() + DAY }, s.user.cookie);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("This post is already scheduled or published on one of these accounts.");
  });

  it("checks the time, the accounts and what the network accepts", async () => {
    const s = await setup();
    const tiktok = await addAccount(s, "tiktok"), youtube = await addAccount(s, "youtube");
    const post = await addPost(s);
    for (const at of [now() + 10, now() + 181 * DAY]) {
      const r = await call(worker, s.env, "POST", `/api/posts/${post}/schedule`, { accountIds: [tiktok], at }, s.user.cookie);
      expect(r.status).toBe(400);
      expect(r.data.error).toBe("Pick a time at least a minute from now and within the next 180 days.");
    }
    const otherWs = crypto.randomUUID();
    s.sqlite.prepare("INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(otherWs, s.user.id, "Other", now(), now());
    const elsewhere = await addAccount(s, "instagram", { workspace: otherWs });
    let r = await call(worker, s.env, "POST", `/api/posts/${post}/schedule`, { accountIds: [elsewhere] }, s.user.cookie);
    expect(r.status).toBe(400);
    const expired = await addAccount(s, "linkedin", { status: "expired" });
    r = await call(worker, s.env, "POST", `/api/posts/${post}/schedule`, { accountIds: [expired] }, s.user.cookie);
    expect(r.status).toBe(409);
    expect(r.data.error).toContain("Reconnect your LinkedIn account");
    const stranger = await setup();
    const theirs = await addAccount(stranger, "tiktok");
    r = await call(worker, s.env, "POST", `/api/posts/${post}/schedule`, { accountIds: [theirs] }, s.user.cookie);
    expect(r.status).toBe(404);
    const long = await addPost(s, { duration: 240 });
    r = await call(worker, s.env, "POST", `/api/posts/${long}/schedule`, { accountIds: [youtube] }, s.user.cookie);
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("This video is too long for YouTube: the limit is 3 minutes.");
    r = await call(worker, s.env, "POST", `/api/posts/${long}/schedule`, { accountIds: [tiktok], at: now() + HOUR }, s.user.cookie);
    expect(r.status).toBe(201);
  });

  it("shows the calendar with free slots, and moves, cancels and retries", async () => {
    const s = await setup();
    const tiktok = await addAccount(s, "tiktok");
    const post = await addPost(s);
    const at = now() + 2 * HOUR;
    const created = await call(worker, s.env, "POST", `/api/posts/${post}/schedule`, { accountIds: [tiktok], at }, s.user.cookie);
    const pubId = created.data.publications[0].id;
    let cal = await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/calendar`, undefined, s.user.cookie);
    expect(cal.status).toBe(200);
    expect(cal.data.publications).toHaveLength(1);
    expect(cal.data.publications[0]).toMatchObject({ id: pubId, hook: "Stop scrolling", format: "text", scheduledAt: at, platform: "tiktok" });
    expect(cal.data.slots.length).toBeGreaterThanOrEqual(27);
    expect(cal.data.slots.every((x: number) => x > now())).toBe(true);
    expect(cal.data.timezone).toBe("UTC");
    const other = signedIn(s.sqlite);
    expect((await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/calendar`, undefined, other.cookie)).status).toBe(404);
    const list = await call(worker, s.env, "GET", `/api/posts/${post}/publications`, undefined, s.user.cookie);
    expect(list.data.publications).toHaveLength(1);

    let r = await call(worker, s.env, "PATCH", `/api/publications/${pubId}`, { at: at + DAY }, s.user.cookie);
    expect(r.status).toBe(200);
    expect(publication(s, pubId).scheduled_at).toBe(at + DAY);
    r = await call(worker, s.env, "POST", `/api/publications/${pubId}/retry`, undefined, s.user.cookie);
    expect(r.status).toBe(409);
    r = await call(worker, s.env, "DELETE", `/api/publications/${pubId}`, undefined, s.user.cookie);
    expect(r.status).toBe(200);
    expect(publication(s, pubId).status).toBe("canceled");
    r = await call(worker, s.env, "PATCH", `/api/publications/${pubId}`, { at: at + DAY }, s.user.cookie);
    expect(r.status).toBe(409);
    cal = await call(worker, s.env, "GET", `/api/workspaces/${s.workspace}/calendar`, undefined, s.user.cookie);
    expect(cal.data.publications).toHaveLength(0);

    // A failed publication goes back into the queue a minute from now.
    const failed = addPublication(s, post, tiktok, "tiktok", now() - HOUR, "failed");
    s.sqlite.prepare("UPDATE publications SET error='x',ticket='{}',attempts=2 WHERE id=?").run(failed);
    r = await call(worker, s.env, "POST", `/api/publications/${failed}/retry`, undefined, s.user.cookie);
    expect(r.status).toBe(200);
    expect(publication(s, failed)).toMatchObject({ status: "scheduled", error: null, ticket: null, attempts: 2 });
    expect(publication(s, failed).scheduled_at).toBeGreaterThanOrEqual(now() + 59);
  });

  it("auto-schedules approved posts on the default accounts when enabled", async () => {
    const s = await setup();
    const tiktok = await addAccount(s, "tiktok"), youtube = await addAccount(s, "youtube"), expired = await addAccount(s, "instagram", { status: "expired" });
    const post = await addPost(s);
    expect(await autoSchedule(s.env, s.user.id, post)).toBe(0);
    s.sqlite.prepare("UPDATE workspaces SET settings=? WHERE id=?")
      .run(JSON.stringify({ schedule: { timezone: "UTC", times: ["12:00"], autoSchedule: true, accounts: [tiktok, youtube, expired] } }), s.workspace);
    expect(await autoSchedule(s.env, s.user.id, post)).toBe(2);
    const rows: any[] = s.sqlite.prepare("SELECT * FROM publications WHERE post_id=?").all(post);
    expect(new Set(rows.map((r) => r.account_id))).toEqual(new Set([tiktok, youtube]));
    expect(rows[0].scheduled_at).toBe(slots(scheduleSchema.parse({ times: ["12:00"] }), now() + 60)[0]);
    // Already scheduled: nothing more.
    expect(await autoSchedule(s.env, s.user.id, post)).toBe(0);
    expect(await autoSchedule(s.env, s.user.id, await addPost(s, { status: "pending" }))).toBe(0);

    const free = await setup(null, { autoSchedule: true });
    const acc = await addAccount(free, "tiktok");
    free.sqlite.prepare("UPDATE workspaces SET settings=? WHERE id=?").run(JSON.stringify({ schedule: { autoSchedule: true, accounts: [acc] } }), free.workspace);
    expect(await autoSchedule(free.env, free.user.id, await addPost(free))).toBe(0);
  });
});

describe("dispatching due posts", () => {
  it("claims only due posts and starts one workflow each", async () => {
    const s = await setup();
    const account = await addAccount(s, "tiktok");
    const due = addPublication(s, await addPost(s), account, "tiktok", now() - 30);
    const later = addPublication(s, await addPost(s), account, "tiktok", now() + HOUR);
    const canceled = addPublication(s, await addPost(s), account, "tiktok", now() - 30, "canceled");
    await dispatchDue(s.env);
    expect(publication(s, due)).toMatchObject({ status: "publishing", attempts: 1 });
    expect(publication(s, due).token).toMatch(/^[0-9a-f]{64}$/);
    expect(publication(s, due).claimed_at).toBeGreaterThan(now() - 5);
    expect(publication(s, later).status).toBe("scheduled");
    expect(publication(s, canceled).status).toBe("canceled");
    expect(s.env.PUBLISH.created).toEqual([{ id: `pub-${due}-1`, params: { publicationId: due } }]);
    // Claimed once: the next run does not start it again.
    await dispatchDue(s.env);
    expect(s.env.PUBLISH.created).toHaveLength(1);
  });

  it("puts a publication back when its workflow cannot start, and times out stuck ones", async () => {
    const s = await setup();
    const account = await addAccount(s, "tiktok");
    const due = addPublication(s, await addPost(s), account, "tiktok");
    s.env.PUBLISH.create = async () => { throw new Error("unavailable"); };
    s.env.PUBLISH.get = async () => { throw new Error("not found"); };
    await dispatchDue(s.env);
    expect(publication(s, due)).toMatchObject({ status: "scheduled", token: null, attempts: 1 });

    const stuck = addPublication(s, await addPost(s), account, "tiktok", now() - 3 * HOUR, "publishing");
    s.sqlite.prepare("UPDATE publications SET claimed_at=?,token='t' WHERE id=?").run(now() - 3 * HOUR, stuck);
    await dispatchDue(s.env);
    expect(publication(s, stuck)).toMatchObject({ status: "failed", token: null });
    expect(publication(s, stuck).error).toBe("TikTok took too long to confirm this post. Check your TikTok profile before retrying.");
  });
});

describe("media links", () => {
  it("serve the file only while publishing, with the right token, and support ranges", async () => {
    const s = await setup();
    const account = await addAccount(s, "instagram");
    const post = await addPost(s, { format: "slideshow", slides: 3, videoBytes: 1000 });
    const pubId = addPublication(s, post, account, "instagram");
    const base = `${SITE}/api/publish-media/${pubId}`;
    expect((await fetchMedia(s, `${base}/0.jpg?token=${"a".repeat(64)}`)).status).toBe(404);
    await dispatchDue(s.env);
    const token = publication(s, pubId).token;
    expect((await fetchMedia(s, `${base}/0.jpg?token=${"a".repeat(64)}`)).status).toBe(404);
    expect((await fetchMedia(s, `${base}/9.jpg?token=${token}`)).status).toBe(404);

    const full = await fetchMedia(s, `${base}/1.jpg?token=${token}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Type")).toBe("image/jpeg");
    expect(full.headers.get("Content-Length")).toBe("301");
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");
    expect(full.bytes).toEqual(fill(301, 3));

    const part = await fetchMedia(s, `${base}/1?token=${token}`, { Range: "bytes=10-19" });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 10-19/301");
    expect(part.headers.get("Content-Length")).toBe("10");
    expect(part.bytes).toEqual(fill(301, 3).slice(10, 20));
    const tail = await fetchMedia(s, `${base}/1?token=${token}`, { Range: "bytes=-5" });
    expect(tail.status).toBe(206);
    expect(tail.bytes).toEqual(fill(301, 3).slice(296));
    const open = await fetchMedia(s, `${base}/1?token=${token}`, { Range: "bytes=300-" });
    expect(open.bytes).toEqual(fill(301, 3).slice(300));
    const outside = await fetchMedia(s, `${base}/1?token=${token}`, { Range: "bytes=999-" });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("Content-Range")).toBe("bytes */301");

    // A day after the claim the link stops working.
    s.sqlite.prepare("UPDATE publications SET claimed_at=? WHERE id=?").run(now() - 25 * HOUR, pubId);
    expect((await fetchMedia(s, `${base}/1?token=${token}`)).status).toBe(404);
  });
});

describe("publishing", () => {
  const tiktokCreator = () => ok({ data: { creator_username: "brandco", privacy_level_options: ["FOLLOWER_OF_CREATOR", "PUBLIC_TO_EVERYONE", "SELF_ONLY"], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 }, error: { code: "ok" } });

  it("posts a TikTok video: creator info, chunked upload, status", async () => {
    const s = await setup();
    const account = await addAccount(s, "tiktok");
    const post = await addPost(s, { videoBytes: 5000 });
    const pubId = addPublication(s, post, account, "tiktok");
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", tiktokCreator],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/video/init/", () =>
        ok({ data: { publish_id: "v_pub_url~v2.123", upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=abc" }, error: { code: "ok" } })],
      ["PUT", "https://open-upload.tiktokapis.com/video/", () => new Response(null, { status: 201 })],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/status/fetch/", sequence(
        () => ok({ data: { status: "PROCESSING_UPLOAD" }, error: { code: "ok" } }),
        // A 64-bit post ID that a JSON number would round.
        () => new Response('{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7412345678901234567]},"error":{"code":"ok"}}', { status: 200 }),
      )],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "7412345678901234567", url: "https://www.tiktok.com/@brandco/video/7412345678901234567", ticket: null, token: null, error: null });
    const init = jsonBody(calls.find((c) => c.url.pathname.endsWith("/video/init/"))!);
    expect(init.post_info).toMatchObject({ title: "Meet the new blender.\nIt is quiet.\n\n#kitchen #launch", privacy_level: "PUBLIC_TO_EVERYONE", disable_duet: true, disable_comment: false, is_aigc: false });
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 5000, chunk_size: 5000, total_chunk_count: 1 });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.headers.get("Content-Range")).toBe("bytes 0-4999/5000");
    expect(put.headers.get("Content-Type")).toBe("video/mp4");
    expect(put.headers.get("Authorization")).toBeNull();
    expect(bytesOf(put)).toEqual(fill(5000, 1));
    expect(calls.filter((c) => c.url.hostname === "open.tiktokapis.com").every((c) => c.headers.get("Authorization") === "Bearer tiktok-access")).toBe(true);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("posts a TikTok photo slideshow from our media links, privately when the app is unaudited", async () => {
    const s = await setup();
    const account = await addAccount(s, "tiktok");
    const post = await addPost(s, { format: "slideshow", slides: 3, spec: { title: "Three tips" } });
    const pubId = addPublication(s, post, account, "tiktok");
    const fetched: number[] = [];
    let attempt = 0;
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", tiktokCreator],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/content/init/", async (c) => {
        if (attempt++ === 0) return ok({ error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "x" } }, { status: 403 });
        // TikTok pulls each photo from the link while the post is being published.
        for (const url of jsonBody(c).source_info.photo_images) fetched.push((await fetchMedia(s, url)).status);
        return ok({ data: { publish_id: "p_pub_1" }, error: { code: "ok" } });
      }],
      ["POST", "https://open.tiktokapis.com/v2/post/publish/status/fetch/", () => ok({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] }, error: { code: "ok" } })],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "p_pub_1", url: null });
    expect(fetched).toEqual([200, 200, 200]);
    const inits = calls.filter((c) => c.url.pathname.endsWith("/content/init/")).map(jsonBody);
    expect(inits.map((b) => b.post_info.privacy_level)).toEqual(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]);
    expect(inits[1]).toMatchObject({ post_mode: "DIRECT_POST", media_type: "PHOTO", source_info: { source: "PULL_FROM_URL", photo_cover_index: 0 } });
    expect(inits[1].post_info.title).toBe("Three tips");
    expect(inits[1].source_info.photo_images).toEqual([0, 1, 2].map((n) => `${SITE}/api/publish-media/${pubId}/${n}.jpg?token=${inits[1].source_info.photo_images[0].split("token=")[1]}`));
  });

  it("posts an Instagram Reel once its container is ready", async () => {
    const s = await setup();
    const account = await addAccount(s, "instagram", { externalId: "17841400000000000", tokens: { refreshToken: undefined } });
    const post = await addPost(s, { format: "ugc" });
    const pubId = addPublication(s, post, account, "instagram");
    const calls = mockFetch([
      ["POST", "https://graph.instagram.com/v23.0/17841400000000000/media_publish", () => ok({ id: "18000000000000002" })],
      ["POST", "https://graph.instagram.com/v23.0/17841400000000000/media", () => ok({ id: "18000000000000001" })],
      ["GET", "https://graph.instagram.com/v23.0/18000000000000001", sequence(() => ok({ status_code: "IN_PROGRESS" }), () => ok({ status_code: "FINISHED" }))],
      ["GET", "https://graph.instagram.com/v23.0/18000000000000002", () => ok({ permalink: "https://www.instagram.com/reel/AbC123/", id: "18000000000000002" })],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "18000000000000002", url: "https://www.instagram.com/reel/AbC123/" });
    const created = calls.find((c) => c.url.pathname.endsWith("/media"))!;
    const fields = created.body as URLSearchParams;
    expect(fields.get("media_type")).toBe("REELS");
    expect(fields.get("share_to_feed")).toBe("true");
    expect(fields.get("caption")).toBe("Meet the new blender.\nIt is quiet.\n\n#kitchen #launch");
    expect(fields.get("video_url")).toMatch(new RegExp(`^${SITE}/api/publish-media/${pubId}/0\\.mp4\\?token=[0-9a-f]{64}$`));
    expect(created.headers.get("Authorization")).toBe("Bearer instagram-access");
    expect((calls.find((c) => c.url.pathname.endsWith("/media_publish"))!.body as URLSearchParams).get("creation_id")).toBe("18000000000000001");
  });

  it("posts an Instagram carousel from the slides", async () => {
    const s = await setup();
    const account = await addAccount(s, "instagram", { externalId: "555" });
    const post = await addPost(s, { format: "slideshow", slides: 3 });
    const pubId = addPublication(s, post, account, "instagram");
    let n = 100;
    const calls = mockFetch([
      ["POST", "https://graph.instagram.com/v23.0/555/media_publish", () => ok({ id: "900" })],
      ["POST", "https://graph.instagram.com/v23.0/555/media", () => ok({ id: String(n++) })],
      ["GET", "https://graph.instagram.com/v23.0/103", () => ok({ status_code: "FINISHED" })],
      ["GET", "https://graph.instagram.com/v23.0/900", () => ok({ permalink: "https://www.instagram.com/p/XyZ/" })],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "900", url: "https://www.instagram.com/p/XyZ/" });
    const containers = calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/media")).map((c) => c.body as URLSearchParams);
    expect(containers).toHaveLength(4);
    expect(containers.slice(0, 3).every((f) => f.get("is_carousel_item") === "true" && /\/\d\.jpg\?token=/.test(f.get("image_url")!))).toBe(true);
    expect(containers[3].get("media_type")).toBe("CAROUSEL");
    expect(containers[3].get("children")).toBe("100,101,102");
  });

  it("fails clearly when Instagram refuses the media, without its text", async () => {
    const s = await setup();
    const account = await addAccount(s, "instagram", { externalId: "555" });
    const pubId = addPublication(s, await addPost(s), account, "instagram");
    mockFetch([["POST", "https://graph.instagram.com/v23.0/555/media", () =>
      ok({ error: { message: "The video format is not supported <details>", type: "OAuthException", code: 352, error_subcode: 2207026 } }, { status: 400 })]]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "failed", ticket: null, token: null });
    expect(p.error).toBe("Instagram didn't accept this post. Check that it meets Instagram's requirements.");
  });

  it("uploads a YouTube Short with a refreshed token", async () => {
    const s = await setup();
    // The token expires in a minute: it is refreshed (and saved) before the upload.
    const account = await addAccount(s, "youtube", { tokens: { expiresAt: now() + 60 } });
    const post = await addPost(s, { spec: { title: "Quiet blender <3" } });
    const pubId = addPublication(s, post, account, "youtube");
    const session = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=xyz";
    const calls = mockFetch([
      ["POST", "https://oauth2.googleapis.com/token", () => ok({ access_token: "youtube-access-2", expires_in: 3599, scope: "https://www.googleapis.com/auth/youtube.upload", token_type: "Bearer" })],
      ["POST", "https://www.googleapis.com/upload/youtube/v3/videos", () => new Response(null, { status: 200, headers: { Location: session } })],
      ["PUT", session, () => ok({ id: "dQw4w9WgXcQ", status: { uploadStatus: "uploaded" } })],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "dQw4w9WgXcQ", url: "https://youtube.com/shorts/dQw4w9WgXcQ" });
    const refresh = calls[0].body as URLSearchParams;
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("refresh_token")).toBe("youtube-refresh");
    const start = calls.find((c) => c.method === "POST" && c.url.pathname === "/upload/youtube/v3/videos")!;
    expect(start.url.searchParams.get("uploadType")).toBe("resumable");
    expect(start.url.searchParams.get("part")).toBe("snippet,status");
    expect(start.headers.get("Authorization")).toBe("Bearer youtube-access-2");
    expect(start.headers.get("X-Upload-Content-Length")).toBe("4096");
    expect(start.headers.get("X-Upload-Content-Type")).toBe("video/mp4");
    const meta = jsonBody(start);
    expect(meta.snippet).toEqual({ title: "Quiet blender 3", description: "Meet the new blender.\nIt is quiet.\n\n#kitchen #launch #Shorts", categoryId: "22" });
    expect(meta.status).toEqual({ privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.headers.get("Content-Range")).toBe("bytes 0-4095/4096");
    const stored: any = s.sqlite.prepare("SELECT credentials FROM social_accounts WHERE id=?").get(account);
    expect(await open<Tokens>(s.env, stored.credentials)).toMatchObject({ accessToken: "youtube-access-2", refreshToken: "youtube-refresh" });
  });

  it("resumes an interrupted YouTube upload instead of uploading a second video", async () => {
    const s = await setup();
    const account = await addAccount(s, "youtube");
    const pubId = addPublication(s, await addPost(s), account, "youtube");
    const session = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc";
    const calls = mockFetch([
      ["POST", "https://www.googleapis.com/upload/youtube/v3/videos", () => new Response(null, { status: 200, headers: { Location: session } })],
      ["PUT", session, sequence(
        () => { throw new TypeError("network connection lost"); },
        // Status check: Google has the first 1000 bytes.
        () => new Response(null, { status: 308, headers: { Range: "bytes=0-999" } }),
        () => ok({ id: "abcdefghijk", status: { uploadStatus: "uploaded" } }),
      )],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "abcdefghijk" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.headers.get("Content-Range"))).toEqual(["bytes 0-4095/4096", "bytes */4096", "bytes 1000-4095/4096"]);
    expect(bytesOf(puts[2])).toEqual(fill(4096, 1).slice(1000));
  });

  it("posts a LinkedIn video after it finishes processing", async () => {
    const s = await setup();
    const account = await addAccount(s, "linkedin", { externalId: "abc123", tokens: { refreshToken: undefined } });
    const post = await addPost(s, { spec: { caption: "Save 20% (today)", hashtags: ["launch"] } });
    const pubId = addPublication(s, post, account, "linkedin");
    const calls = mockFetch([
      ["POST", "https://api.linkedin.com/rest/videos?action=initializeUpload", () => ok({
        value: { video: "urn:li:video:C5F10AQ", uploadToken: "", uploadUrlsExpireAt: 0, uploadInstructions: [
          { uploadUrl: "https://www.linkedin.com/dms-uploads/part1", firstByte: 0, lastByte: 2047 },
          { uploadUrl: "https://www.linkedin.com/dms-uploads/part2", firstByte: 2048, lastByte: 4095 },
        ] },
      })],
      ["PUT", "https://www.linkedin.com/dms-uploads/", (c) => new Response(null, { status: 200, headers: { ETag: `etag-${c.url.pathname.slice(-1)}` } })],
      ["POST", "https://api.linkedin.com/rest/videos?action=finalizeUpload", () => new Response(null, { status: 200 })],
      ["GET", "https://api.linkedin.com/rest/videos/urn%3Ali%3Avideo%3AC5F10AQ", sequence(() => ok({ status: "PROCESSING" }), () => ok({ status: "AVAILABLE" }))],
      ["POST", "https://api.linkedin.com/rest/posts", () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7100000000000000001" } })],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "urn:li:share:7100000000000000001", url: "https://www.linkedin.com/feed/update/urn:li:share:7100000000000000001/" });
    const init = calls[0];
    expect(init.headers.get("LinkedIn-Version")).toMatch(/^\d{6}$/);
    expect(init.headers.get("X-Restli-Protocol-Version")).toBe("2.0.0");
    expect(jsonBody(init)).toEqual({ initializeUploadRequest: { owner: "urn:li:person:abc123", fileSizeBytes: 4096, uploadCaptions: false, uploadThumbnail: false } });
    const parts = calls.filter((c) => c.method === "PUT");
    expect(parts.map((c) => bytesOf(c).length)).toEqual([2048, 2048]);
    expect(jsonBody(calls.find((c) => c.url.search === "?action=finalizeUpload")!)).toEqual({
      finalizeUploadRequest: { video: "urn:li:video:C5F10AQ", uploadToken: "", uploadedPartIds: ["etag-1", "etag-2"] },
    });
    const created = jsonBody(calls.find((c) => c.url.pathname === "/rest/posts")!);
    expect(created).toEqual({
      author: "urn:li:person:abc123",
      commentary: "Save 20% \\(today\\)\n\n{hashtag|\\#|launch}",
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media: { id: "urn:li:video:C5F10AQ", title: "Save 20% (today)" } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
  });

  it("posts LinkedIn images as a multi-image post", async () => {
    const s = await setup();
    const account = await addAccount(s, "linkedin", { externalId: "abc123" });
    const post = await addPost(s, { format: "slideshow", slides: 3 });
    const pubId = addPublication(s, post, account, "linkedin");
    let n = 0;
    const calls = mockFetch([
      ["POST", "https://api.linkedin.com/rest/images?action=initializeUpload", () => {
        n++;
        return ok({ value: { uploadUrl: `https://www.linkedin.com/dms-uploads/img${n}`, image: `urn:li:image:D${n}` } });
      }],
      ["PUT", "https://www.linkedin.com/dms-uploads/", () => new Response(null, { status: 201 })],
      ["GET", "https://api.linkedin.com/rest/images/", () => ok({ status: "AVAILABLE" })],
      ["POST", "https://api.linkedin.com/rest/posts", () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:42" } })],
    ]);
    const p = await publish(s, pubId);
    expect(p).toMatchObject({ status: "published", external_id: "urn:li:share:42" });
    const uploads = calls.filter((c) => c.method === "PUT");
    expect(uploads.map((c) => bytesOf(c).length)).toEqual([300, 301, 302]);
    expect(uploads[0].headers.get("Authorization")).toBe("Bearer linkedin-access");
    const created = jsonBody(calls.find((c) => c.url.pathname === "/rest/posts")!);
    expect(created.content.multiImage.images.map((i: any) => i.id)).toEqual(["urn:li:image:D1", "urn:li:image:D2", "urn:li:image:D3"]);
  });

  it("fails as interrupted rather than risking a second LinkedIn post", async () => {
    const s = await setup();
    const account = await addAccount(s, "linkedin", { externalId: "abc123" });
    const pubId = addPublication(s, await addPost(s), account, "linkedin");
    let posts = 0;
    mockFetch([
      ["POST", "https://api.linkedin.com/rest/videos?action=initializeUpload", () =>
        ok({ value: { video: "urn:li:video:V1", uploadToken: "", uploadInstructions: [{ uploadUrl: "https://www.linkedin.com/dms-uploads/p", firstByte: 0, lastByte: 4095 }] } })],
      ["PUT", "https://www.linkedin.com/dms-uploads/", () => new Response(null, { status: 200, headers: { ETag: "e" } })],
      ["POST", "https://api.linkedin.com/rest/videos?action=finalizeUpload", () => new Response(null, { status: 200 })],
      ["GET", "https://api.linkedin.com/rest/videos/", () => ok({ status: "AVAILABLE" })],
      ["POST", "https://api.linkedin.com/rest/posts", () => { posts++; throw new TypeError("connection reset"); }],
    ]);
    const p = await publish(s, pubId);
    expect(posts).toBe(1);
    expect(p.status).toBe("failed");
    expect(p.error).toBe("Publishing was interrupted. Check your LinkedIn profile before retrying, so it isn't posted twice.");
  });

  it("marks the account expired when its token cannot be refreshed", async () => {
    const s = await setup();
    const account = await addAccount(s, "tiktok", { tokens: { expiresAt: now() - 10 } });
    const pubId = addPublication(s, await addPost(s), account, "tiktok");
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/oauth/token/", () => ok({ error: "invalid_grant", error_description: "Refresh token is invalid", log_id: "x" }, { status: 400 })],
    ]);
    const p = await publish(s, pubId);
    expect(calls).toHaveLength(1);
    expect(p.status).toBe("failed");
    expect(p.error).toBe("Reconnect your TikTok account, then try again.");
    expect((s.sqlite.prepare("SELECT status FROM social_accounts WHERE id=?").get(account) as any).status).toBe("expired");
  });

  it("retries a start the network refused for a while, then gives up with a plain message", async () => {
    const s = await setup();
    const account = await addAccount(s, "tiktok");
    const pubId = addPublication(s, await addPost(s), account, "tiktok");
    const calls = mockFetch([
      ["POST", "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", () => ok({ error: { code: "rate_limit_exceeded", message: "slow down" } }, { status: 429 })],
    ]);
    const p = await publish(s, pubId);
    expect(calls).toHaveLength(4);
    expect(p).toMatchObject({ status: "failed", ticket: null });
    expect(p.error).toBe("TikTok is limiting how often this account can post. Try again later.");
  });

  it("does nothing for a publication that is no longer being published, and fails unready posts", async () => {
    const s = await setup();
    const account = await addAccount(s, "tiktok");
    const calls = mockFetch([]);
    const canceled = addPublication(s, await addPost(s), account, "tiktok", now() - 5, "canceled");
    await new Publication({} as any, s.env).run({ payload: { publicationId: canceled } } as any, step as any);
    expect(publication(s, canceled).status).toBe("canceled");
    const post = await addPost(s);
    const pubId = addPublication(s, post, account, "tiktok");
    s.sqlite.prepare("UPDATE posts SET status='rejected' WHERE id=?").run(post);
    const p = await publish(s, pubId);
    expect(p.status).toBe("failed");
    expect(p.error).toBe("This post isn't ready to publish. Check that it is approved and finished.");
    expect(calls).toHaveLength(0);
  });

  it("renews Instagram tokens in their last days", async () => {
    const s = await setup();
    const account = await addAccount(s, "instagram", { tokens: { refreshToken: undefined, expiresAt: now() + 5 * DAY } });
    s.sqlite.prepare("UPDATE social_accounts SET expires_at=? WHERE id=?").run(now() + 5 * DAY, account);
    const gone = await addAccount(s, "linkedin");
    s.sqlite.prepare("UPDATE social_accounts SET expires_at=? WHERE id=?").run(now() - 10, gone);
    const calls = mockFetch([["GET", "https://graph.instagram.com/refresh_access_token", () => ok({ access_token: "ig-renewed", token_type: "bearer", expires_in: 5184000 })]]);
    await refreshAccounts(s.env);
    expect(calls[0].url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    const row: any = s.sqlite.prepare("SELECT * FROM social_accounts WHERE id=?").get(account);
    expect((await open<Tokens>(s.env, row.credentials)).accessToken).toBe("ig-renewed");
    expect(row.expires_at).toBeGreaterThan(now() + 59 * DAY);
    expect((s.sqlite.prepare("SELECT status FROM social_accounts WHERE id=?").get(gone) as any).status).toBe("expired");
  });
});
