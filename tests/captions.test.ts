import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { planRender, spokenWords } from "../server/render-plan";
import { withItems } from "../server/caption-ass";
import { claimSpeech, SPEECH_PER_DAY, transcribe, whisperWords, WHISPER_MODEL } from "../server/speech";
import { conceptToSpec, varied, type Concept } from "../server/ideas";
import { call, signedIn, testEnv } from "./helpers";
import { specSchema } from "../shared/formats";
import { defaultLook, layoutOverlay, overlayItems, revealSeconds, textAnimations, type TextLook } from "../shared/overlay";
import { animState, type CaptionItem } from "../shared/caption-scene";
import { clipWords, loopedWords } from "../shared/speech";
import { captionStyles } from "../shared/captions";
import { textWidth } from "../shared/caption-fonts";

const W = 1080, H = 1920;
const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
afterEach(() => vi.unstubAllGlobals());

/** The state an ASS event shows at its start and end, read back from its override tags. */
function eventStates(line: string) {
  const [, layer, start, end] = line.match(/^Dialogue: (\d+),([^,]+),([^,]+),/)!;
  const clock = (t: string) => { const [h, m, s] = t.split(":"); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
  const tags = line.match(/\{([^}]*)\}/)![1];
  const move = tags.match(/\\move\(([^)]*)\)/), pos = tags.match(/\\pos\(([^,]+),([^)]+)\)/);
  const [x0, y0, x1, y1] = move ? move[1].split(",").map(Number) : [Number(pos![1]), Number(pos![2]), Number(pos![1]), Number(pos![2])];
  const head = tags.split("\\t(")[0], change = tags.match(/\\t\(0,\d+,(.*)\)/)?.[1] || "";
  const look = (t: string) => ({
    scale: Number(t.match(/\\fscy([\d.]+)/)?.[1] ?? NaN) / 100,
    alpha: 1 - parseInt(t.match(/\\1a&H([0-9A-F]{2})&/)?.[1] ?? "00", 16) / 255,
  });
  const first = look(head), last = change ? { ...first, ...Object.fromEntries(Object.entries(look(change)).filter(([, v]) => !Number.isNaN(v))) } : first;
  return { layer: Number(layer), start: clock(start), end: clock(end), from: { x: x0, y: y0, ...first }, to: { x: x1, y: y1, ...last } };
}
const near = (a: number, b: number, d = 0.02) => Math.abs(a - b) <= d;

describe("text animations", () => {
  const text = "nobody tells you this about pricing your first client";
  const look = (animation: TextLook["animation"], extra: Partial<TextLook> = {}): TextLook => ({ ...defaultLook(), animation, ...extra });

  it("keeps old posts valid: no animation and no subtitles unless chosen", () => {
    const text = specSchema.parse({ format: "text", text: "hello", background: { color: "#000000" }, look: { weight: "bold", size: 1, color: "#ffffff", stroke: 4, strokeColor: "#000000", background: null, position: "center" } });
    expect(text.format === "text" && [text.look.animation, text.subtitles]).toEqual(["none", { enabled: false, style: "classic" }]);
    const demo = specSchema.parse({ format: "hook_demo", hook: "wait", hookClip: { libraryId: crypto.randomUUID() }, demo: { assetId: crypto.randomUUID() } });
    expect(demo.format === "hook_demo" && demo.subtitles.enabled).toBe(false);
    const ugc = specSchema.parse({ format: "ugc", characterId: crypto.randomUUID(), voiceId: "aria", script: "Stop scrolling now, this is the one app." });
    expect(ugc.format === "ugc" && [ugc.captionStyle, ugc.hookLook.animation]).toEqual(["bold", "none"]);
    expect(specSchema.safeParse({ ...text, look: { ...defaultLook(), animation: "spin" } }).success).toBe(false);
    expect(specSchema.safeParse({ ...demo, subtitles: { enabled: true, style: "nope" } }).success).toBe(false);
  });

  it("enters within 0.6 s (word by word: paced to the text, done well before the block ends)", () => {
    for (const animation of textAnimations) {
      for (const [value, seconds] of [["wait for it", 3], [text, 4], [`${text} `.repeat(6).trim(), 12]] as const) {
        const items = overlayItems(value, look(animation, { background: "#ffffff" }), W, H, { start: 2, end: 2 + seconds });
        const reveal = revealSeconds(value, look(animation), W, H, seconds);
        if (animation === "none") expect(items.every((i) => !i.anim)).toBe(true);
        else if (animation === "words") expect(reveal).toBeLessThanOrEqual(Math.min(6, seconds * 0.4) + 0.01);
        else expect(reveal).toBeLessThanOrEqual(0.6 + 1e-9);
        for (const item of items) {
          // Hidden (or on its way in) at the start, settled once the entrance is over.
          if (animation !== "none") expect(animState(item, 2).alpha, animation).toBe(0);
          expect(animState(item, 2 + reveal + 0.001), animation).toEqual({ dx: 0, dy: 0, scale: 1, sx: 1, alpha: 1 });
        }
      }
    }
  });

  it("reveals words in reading order on the same wrapped lines as the static text", () => {
    const l = look("words");
    const layout = layoutOverlay(text, l, W, H);
    const words = overlayItems(text, l, W, H, { start: 0, end: 6 }).filter((i): i is Extract<CaptionItem, { kind: "text" }> => i.kind === "text");
    const lines = layout.lines.map((line) => words.filter((w) => w.y === line.y).map((w) => w.text).join(" "));
    expect(lines).toEqual(layout.lines.map((line) => line.text));
    layout.lines.forEach((line) => {
      const row = words.filter((w) => w.y === line.y);
      // Placed inside the line's own box, left to right.
      expect(row[0].x - textWidthOf(row[0]) / 2).toBeCloseTo(W / 2 - line.width / 2, 5);
      expect(row.at(-1)!.x + textWidthOf(row.at(-1)!) / 2).toBeCloseTo(W / 2 + line.width / 2, 5);
    });
    const starts = words.map((w) => w.anim![0].t);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(words.length);
  });

  it("burns the same keyframes into ASS as the preview draws", () => {
    for (const animation of textAnimations) {
      const items = overlayItems(text, look(animation, { background: "#222222" }), W, H, { start: 1.5, end: 5 });
      for (const item of items) {
        const lines = withItems("", [item], 1.5, 5).trim().split("\n");
        expect(lines[0]).toMatch(/^Dialogue: \d+,0:00:01\.50,/);
        expect(lines.at(-1)).toMatch(/,0:00:05\.00,Default,/);
        if (!item.anim) expect(lines.join("")).not.toMatch(/\\t\(|\\move/);
        // Event times are written in centiseconds; the state belongs to the exact keyframe time behind each.
        const cuts = [1.5, 5, ...(item.anim || []).map((k) => k.t)];
        const exact = (t: number) => cuts.find((c) => Math.abs(c - t) <= 0.0051) ?? t;
        for (const line of lines) {
          const e = eventStates(line);
          for (const [at, shown] of [[e.start, e.from], [e.end, e.to]] as const) {
            const want = animState(item, exact(at));
            expect(near(shown.x, item.x + want.dx, 0.01) && near(shown.y, item.y + want.dy, 0.01), `${animation} position at ${at}`).toBe(true);
            expect(near(shown.scale, want.scale, 0.0001), `${animation} scale at ${at}`).toBe(true);
            expect(near(shown.alpha, (item.alpha ?? 1) * want.alpha, 1 / 255 + 1e-9), `${animation} alpha at ${at}`).toBe(true);
          }
        }
      }
    }
  });
});
/** A word's width with the shared metrics the layout uses (bold text is the "sans" font). */
const textWidthOf = (item: Extract<CaptionItem, { kind: "text" }>) => textWidth(item.text, item.size, item.font);

describe("render plan: animated text and subtitles", () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const speech = [
    { text: "before", start: 3, end: 3.5 }, { text: "edge", start: 4.8, end: 5.3 }, { text: "inside", start: 6, end: 6.5 },
    { text: "late", start: 8.8, end: 9.4 }, { text: "after", start: 10, end: 10.5 },
  ];
  const media = {
    [id(1)]: { key: "library/hook.mp4", kind: "video", duration: 3 },
    [id(2)]: { key: "media/u/demo.mp4", kind: "video", duration: 20, words: speech },
    [id(3)]: { key: "media/u/talk.mp4", kind: "video", duration: 3, words: [{ text: "hello", start: 0.5, end: 1 }, { text: "there", start: 2.8, end: 3.4 }] },
  } as any;
  const ctx = { media, accent: "#112233", watermark: "" };
  const dialogue = (ass: string, word: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue:") && l.endsWith(`}${word}`)).map((l) => l.split(",")[1]);

  it("places the demo's words after the hook, trimmed to the part of the clip it uses", () => {
    const spec = specSchema.parse({ format: "hook_demo", hook: "watch this", hookClip: { libraryId: id(1) }, demo: { assetId: id(2), start: 5, seconds: 4 }, subtitles: { enabled: true, style: "classic" } });
    const plan = planRender(spec, ctx);
    expect(spokenWords(plan.compose.segments, 1, speech)).toEqual([{ text: "edge", start: 3, end: 3.3 }, { text: "inside", start: 4, end: 4.5 }]);
    const ass = plan.compose.ass;
    // Caption events (layers 10 and up) run from the first word's start to the last one's end.
    const events = ass.split("\n").filter((l) => /^Dialogue: \d{2},/.test(l)).map((l) => l.split(",").slice(1, 3));
    expect(events.map((e) => e[0]).sort()[0]).toBe("0:00:03.00");
    expect(events.map((e) => e[1]).sort().at(-1)).toBe("0:00:04.50");
    expect(dialogue(ass, "edge").length).toBeGreaterThan(0);
    expect(dialogue(ass, "inside").length).toBeGreaterThan(0);
    for (const gone of ["before", "late", "after"]) expect(dialogue(ass, gone)).toEqual([]);
    // Off: no words at all.
    const off = planRender(specSchema.parse({ ...spec, subtitles: { enabled: false, style: "classic" } }), ctx).compose.ass;
    expect(dialogue(off, "inside")).toEqual([]);
  });

  it("repeats a looping clip's words under a wall of text only while its sound is kept", () => {
    const spec = specSchema.parse({ format: "text", text: "pov: the clip talks", background: { assetId: id(3) }, seconds: 8, clipAudio: true, subtitles: { enabled: true, style: "karaoke" } });
    const plan = planRender(spec, ctx);
    expect(plan.compose.segments.map((s) => s.duration)).toEqual([3, 3, 2]);
    // "there" straddles the clip's end: its middle (3.1 s) is past the 3 s clip, so it is dropped; the loop cuts at 8 s.
    expect(spokenWords(plan.compose.segments, 0, media[id(3)].words)).toEqual([
      { text: "hello", start: 0.5, end: 1 }, { text: "hello", start: 3.5, end: 4 }, { text: "hello", start: 6.5, end: 7 },
    ]);
    expect(loopedWords(media[id(3)].words, 3, 8)).toEqual(spokenWords(plan.compose.segments, 0, media[id(3)].words));
    expect(dialogue(plan.compose.ass, "HELLO").filter((t, i, a) => a.indexOf(t) === i)).toEqual(expect.arrayContaining(["0:00:00.50", "0:00:03.50", "0:00:06.50"]));
    const muted = planRender(specSchema.parse({ ...spec, clipAudio: false }), ctx).compose.ass;
    expect(muted).not.toContain("HELLO");
  });

  it("animates text from each slide's start, keeps stills still and picks a cover with all the text shown", () => {
    const slides = [{ text: "one two three four five six", image: { color: "#000000" } }, { text: "second slide here", image: { color: "#111111" } }];
    const spec = specSchema.parse({ format: "slideshow", slides, secondsPerSlide: 3, look: { ...defaultLook(), animation: "words" } });
    const plan = planRender(spec, ctx);
    const second = plan.compose.ass.split("\n").filter((l) => l.endsWith("}second"));
    expect(second[0]).toMatch(/^Dialogue: \d+,0:00:03\.00,/);
    expect(second[0]).toMatch(/\\1a&HFF&/);
    expect(plan.compose.coverAt).toBeGreaterThanOrEqual(revealSeconds(slides[0].text, { ...defaultLook(), animation: "words" }, W, H, 3));
    expect(plan.compose.coverAt).toBeLessThan(3);
    for (const still of plan.stills!.slides) expect(still.ass).not.toMatch(/\\t\(|\\move/);
    const fade = planRender(specSchema.parse({ ...spec, look: { ...defaultLook(), animation: "fade" } }), ctx);
    expect(fade.compose.coverAt).toBe(0.6);
  });

  it("cuts clip words to the used part by their middle", () => {
    const words = [{ text: "a", start: 0.9, end: 1.3 }, { text: "b", start: 1.6, end: 2.6 }, { text: "c", start: 3.9, end: 4.3 }];
    expect(clipWords(words, 1, 3, 10)).toEqual([{ text: "a", start: 10, end: 10.3 }, { text: "b", start: 10.6, end: 11.6 }]);
  });
});

describe("speech in uploads", () => {
  /** Whisper's answer for one part, in the documented shape. */
  const whisper = (words: [string, number, number][], extra: Record<string, unknown> = {}) => ({
    text: words.map((w) => w[0]).join(""), word_count: words.length, vtt: "WEBVTT",
    transcription_info: { language: "en", language_probability: 0.98, duration: 120, duration_after_vad: 100 },
    segments: [{ start: 0, end: 10, text: "x", temperature: 0, avg_logprob: -0.2, compression_ratio: 1.2, no_speech_prob: 0.01, words: words.map(([word, start, end]) => ({ word, start, end })) }],
    ...extra,
  });

  it("reads Whisper's words, moved to their part, without sound notes or unlikely speech", () => {
    const answer = whisper([[" Hello", 0.5, 0.9], [" world.", 0.9, 0.9], [" [Music]", 1, 3], [" ♪", 3, 4], [" ", 4, 5]], {
      segments: [
        whisper([[" Hello", 0.5, 0.9], [" world.", 0.9, 0.9], [" [Music]", 1, 3], [" ♪", 3, 4], [" ", 4, 5]]).segments[0],
        { start: 10, end: 12, no_speech_prob: 0.9, avg_logprob: -1.4, words: [{ word: " Thanks", start: 10, end: 11 }] },
        { start: 12, end: 13, words: [{ word: " no-time" }, { word: " ok", start: 12, end: 12.4 }] },
      ],
    });
    expect(whisperWords(answer, 120)).toEqual({
      language: "en",
      words: [{ text: "Hello", start: 120.5, end: 120.9 }, { text: "world.", start: 120.9, end: 120.95 }, { text: "ok", start: 132, end: 132.4 }],
    });
    expect(whisperWords({ error: "x" })).toEqual({ language: "", words: [] });
    expect(whisperWords(null)).toEqual({ language: "", words: [] });
  });

  it("sends each part to Whisper as base64 and joins the words in order", async () => {
    const seen: any[] = [];
    const env: any = { AI: { run: async (model: string, input: any) => { seen.push({ model, input }); return whisper([[` part${seen.length}`, 1, 1.5]]); } } };
    const parts = [new Uint8Array([1, 2, 3]), new Uint8Array(70000).fill(255)];
    const t = await transcribe(env, parts, 120);
    expect(t).toEqual({ language: "en", words: [{ text: "part1", start: 1, end: 1.5 }, { text: "part2", start: 121, end: 121.5 }] });
    expect(seen.map((s) => s.model)).toEqual([WHISPER_MODEL, WHISPER_MODEL]);
    expect(seen[0].input).toEqual({ audio: "AQID", task: "transcribe", vad_filter: true, condition_on_previous_text: false });
    expect(Buffer.from(seen[1].input.audio, "base64")).toEqual(Buffer.from(parts[1]));
  });

  /** A renderer that checks uploads and cuts their sound: `parts` MP3 files (0: silent). */
  function renderer(env: any, parts: number, log: any[]) {
    const jobs = new Map<string, any>();
    return {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (url: string, init: any = {}) => {
          const path = new URL(url).pathname.split("/").filter(Boolean);
          if (init.method === "POST") {
            const p = JSON.parse(init.body);
            if (!jobs.has(p.id)) {
              // The renderer downloads the file through its capability link while the job runs.
              const link = new URL(p.url);
              p.download = (await call(worker, env, "GET", link.pathname + link.search)).status;
              log.push(p);
              jobs.set(p.id, p);
            }
            return Response.json({ status: "running" }, { status: 202 });
          }
          if (init.method === "DELETE") return Response.json({});
          const job = jobs.get(path[1]);
          if (!job) return new Response("{}", { status: 404 });
          if (path[2] === "file") return new Response(new Uint8Array(1000).fill(Number(path[3]) + 1));
          if (job.operation === "inspect") return Response.json({ status: "completed", duration: 130, files: 0, meta: { kind: "video", width: 1080, height: 1920, hasAudio: true } });
          return Response.json({ status: "completed", duration: 130, files: parts });
        },
      }),
    };
  }
  /** An uploaded video waiting for its check (as /complete leaves it). */
  async function upload(env: any, sqlite: any, user: { id: string; cookie: string }) {
    // The first request gives the person their plan's storage.
    await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie);
    const userId = user.id, id = crypto.randomUUID(), key = `media/${userId}/${id}.mp4`;
    void env.MEDIA.put(key, new Uint8Array(5000).fill(9), { httpMetadata: { contentType: "video/mp4" } });
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,status,meta,created_at,updated_at) VALUES (?,?,'upload','Demo.mp4',?,'video/mp4',5000,'checking',?,1,1)")
      .run(id, userId, key, JSON.stringify({ token: "t".repeat(64) }));
    return id;
  }
  function setup(parts = 2) {
    const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true" });
    const log: any[] = [];
    env.MEDIA_RENDERER = renderer(env, parts, log);
    const user = signedIn(sqlite);
    return { env, sqlite, user, log };
  }
  const run = (env: any, inspectId: string) => new ContentGeneration({} as any, env).run({ payload: { inspectId } } as any, step as any);

  it("transcribes an upload after its check and returns its words", async () => {
    const { env, sqlite, user, log } = setup();
    const calls: any[] = [];
    env.AI.run = async (model: string, input: any) => {
      calls.push({ model, bytes: Buffer.from(input.audio, "base64") });
      return calls.length === 1 ? whisper([[" Here's", 1, 1.4], [" how", 1.4, 1.7]]) : whisper([[" it", 3, 3.2], [" works.", 3.2, 3.8]]);
    };
    const id = await upload(env, sqlite, user);
    await run(env, id);
    expect(log.map((p) => [p.operation, p.download])).toEqual([["inspect", 200], ["audio", 200]]);
    expect(log[1]).toMatchObject({ part: 120 });
    expect(log[1].url).toMatch(new RegExp(`^https://app\\.test/api/upload-inputs/${id}\\?token=[0-9a-f]{64}$`));
    // Each part the renderer cut is heard once, in order.
    expect(calls.map((c) => [c.model, c.bytes[0], c.bytes.length])).toEqual([[WHISPER_MODEL, 1, 1000], [WHISPER_MODEL, 2, 1000]]);
    const one = await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie);
    expect(one.data.asset).toMatchObject({ status: "ready", hasAudio: true, speech: "found", speechLanguage: "en", duration: 130 });
    expect(one.data.asset.transcript).toEqual({ language: "en", words: [
      { text: "Here's", start: 1, end: 1.4 }, { text: "how", start: 1.4, end: 1.7 }, { text: "it", start: 123, end: 123.2 }, { text: "works.", start: 123.2, end: 123.8 },
    ] });
    // Lists say whether speech was found, without the words.
    const list = await call(worker, env, "GET", "/api/media?type=video", undefined, user.cookie);
    expect(list.data.assets[0]).toMatchObject({ id, speech: "found" });
    expect(list.data.assets[0].transcript).toBeUndefined();
    // The renderer's link stops working once the sound was cut.
    const link = new URL(log[1].url);
    expect((await call(worker, env, "GET", link.pathname + link.search)).status).toBe(404);
    expect(JSON.parse((sqlite.prepare("SELECT meta FROM media_assets WHERE id=?").get(id) as any).meta).listen).toBeUndefined();
  });

  it("keeps a failed transcription a usable upload, and finds speech again on request", async () => {
    const { env, sqlite, user, log } = setup(1);
    env.AI.run = async () => { throw new Error("AI down"); };
    const id = await upload(env, sqlite, user);
    await run(env, id);
    const failed = (await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset;
    expect(failed).toMatchObject({ status: "ready", speech: "failed", error: null, transcript: null });
    env.AI.run = async () => whisper([[" hi", 0.2, 0.5]]);
    const again = await call(worker, env, "POST", `/api/media/${id}/speech`, {}, user.cookie);
    expect(again.status).toBe(202);
    expect(again.data.asset.speech).toBe("pending");
    expect(env.CONTENT.created.at(-1)).toMatchObject({ params: { inspectId: id } });
    expect(env.CONTENT.created.at(-1).id).toMatch(new RegExp(`^speech-${id}-\\d+$`));
    // Asking again while it runs starts nothing new.
    expect((await call(worker, env, "POST", `/api/media/${id}/speech`, {}, user.cookie)).status).toBe(200);
    expect(env.CONTENT.created).toHaveLength(1);
    await run(env, id);
    expect(log.filter((p) => p.operation === "audio").map((p) => p.download)).toEqual([200, 200]);
    const found = (await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset;
    expect(found).toMatchObject({ speech: "found", transcript: { words: [{ text: "hi", start: 0.2, end: 0.5 }] } });
  });

  it("says when there is no speech, and refuses what cannot hold any", async () => {
    const { env, sqlite, user } = setup(0);
    env.AI.run = async () => { throw new Error("not called for silence"); };
    const id = await upload(env, sqlite, user);
    await run(env, id);
    const silent = (await call(worker, env, "GET", `/api/media/${id}`, undefined, user.cookie)).data.asset;
    expect(silent).toMatchObject({ status: "ready", speech: "none" });
    expect((await call(worker, env, "POST", `/api/media/${id}/speech`, {}, user.cookie)).status).toBe(409);
    const image = crypto.randomUUID();
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,width,height,status,created_at,updated_at) VALUES (?,?,'upload','x',?,'image/jpeg',10,10,10,'ready',1,1)")
      .run(image, user.id, `media/${user.id}/${image}.jpg`);
    expect((await call(worker, env, "POST", `/api/media/${image}/speech`, {}, user.cookie)).status).toBe(400);
    const stranger = signedIn(sqlite);
    expect((await call(worker, env, "POST", `/api/media/${id}/speech`, {}, stranger.cookie)).status).toBe(404);
  });

  it("is limited per person and day", async () => {
    const { env } = testEnv();
    for (let i = 0; i < SPEECH_PER_DAY; i++) expect(await claimSpeech(env, "u1", {})).toMatchObject({ speech: { status: "pending" } });
    expect(await claimSpeech(env, "u1", {})).toBeNull();
    expect(await claimSpeech(env, "u2", {})).not.toBeNull();
  });
});

describe("the writer's captions and animations", () => {
  const catalog = {
    images: [], clips: [{ ref: "clip1", id: crypto.randomUUID(), name: "Shocked", tags: "reaction", seconds: 3 }], greens: [], music: [],
    videos: [{ ref: "vid1", id: crypto.randomUUID(), name: "Demo", seconds: 30, speech: true }, { ref: "vid2", id: crypto.randomUUID(), name: "Silent demo", seconds: 30 }],
    characters: [{ ref: "char1", id: crypto.randomUUID(), name: "Mia", gender: "female", kind: "library" as const }],
  };
  const base = { pattern: "pov", topic: "x", why: "y", text: "", slides: [], background: "", greenScreen: "", hookClip: "", demo: "", demoText: "", script: "", character: "", voice: "", music: "", caption: "c", hashtags: [], title: "" };
  const req = { catalog, useCredits: true, caps: { aiMedia: false, talking: true }, mention: true, profile: { colors: { primary: "#112233" } } as any };

  it("uses the chosen caption style and animation, and switches subtitles on for a demo with speech", () => {
    const ugc = conceptToSpec({ ...base, format: "ugc", text: "my new app", script: "Okay so this app literally writes my notes for me.", character: "char1", voice: "aria", captionStyle: "neon", animation: "pop" } as Concept, "ugc", req)!;
    expect(ugc.format === "ugc" && [ugc.captionStyle, ugc.hookLook.animation, ugc.hookLook.position]).toEqual(["neon", "pop", "top"]);
    const odd = conceptToSpec({ ...base, format: "ugc", script: "Okay so this app literally writes my notes for me.", character: "char1", captionStyle: "comic-sans", animation: "spin" } as Concept, "ugc", req)!;
    expect(odd.format === "ugc" && [odd.captionStyle, odd.hookLook.animation]).toEqual(["bold", "rise"]);
    const wall = conceptToSpec({ ...base, format: "text", text: "a long candid thought", background: "clip1" } as Concept, "text", req)!;
    expect(wall.format === "text" && [wall.look.animation, wall.subtitles.enabled]).toEqual(["words", false]);
    const talking = conceptToSpec({ ...base, format: "hook_demo", text: "wait", hookClip: "clip1", demo: "vid1", captionStyle: "highlight", animation: "words" } as Concept, "hook_demo", req)!;
    expect(talking.format === "hook_demo" && [talking.subtitles, talking.look.animation]).toEqual([{ enabled: true, style: "highlight" }, "pop"]);
    const silent = conceptToSpec({ ...base, format: "hook_demo", text: "wait", hookClip: "clip1", demo: "vid2" } as Concept, "hook_demo", req)!;
    expect(silent.format === "hook_demo" && silent.subtitles.enabled).toBe(false);
  });

  it("varies caption styles and animations across a batch", () => {
    const plan = ["ugc", "ugc", "ugc", "hook_demo", "hook_demo", "text", "text"] as const;
    const written = plan.map((format) => ({ ...base, format, captionStyle: "bold", animation: "pop" }) as Concept);
    const out = varied(written, [...plan]);
    const styles = out.slice(0, 3).map((k) => k.captionStyle);
    expect(new Set(styles).size).toBe(3);
    expect(styles.every((s) => (captionStyles as readonly string[]).includes(s!))).toBe(true);
    expect(out.slice(3, 5).map((k) => k.animation)).toEqual(["pop", "rise"]);
    // A wall of text keeps an animation that suits it (and may repeat it).
    expect(out.slice(5).map((k) => k.animation)).toEqual(["words", "words"]);
  });
});
