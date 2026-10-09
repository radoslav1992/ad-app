import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { claimSpeech, scribeWords, SCRIBE_MODEL, SCRIBE_URL, SPEECH_FILES_PER_DAY, SPEECH_MINUTES_PER_DAY, transcribe } from "../server/speech";
import { ProviderError } from "../server/providers/http";
import { call, signedIn, subscribe, testEnv } from "./helpers";
import { speechCredits } from "../shared/credits";
import { tariffs } from "../shared/plans";

// Speech to text with ElevenLabs Scribe v2 (as rech-bg): the request and its answer, the free allowance after uploads,
// and long videos transcribed for credits (charged once, refunded on failure).

const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
afterEach(() => vi.unstubAllGlobals());

/** Scribe's answer: words with spacing between them, as the API returns it. */
const scribe = (words: [string, number, number][], language = "eng") => ({
  language_code: language, language_probability: 0.98, text: words.map((w) => w[0]).join(" "),
  words: words.flatMap(([text, start, end], i) => [
    ...(i ? [{ text: " ", start, end: start, type: "spacing", logprob: 0 }] : []),
    { text, start, end, type: "word", logprob: -0.1, speaker_id: "speaker_0" },
  ]),
});

describe("Scribe answers", () => {
  it("keeps real words in order, within the file, without brackets or control characters", () => {
    const answer = {
      language_code: "ENG",
      words: [
        { text: "Hello", start: 0.5, end: 0.9, type: "word" }, { text: " ", start: 0.9, end: 1, type: "spacing" },
        { text: "(laughs)", start: 1, end: 2, type: "audio_event" },
        // A word that starts before the previous one ended starts at its end (times only go forward).
        { text: "<b>world</b>.", start: 0.8, end: 1.4, type: "word" },
        { text: "no-time", type: "word" }, { text: "   ", start: 2, end: 3, type: "word" }, { text: 7, start: 3, end: 4, type: "word" },
        { text: "a\u0000[b]", start: 3, end: 3.333, type: "word" },
        // Past the file's end it is cut to the end; one fully past it is dropped.
        { text: "end", start: 9.5, end: 10.7, type: "word" }, { text: "after", start: 10.8, end: 11, type: "word" },
      ],
    };
    expect(scribeWords(answer, 10)).toEqual({
      language: "eng",
      words: [{ text: "Hello", start: 0.5, end: 0.9 }, { text: "bworld/b.", start: 0.9, end: 1.4 }, { text: "ab", start: 3, end: 3.33 }, { text: "end", start: 9.5, end: 10 }],
    });
    expect(scribeWords({ detail: "x" }, 10)).toEqual({ language: "", words: [] });
    expect(scribeWords(null, 10)).toEqual({ language: "", words: [] });
  });

  it("sends the file's link (no upload, no language) and reads the words", async () => {
    const seen: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      seen.push({ url, method: init.method, key: init.headers["xi-api-key"], redirect: init.redirect, fields: Object.fromEntries((init.body as FormData).entries()) });
      return Response.json(scribe([["Here's", 1, 1.4], ["how.", 1.4, 1.7]], "bul"));
    });
    const env: any = { ELEVENLABS_API_KEY: " el-key " };
    expect(await transcribe(env, "https://app.test/api/upload-inputs/x?token=t", 30)).toEqual({ language: "bul", words: [{ text: "Here's", start: 1, end: 1.4 }, { text: "how.", start: 1.4, end: 1.7 }] });
    expect(seen).toEqual([{
      url: SCRIBE_URL, method: "POST", key: "el-key", redirect: "manual",
      fields: { model_id: SCRIBE_MODEL, source_url: "https://app.test/api/upload-inputs/x?token=t", timestamps_granularity: "word", tag_audio_events: "false" },
    }]);
    expect(SCRIBE_MODEL).toBe("scribe_v2");
  });

  it("turns failures into codes and never calls without a key", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ detail: { status: "quota_exceeded", message: "secret" } }, { status: 401 }));
    await expect(transcribe({ ELEVENLABS_API_KEY: "k" } as any, "https://x", 5)).rejects.toMatchObject({ code: "SPEECH_UNAVAILABLE" });
    vi.stubGlobal("fetch", async () => new Response("oops", { status: 500 }));
    await expect(transcribe({ ELEVENLABS_API_KEY: "k" } as any, "https://x", 5)).rejects.toMatchObject({ code: "SPEECH_FAILED" });
    const never = vi.fn();
    vi.stubGlobal("fetch", never);
    await expect(transcribe({} as any, "https://x", 5)).rejects.toBeInstanceOf(ProviderError);
    expect(never).not.toHaveBeenCalled();
  });
});

/** A renderer that checks uploads: `duration` seconds of video with sound. */
function renderer(env: any, duration: number, log: any[]) {
  const jobs = new Map<string, any>();
  return {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (url: string, init: any = {}) => {
        const path = new URL(url).pathname.split("/").filter(Boolean);
        if (init.method === "POST") {
          const p = JSON.parse(init.body);
          if (!jobs.has(p.id)) { log.push(p); jobs.set(p.id, p); }
          return Response.json({ status: "running" }, { status: 202 });
        }
        if (init.method === "DELETE") return Response.json({});
        if (!jobs.get(path[1])) return new Response("{}", { status: 404 });
        return Response.json({ status: "completed", duration, files: 0, meta: { kind: "video", width: 1920, height: 1080, hasAudio: true } });
      },
    }),
  };
}
/** Scribe: reads the file through its link (as the real service does), then answers `words` (or `status`). */
function scribeService(env: any, words: () => [string, number, number][], status = 200) {
  const calls: { link: string; download: number }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    if (url !== SCRIBE_URL) throw new Error("unexpected " + url);
    const link = new URL(String((init.body as FormData).get("source_url")));
    calls.push({ link: link.href, download: (await call(worker, env, "GET", link.pathname + link.search)).status });
    return status === 200 ? Response.json(scribe(words())) : new Response("{}", { status });
  });
  return calls;
}
function setup(duration = 130) {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", ELEVENLABS_API_KEY: "el" });
  const log: any[] = [];
  env.MEDIA_RENDERER = renderer(env, duration, log);
  const user = signedIn(sqlite);
  return { env, sqlite, user, log };
}
/** An uploaded video waiting for its check (as /complete leaves it). */
async function upload(env: any, sqlite: any, user: { id: string; cookie: string }, maxSeconds = 600) {
  await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
  const id = crypto.randomUUID(), key = `media/${user.id}/${id}.mp4`;
  await env.MEDIA.put(key, new Uint8Array(5000).fill(9), { httpMetadata: { contentType: "video/mp4" } });
  sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,status,meta,created_at,updated_at) VALUES (?,?,'upload','Demo.mp4',?,'video/mp4',5000,'checking',?,1,1)")
    .run(id, user.id, key, JSON.stringify({ token: "t".repeat(64), maxSeconds }));
  return id;
}
/** A ready long video with sound (60 minutes unless said otherwise). */
function longVideo(env: any, sqlite: any, userId: string, duration = 3600) {
  const id = crypto.randomUUID(), key = `media/${userId}/${id}.mp4`;
  void env.MEDIA.put(key, new Uint8Array(5000).fill(3), { httpMetadata: { contentType: "video/mp4" } });
  sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,duration,width,height,status,meta,created_at,updated_at) VALUES (?,?,'upload','Podcast.mp4',?,'video/mp4',5000,?,1920,1080,'ready',?,1,1)")
    .run(id, userId, key, duration, JSON.stringify({ hasAudio: true }));
  return id;
}
const run = (env: any, payload: Record<string, string>) => new ContentGeneration({} as any, env).run({ payload } as any, step as any);
const meta = (sqlite: any, id: string) => JSON.parse((sqlite.prepare("SELECT meta FROM media_assets WHERE id=?").get(id) as any).meta);

describe("speech in uploads (free, up to 10 minutes)", () => {
  it("transcribes an upload after its check, through a link that stops working afterwards", async () => {
    const { env, sqlite, user, log } = setup();
    const calls = scribeService(env, () => [["Here's", 1, 1.4], ["how", 1.4, 1.7], ["it", 123, 123.2], ["works.", 123.2, 123.8]]);
    const id = await upload(env, sqlite, user);
    await run(env, { inspectId: id });
    expect(log.map((p) => [p.operation, p.maxSeconds])).toEqual([["inspect", 600]]);
    expect(calls).toHaveLength(1);
    expect(calls[0].link).toMatch(new RegExp(`^https://app\\.test/api/upload-inputs/${id}\\?token=[0-9a-f]{64}$`));
    expect(calls[0].download).toBe(200);
    const one = await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie);
    expect(one.data.asset).toMatchObject({ status: "ready", hasAudio: true, speech: "found", speechLanguage: "eng", duration: 130 });
    expect(one.data.asset.transcript.words).toHaveLength(4);
    // Only the words of a moment, when asked for.
    const part = await call(worker, env, "GET", `/api/media/${id}?from=100&to=130`, undefined, user.cookie);
    expect(part.data.asset.transcript.words.map((w: any) => w.text)).toEqual(["it", "works."]);
    // Lists say whether speech was found, without the words (not even read from the database).
    const list = await call(worker, env, "GET", "/api/media?type=video", undefined, user.cookie);
    expect(list.data.assets[0]).toMatchObject({ id, speech: "found" });
    expect(list.data.assets[0].transcript).toBeUndefined();
    const link = new URL(calls[0].link);
    expect((await call(worker, env, "GET", link.pathname + link.search)).status).toBe(404);
    expect(meta(sqlite, id).listen).toBeUndefined();
  });

  it("keeps a failed transcription a usable upload, and finds speech again on request", async () => {
    const { env, sqlite, user } = setup();
    scribeService(env, () => [], 500);
    const id = await upload(env, sqlite, user);
    await run(env, { inspectId: id });
    const failed = (await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset;
    expect(failed).toMatchObject({ status: "ready", speech: "failed", error: null, transcript: null });
    const calls = scribeService(env, () => [["hi", 0.2, 0.5]]);
    const again = await call(worker, env, "POST", `/api/media/${id}/speech`, {}, user.cookie);
    expect(again.status).toBe(202);
    expect(again.data.asset.speech).toBe("pending");
    // Asking again while it runs starts nothing new.
    expect((await call(worker, env, "POST", `/api/media/${id}/speech`, {}, user.cookie)).status).toBe(200);
    expect(env.CONTENT.created).toHaveLength(1);
    await run(env, env.CONTENT.created[0].params);
    expect(calls.map((c) => c.download)).toEqual([200]);
    expect((await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset).toMatchObject({ speech: "found", transcript: { words: [{ text: "hi", start: 0.2, end: 0.5 }] } });
  });

  it("says when there is no speech, and refuses what cannot hold any", async () => {
    const { env, sqlite, user } = setup();
    scribeService(env, () => []);
    const id = await upload(env, sqlite, user);
    await run(env, { inspectId: id });
    expect((await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset).toMatchObject({ status: "ready", speech: "none" });
    expect((await call(worker, env, "POST", `/api/media/${id}/speech`, {}, user.cookie)).status).toBe(409);
    const image = crypto.randomUUID();
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,width,height,status,created_at,updated_at) VALUES (?,?,'upload','x',?,'image/jpeg',10,10,10,'ready',1,1)")
      .run(image, user.id, `media/${user.id}/${image}.jpg`);
    expect((await call(worker, env, "POST", `/api/media/${image}/speech`, {}, user.cookie)).status).toBe(400);
    expect((await call(worker, env, "POST", `/api/media/${id}/speech`, {}, signedIn(sqlite).cookie)).status).toBe(404);
  });

  it("never calls Scribe twice for one claim (an answer lost mid-step fails instead of paying again)", async () => {
    const { env, sqlite, user } = setup();
    const calls = scribeService(env, () => [["x", 0, 1]]);
    const id = await upload(env, sqlite, user);
    // The check is done and the speech claimed, as if a first attempt had called Scribe and then died.
    sqlite.prepare("UPDATE media_assets SET status='ready',duration=130,meta=? WHERE id=?")
      .run(JSON.stringify({ hasAudio: true, speech: { status: "pending", at: Math.floor(Date.now() / 1000), claim: "earlier" }, listen: { token: "a".repeat(64), until: 9e9 } }), id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run(env, { inspectId: id });
    expect(calls).toHaveLength(0);
    expect(meta(sqlite, id).speech.status).toBe("failed");
  });

  it("is bounded per person and day, in files and in minutes; long videos are never transcribed for free", async () => {
    const { env } = testEnv();
    // 30 minutes: three 10-minute files, then nothing; another person has their own allowance.
    for (let i = 0; i < 3; i++) expect(await claimSpeech(env, "u1", {}, 600)).toMatchObject({ speech: { status: "pending" } });
    expect(await claimSpeech(env, "u1", {}, 30)).toBeNull();
    expect(await claimSpeech(env, "u2", {}, 61)).not.toBeNull();
    // 20 files of a few seconds, then nothing (minutes are left, files are not).
    for (let i = 0; i < SPEECH_FILES_PER_DAY; i++) expect(await claimSpeech(env, "u3", {}, 5)).not.toBeNull();
    expect(await claimSpeech(env, "u3", {}, 5)).toBeNull();
    expect([SPEECH_FILES_PER_DAY, SPEECH_MINUTES_PER_DAY]).toEqual([20, 30]);

    const { env: e2, sqlite, user, log } = setup(3000);
    const calls = scribeService(e2, () => [["x", 0, 1]]);
    const id = await upload(e2, sqlite, user, 7200);
    await run(e2, { inspectId: id });
    expect(log[0]).toMatchObject({ operation: "inspect", maxSeconds: 7200 });
    expect(calls).toHaveLength(0);
    expect((await call(worker, e2, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset).toMatchObject({ status: "ready", duration: 3000, speech: null });
    expect((await call(worker, e2, "POST", `/api/media/${id}/speech`, {}, user.cookie)).data.error).toMatch(/longer than 10 minutes/);
  });

  it("takes long videos only on paid plans", async () => {
    const { env, sqlite, user } = setup();
    const start = (bytes: number) => call(worker, env, "POST", "/api/media/uploads", { name: "Podcast.mp4", mime: "video/mp4", bytes }, user.cookie);
    const big = await start(800 * 1024 * 1024);
    expect(big.status).toBe(413);
    expect(big.data.error).toMatch(/500 MB on the free trial; paid plans take videos up to 2 hours/);
    const small = await start(1000);
    expect(meta(sqlite, small.data.id).maxSeconds).toBe(600);
    subscribe(sqlite, user.id, "starter");
    const paid = await start(1800 * 1024 * 1024);
    expect(paid.status).toBe(201);
    expect(meta(sqlite, paid.data.id).maxSeconds).toBe(7200);
    expect((await start(2000 * 1024 * 1024)).status).toBe(413);
  });
});

describe("long videos transcribed for credits", () => {
  const used = (sqlite: any, userId: string) => (sqlite.prepare("SELECT COALESCE(SUM(used),0) AS n FROM usage_windows WHERE user_id=?").get(userId) as any).n;
  async function paid() {
    const s = setup(3600);
    subscribe(s.sqlite, s.user.id, "starter");
    await call(worker, s.env, "GET", "/api/auth/me", undefined, s.user.cookie);
    return { ...s, video: longVideo(s.env, s.sqlite, s.user.id, 3600) };
  }
  const transcribeVideo = (env: any, cookie: string, id: string, credits: number, key: string = crypto.randomUUID()) =>
    call(worker, env, "POST", `/api/media/${id}/transcribe`, { idempotencyKey: key, credits }, cookie);

  it("costs one credit per started 10 minutes, shown before and charged once", async () => {
    expect([speechCredits(1), speechCredits(600), speechCredits(601), speechCredits(3600), speechCredits(7200)]).toEqual([1, 1, 2, 6, 12]);
    expect(tariffs.find((t) => t.name === "Speech to text")?.text).toMatch(/1 credit per started 10 minutes/);
    const { env, sqlite, user, video } = await paid();
    // A price other than the one the server charges is refused, and nothing is charged.
    const stale = await transcribeVideo(env, user.cookie, video, 5);
    expect(stale.status).toBe(409);
    expect(stale.data.error).toMatch(/costs 6 credits/);
    const key = crypto.randomUUID();
    const started = await transcribeVideo(env, user.cookie, video, 6, key);
    expect(started.status).toBe(202);
    expect(started.data.asset.speech).toBe("pending");
    expect(used(sqlite, user.id)).toBe(6);
    // The same request again, or another one while it runs: nothing more is charged or started.
    expect((await transcribeVideo(env, user.cookie, video, 6, key)).status).toBe(200);
    expect((await transcribeVideo(env, user.cookie, video, 6)).status).toBe(200);
    expect(used(sqlite, user.id)).toBe(6);
    expect(env.CONTENT.created).toHaveLength(1);
    const runRow = sqlite.prepare("SELECT kind,credits,status,post_id,payload FROM runs").get() as any;
    expect(runRow).toMatchObject({ kind: "speech", credits: 6, status: "queued", post_id: null });
    expect(JSON.parse(runRow.payload)).toEqual({ assetId: video });
    // The workflow transcribes it: the words are kept, the credits stay spent.
    const calls = scribeService(env, () => [["Welcome", 1, 1.5], ["back.", 1.5, 2]]);
    await run(env, env.CONTENT.created[0].params);
    expect(calls).toHaveLength(1);
    expect(calls[0].download).toBe(200);
    expect(sqlite.prepare("SELECT status FROM runs").get()).toEqual({ status: "completed" });
    expect((await call(worker, env, "GET", `/api/media/${video}`, undefined, user.cookie)).data.asset).toMatchObject({ speech: "found", transcript: { words: [{ text: "Welcome" }, { text: "back." }] } });
    expect(used(sqlite, user.id)).toBe(6);
    // Found already: no new charge.
    expect((await transcribeVideo(env, user.cookie, video, 6)).status).toBe(200);
    expect(used(sqlite, user.id)).toBe(6);
  });

  it("refunds a transcription that fails, and the video stays usable", async () => {
    const { env, sqlite, user, video } = await paid();
    expect((await transcribeVideo(env, user.cookie, video, 6)).status).toBe(202);
    expect(used(sqlite, user.id)).toBe(6);
    scribeService(env, () => [], 500);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run(env, env.CONTENT.created[0].params);
    expect(sqlite.prepare("SELECT status,error FROM runs").get()).toEqual({ status: "failed", error: "SPEECH_FAILED" });
    expect(used(sqlite, user.id)).toBe(0);
    expect((await call(worker, env, "GET", `/api/media/${video}`, undefined, user.cookie)).data.asset).toMatchObject({ status: "ready", speech: "failed" });
    // It can be tried again (and is charged again).
    expect((await transcribeVideo(env, user.cookie, video, 6)).status).toBe(202);
    expect(used(sqlite, user.id)).toBe(6);
  });

  it("needs a confirmed email, enough credits and a long video of one's own", async () => {
    const { env, sqlite, user, video } = await paid();
    const short = longVideo(env, sqlite, user.id, 300);
    expect((await transcribeVideo(env, user.cookie, short, 1)).data.error).toMatch(/found for free/);
    expect((await transcribeVideo(env, signedIn(sqlite).cookie, video, 6)).status).toBe(404);
    sqlite.prepare("UPDATE usage_windows SET used=quota-5 WHERE user_id=?").run(user.id);
    expect((await transcribeVideo(env, user.cookie, video, 6)).status).toBe(402);
    sqlite.prepare("UPDATE users SET verified=0 WHERE id=?").run(user.id);
    expect((await transcribeVideo(env, user.cookie, video, 6)).status).toBe(403);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
  });
});
