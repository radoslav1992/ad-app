import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { WorkspaceScan } from "../server/scan-workflow";
import { extractPage, normalizeWebsite, publicUrl } from "../server/scan";
import { planRender } from "../server/render-plan";
import { call, signedIn, subscribe, testEnv } from "./helpers";
import { specSchema } from "../shared/formats";

const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
/** A JPEG header declaring width×height (enough for imageInfo). */
function jpeg(width = 1080, height = 1920) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, ...new Array(40).fill(0)]);
}
/** A fake renderer container: accepts jobs, completes them at once, serves small files. */
function renderer(log: any[] = []) {
  const jobs = new Map<string, any>();
  return {
    log, jobs,
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (url: string, init: any = {}) => {
        const path = new URL(url).pathname.split("/").filter(Boolean);
        if (init.method === "POST") {
          const p = JSON.parse(init.body);
          log.push(p);
          if (jobs.has(p.id)) return Response.json({ status: "running" });
          jobs.set(p.id, p);
          return Response.json({ status: "running" }, { status: 202 });
        }
        if (init.method === "DELETE") return Response.json({});
        const job = jobs.get(path[1]);
        if (!job) return new Response("{}", { status: 404 });
        if (path[2] === "file") return new Response(path[3] === "0" && job.operation === "compose" ? new Uint8Array(4000).fill(7) : jpeg());
        if (job.operation === "inspect") return Response.json({ status: "completed", duration: 12.5, files: 0, meta: { kind: "video", width: 1080, height: 1920, hasAudio: true } });
        return Response.json({ status: "completed", duration: job.operation === "compose" ? 9 : undefined, files: job.operation === "stills" ? job.slides.length : 2 });
      },
    }),
  };
}
function setup(overrides: Record<string, unknown> = {}) {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", FAL_KEY: "fal", HEYGEN_API_KEY: "hg", ELEVENLABS_API_KEY: "el", MEDIA_RENDERER: renderer(), ...overrides });
  const user = signedIn(sqlite);
  return { env, sqlite, user };
}
async function workspace(env: any, cookie: string) {
  const r = await call(worker, env, "POST", "/api/workspaces", { name: "Acme Notes", timezone: "Europe/Sofia" }, cookie);
  expect(r.status).toBe(201);
  return r.data.workspace;
}
function brandImage(sqlite: any, userId: string, workspaceId: string, env: any) {
  const id = crypto.randomUUID(), key = `media/${userId}/${id}.jpg`;
  env.MEDIA.put(key, jpeg(), { httpMetadata: { contentType: "image/jpeg" } });
  sqlite.prepare("INSERT INTO media_assets(id,user_id,workspace_id,kind,name,object_key,mime,bytes,width,height,status,created_at,updated_at) VALUES (?,?,?,'brand','Hero',?,'image/jpeg',64,1080,1920,'ready',1,1)")
    .run(id, userId, workspaceId, key);
  return id;
}
const answer = (value: unknown) => ({ status: "completed", output_text: JSON.stringify(value) });
afterEach(() => vi.unstubAllGlobals());

describe("website scan", () => {
  it("normalizes addresses and refuses private hosts", () => {
    expect(normalizeWebsite("acme.com")).toBe("https://acme.com/");
    expect(normalizeWebsite("http://www.acme.com/app#x")).toBe("http://www.acme.com/app");
    for (const bad of ["localhost", "http://127.0.0.1", "http://[::1]/", "https://intranet", "ftp://acme.com", "https://user:pw@acme.com", "https://acme.com:8443"])
      expect(normalizeWebsite(bad)).toBeNull();
    expect(publicUrl("https://printer.local/")).toBeNull();
  });
  it("extracts text, headings, images and key pages", () => {
    const page = extractPage(`<html lang="en"><head><title>Acme Notes | Notes that think</title>
      <meta name="description" content="Write faster &amp; remember more."><meta property="og:image" content="/og.jpg"><meta name="theme-color" content="#123456">
      <script>var secret = 1</script></head><body><h1>Notes that think</h1><p>For busy founders.</p>
      <img src="/hero.png" alt="App screen" width="800"><img src="/pixel.gif" width="1"><img src="/logo-icon.png" alt="logo" width="64">
      <a href="/pricing">Pricing</a><a href="https://other.com/about">x</a></body></html>`, "https://acme.com/");
    expect(page.title).toBe("Acme Notes | Notes that think");
    expect(page.description).toBe("Write faster & remember more.");
    expect(page.headings).toEqual(["Notes that think"]);
    expect(page.text).toContain("For busy founders.");
    expect(page.text).not.toContain("secret");
    expect(page.images.map((i) => i.url)).toEqual(["https://acme.com/og.jpg", "https://acme.com/hero.png"]);
    expect(page.links).toEqual(["https://acme.com/pricing"]);
    expect(page.themeColor).toBe("#123456");
  });
  it("builds the profile from a description and keeps the owner's company name", async () => {
    const { env, user } = setup();
    const w = await workspace(env, user.cookie);
    env.AI.run = async () => answer({
      name: "Something Else", product: "A note app", description: "Notes that think.", category: "productivity app", audience: "founders",
      valueProps: ["Save time"], painPoints: ["Messy notes"], features: ["AI summaries"], tone: "friendly", cta: "Try it free", keywords: ["#notes"],
      language: "en", primaryColor: "#ff5500", accentColor: "",
    });
    const r = await call(worker, env, "POST", `/api/workspaces/${w.id}/analyze`, { description: "A note-taking app that summarises meetings for founders." }, user.cookie);
    expect(r.status).toBe(202);
    expect(r.data.workspace.scan.status).toBe("scanning");
    await new WorkspaceScan({} as any, env).run({ payload: { workspaceId: w.id } } as any, step as any);
    const after = await call(worker, env, "GET", `/api/workspaces/${w.id}`, undefined, user.cookie);
    expect(after.data.workspace.scan.status).toBe("ready");
    expect(after.data.workspace.profile.name).toBe("Acme Notes");
    expect(after.data.workspace.profile.product).toBe("A note app");
    expect(after.data.workspace.profile.keywords).toEqual(["notes"]);
    expect(after.data.workspace.profile.colors.primary).toBe("#ff5500");
  });
  it("records a clear failure for an unreachable website", async () => {
    const { env, user } = setup();
    const w = await workspace(env, user.cookie);
    vi.stubGlobal("fetch", async () => { throw new TypeError("network"); });
    await call(worker, env, "POST", `/api/workspaces/${w.id}/analyze`, { website: "acme.example.org" }, user.cookie);
    await new WorkspaceScan({} as any, env).run({ payload: { workspaceId: w.id } } as any, step as any);
    const after = await call(worker, env, "GET", `/api/workspaces/${w.id}`, undefined, user.cookie);
    expect(after.data.workspace.scan.status).toBe("failed");
    expect(after.data.workspace.scan.error).toMatch(/couldn't open that website/);
  });
});

describe("workspaces and plans", () => {
  it("limits workspaces by plan", async () => {
    const { env, user } = setup();
    await workspace(env, user.cookie);
    const second = await call(worker, env, "POST", "/api/workspaces", { name: "Second" }, user.cookie);
    expect(second.status).toBe(402);
  });
  it("validates settings and merges profile edits", async () => {
    const { env, user } = setup();
    const w = await workspace(env, user.cookie);
    const bad = await call(worker, env, "PATCH", `/api/workspaces/${w.id}`, { settings: { schedule: { timezone: "Mars/Base", times: ["09:00"], days: [1], autoSchedule: false, accounts: [] } } }, user.cookie);
    expect(bad.status).toBe(400);
    const ok = await call(worker, env, "PATCH", `/api/workspaces/${w.id}`, { profile: { audience: "indie hackers" }, settings: { formats: ["slideshow"] } }, user.cookie);
    expect(ok.status).toBe(200);
    expect(ok.data.workspace.profile).toMatchObject({ name: "Acme Notes", audience: "indie hackers" });
    expect(ok.data.workspace.settings.formats).toEqual(["slideshow"]);
    expect(ok.data.workspace.settings.schedule.timezone).toBe("Europe/Sofia");
  });
});

describe("Blitz batch and the content run", () => {
  it("writes a batch, renders it, and approves a post", async () => {
    const { env, sqlite, user } = setup();
    const w = await workspace(env, user.cookie);
    const image = brandImage(sqlite, user.id, w.id, env);
    env.AI.run = async (_model: string, input: any) => {
      expect(input.instructions).toContain("Write exactly 2 post(s), in this order of formats: slideshow, text");
      return answer({
        posts: [
          { format: "slideshow", pattern: "wish-knew", topic: "Note taking", why: "Saves time.", text: "", slides: [{ text: "things i wish i knew", image: "img1" }, { text: "write less, remember more", image: "color" }, { text: "try Acme", image: "img9" }], background: "", greenScreen: "", hookClip: "", demo: "", demoText: "", script: "", character: "", voice: "", music: "", caption: "Save this.", hashtags: ["notes", "#productivity", "bad tag"], title: "Notes" },
          { format: "text", pattern: "pov", topic: "Meetings", why: "Relatable.", text: "pov: your meeting notes write themselves", slides: [], background: "ai: a desk", greenScreen: "", hookClip: "", demo: "", demoText: "", script: "", character: "", voice: "", music: "", caption: "", hashtags: [], title: "" },
        ],
      });
    };
    const batch = await call(worker, env, "POST", `/api/workspaces/${w.id}/batch`, { count: 2, formats: ["slideshow", "text"] }, user.cookie);
    expect(batch.status).toBe(201);
    expect(batch.data.created).toHaveLength(2);
    expect(env.CONTENT.created).toHaveLength(2);
    // Without AI credits the AI background falls back to the owner's image; nothing is charged.
    expect(sqlite.prepare("SELECT SUM(credits) AS c FROM runs").get()).toEqual({ c: 0 });
    expect(sqlite.prepare("SELECT posts_used FROM usage_windows").get()).toEqual({ posts_used: 2 });
    const list = await call(worker, env, "GET", `/api/posts?workspace=${w.id}&view=making`, undefined, user.cookie);
    const slideshow = list.data.posts.find((p: any) => p.format === "slideshow");
    // Spaces are dropped from tags rather than losing them.
    expect(slideshow.hashtags).toEqual(["#notes", "#productivity", "#badtag"]);
    const detail = await call(worker, env, "GET", `/api/posts/${slideshow.id}`, undefined, user.cookie);
    expect(detail.data.post.spec.slides.map((s: any) => s.image)).toEqual([{ assetId: image }, { color: "#7c5cff" }, { assetId: image }]);

    for (const created of env.CONTENT.created)
      await new ContentGeneration({} as any, env).run({ payload: created.params } as any, step as any);
    const ready = await call(worker, env, "GET", `/api/posts?workspace=${w.id}&view=blitz`, undefined, user.cookie);
    expect(ready.data.posts).toHaveLength(2);
    const made = ready.data.posts.find((p: any) => p.id === slideshow.id);
    expect(made.slides).toHaveLength(3);
    expect(made.videoAssetId).toBeTruthy();
    expect(made.coverAssetId).toBeTruthy();
    expect(made.duration).toBe(9);
    // The renderer got capability links on this site, and the composition matches the slides.
    const compose = env.MEDIA_RENDERER.log.find((p: any) => p.operation === "compose" && p.segments.length === 3);
    expect(compose.urls[0]).toMatch(/^https:\/\/app\.test\/api\/render-inputs\/[0-9a-f-]{36}\/0\?token=[0-9a-f]{64}$/);
    expect(compose.segments.map((s: any) => s.kind)).toEqual(["image", "color", "image"]);
    expect(compose.ass).toContain("things i wish i knew");
    // The rendered file can be downloaded by its owner only.
    const file = await call(worker, env, "GET", `/api/media/${made.videoAssetId}/file`, undefined, user.cookie);
    expect(file.status).toBe(200);
    const stranger = signedIn(sqlite);
    expect((await call(worker, env, "GET", `/api/media/${made.videoAssetId}/file`, undefined, stranger.cookie)).status).toBe(404);
    expect((await call(worker, env, "GET", `/api/posts/${made.id}`, undefined, stranger.cookie)).status).toBe(404);

    const approve = await call(worker, env, "POST", `/api/posts/${made.id}/review`, { decision: "approve" }, user.cookie);
    expect(approve.data).toMatchObject({ ok: true, status: "approved" });
    const left = await call(worker, env, "GET", `/api/posts?workspace=${w.id}&view=blitz`, undefined, user.cookie);
    expect(left.data.posts).toHaveLength(1);
    expect(left.data.counts).toMatchObject({ blitz: 1, approved: 1 });
  });

  it("charges AI images and refunds them when the provider refuses", async () => {
    const { env, sqlite, user } = setup();
    subscribe(sqlite, user.id, "starter");
    const w = await workspace(env, user.cookie);
    const spec = specSchema.parse({ format: "text", text: "a calm morning routine", background: { prompt: "sunrise over a desk" } });
    const created = await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    expect(created.data.credits).toBe(1);
    const used = () => (sqlite.prepare("SELECT used FROM usage_windows WHERE id LIKE ?").get(`${user.id}:sub_%`) as any).used;
    expect(used()).toBe(1);
    vi.stubGlobal("fetch", async () => Response.json({ detail: [{ type: "content_policy_violation" }] }, { status: 422 }));
    await new ContentGeneration({} as any, env).run({ payload: env.CONTENT.created[0].params } as any, step as any);
    expect(used()).toBe(0);
    const post = await call(worker, env, "GET", `/api/posts/${created.data.id}`, undefined, user.cookie);
    expect(post.data.post.renderStatus).toBe("failed");
    expect(post.data.post.renderError).toMatch(/content filter.*credits were refunded/);
  });

  it("makes a talking AI creator post (voice, avatar video, captions) and keeps the recording on caption edits", async () => {
    const { env, sqlite, user } = setup();
    subscribe(sqlite, user.id, "starter");
    const w = await workspace(env, user.cookie);
    const character = crypto.randomUUID();
    sqlite.prepare("INSERT INTO characters(id,name,image_key,mime,look_id,created_at,updated_at) VALUES (?,?,?,?,?,1,1)").run(character, "Mia", "library/x/portrait.jpg", "image/jpeg", "look_1");
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const url = String(input?.url ?? input);
      calls.push(`${init.method || input?.method || "GET"} ${url}`);
      if (url.includes("api.elevenlabs.io")) {
        const chars = [..."Stop scrolling now."];
        return Response.json({
          audio_base64: btoa(String.fromCharCode(...new Uint8Array(48000))),
          alignment: { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.05), character_end_times_seconds: chars.map((_, i) => i * 0.05 + 0.05) },
        });
      }
      if (url === "https://api.heygen.com/v3/videos") {
        const body = JSON.parse(init.body);
        expect(body).toMatchObject({ type: "avatar", avatar_id: "look_1" });
        expect(body.audio_url).toMatch(/\/api\/render-inputs\//);
        expect(init.headers["Idempotency-Key"]).toBeTruthy();
        return Response.json({ data: { video_id: "vid_1" } });
      }
      if (url === "https://api.heygen.com/v3/videos/vid_1" && (init.method || "GET") === "GET") return Response.json({ data: { id: "vid_1", status: "completed", video_url: "https://files.heygen.ai/v.mp4" } });
      if (url === "https://api.heygen.com/v3/videos/vid_1") return Response.json({});
      if (url === "https://files.heygen.ai/v.mp4") return new Response(new Uint8Array(5000).fill(1));
      throw new Error("unexpected " + url);
    });
    const spec = specSchema.parse({ format: "ugc", characterId: character, voiceId: "aria", script: "Stop scrolling now. This app writes your notes for you.", hook: "my new favourite app" });
    const created = await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    // 56 characters: 1 voice credit; ~4 seconds of library creator: 2 credits.
    expect(created.data.credits).toBe(3);
    await new ContentGeneration({} as any, env).run({ payload: env.CONTENT.created[0].params } as any, step as any);
    const post = (await call(worker, env, "GET", `/api/posts/${created.data.id}`, undefined, user.cookie)).data.post;
    expect(post.renderStatus).toBe("ready");
    expect(post.spec.generated.words.map((x: any) => x.text)).toEqual(["Stop", "scrolling", "now."]);
    expect(calls.filter((c) => c.startsWith("POST https://api.heygen.com/v3/videos"))).toHaveLength(1);
    expect(calls).toContain("DELETE https://api.heygen.com/v3/videos/vid_1");
    const compose = env.MEDIA_RENDERER.log.find((p: any) => p.operation === "compose");
    expect(compose.segments[0]).toMatchObject({ kind: "video", audio: 1 });
    expect(compose.ass).toContain("SCROLLING");
    expect(compose.synthetic).toBe(true);
    // A caption edit is saved without a new render or charge.
    const edit = await call(worker, env, "PUT", `/api/posts/${post.id}`, { spec: { ...post.spec, caption: "New caption", generated: undefined }, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(edit.data.rendering).toBe(false);
    expect(env.CONTENT.created).toHaveLength(1);
    // A new hook text re-renders for free, keeping the paid recording.
    const rehook = await call(worker, env, "PUT", `/api/posts/${post.id}`, { spec: { ...post.spec, hook: "wait for it", generated: undefined }, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(rehook.data).toMatchObject({ rendering: true, credits: 0 });
  });

  it("refuses posts after the free trial and when the plan is used up", async () => {
    const { env, sqlite, user } = setup();
    const w = await workspace(env, user.cookie);
    const spec = specSchema.parse({ format: "text", text: "hello world", background: { color: "#000000" } });
    sqlite.prepare("UPDATE usage_windows SET posts_used=posts_quota").run();
    const full = await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(full.status).toBe(402);
    sqlite.prepare("UPDATE users SET created_at=? WHERE id=?").run(Math.floor(Date.now() / 1000) - 8 * 86400, user.id);
    const me = await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
    expect(me.data.user.trialEnded).toBe(true);
  });

  it("does not reveal or accept other people's media in a post", async () => {
    const { env, sqlite, user } = setup();
    const w = await workspace(env, user.cookie);
    const other = signedIn(sqlite);
    await call(worker, env, "GET", "/api/auth/me", undefined, other.cookie);
    const foreign = brandImage(sqlite, other.id, w.id, env);
    const spec = specSchema.parse({ format: "text", text: "hello", background: { assetId: foreign } });
    const r = await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(r.status).toBe(400);
  });
});

describe("render plan", () => {
  const ctx = { media: {} as Record<string, any>, accent: "#112233", watermark: "" };
  it("loops a short clip to fill a wall of text and adds ducked music", () => {
    const clip = crypto.randomUUID(), track = crypto.randomUUID();
    const plan = planRender(specSchema.parse({ format: "text", text: "a long thought", background: { libraryId: clip }, seconds: 8, music: { trackId: track } }), {
      ...ctx, media: { [clip]: { key: "library/c/file.mp4", kind: "video", duration: 3 }, [track]: { key: "library/m/file.mp3", kind: "audio", duration: 60 } },
    });
    expect(plan.compose.segments.map((s) => s.duration)).toEqual([3, 3, 2]);
    expect(plan.compose.keys).toEqual(["library/c/file.mp4", "library/m/file.mp3"]);
    expect(plan.compose.music).toEqual({ input: 1, volume: 0.35, duck: [] });
    expect(plan.stills).toBeNull();
  });
  it("keys a green screen clip over the background", () => {
    const clip = crypto.randomUUID();
    const plan = planRender(specSchema.parse({ format: "green_screen", text: "me when it works", background: { color: "#ffffff" }, clipId: clip }), {
      ...ctx, media: { [clip]: { key: "library/g/file.mp4", kind: "video", duration: 6, chroma: "#00ff00" } },
    });
    expect(plan.compose.segments).toEqual([{ kind: "color", color: "#ffffff", duration: 7 }]);
    expect(plan.compose.overlay).toMatchObject({ input: 0, start: 0, end: 7, chroma: "#00ff00" });
  });
  it("fails clearly when a file is missing", () => {
    expect(() => planRender(specSchema.parse({ format: "text", text: "x", background: { assetId: crypto.randomUUID() } }), ctx)).toThrow("MEDIA_INPUT");
  });
});
