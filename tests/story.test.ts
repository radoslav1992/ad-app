import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { planRender, type PlanContext } from "../server/render-plan";
import { acceptScenePlan, acceptStory, storyShape, storyToSpec } from "../server/story";
import { alignedWords, ALIGNMENT_URL, forcedAlignment } from "../server/providers/elevenlabs";
import { falRequest } from "../server/providers/fal";
import { feasible } from "../server/ideas";
import { call, signedIn, subscribe, testEnv } from "./helpers";
import { narrationCurrent, pendingMedia, specCredits, specSchema, type StorySpec } from "../shared/formats";
import {
  AUTO_TRANSITIONS, clipFor, estimatedTimings, mergeScenes, moveEdge, narrationKey, splitScene, toggleKey, resolveTransition, scenePrompt, scenesFromCounts, splitScenes, storyScript, storySegments,
  storyStyleIds, storyStyles, storyTiming, timedScript, transitionInfo, transitionKinds, FPS, STORY_MAX_SCENES,
} from "../shared/story";
import { captionTimeline } from "../shared/caption-scene";
import { keyWordIndex, styledCaptions, titleCase, type CaptionWord } from "../shared/captions";
import { CLIP_CREDITS, IMAGE_CREDITS, voiceCredits } from "../shared/credits";

// Narrated videos (shared/story.ts): scenes on the voiceover's clock, their pictures, transitions centred on scene
// edges, the "keyword" subtitles, prices, the run that makes them, the timing of an owner's voiceover, and the writer.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** The voiceover, sentence by sentence, with when each one is said (seconds). */
const said: [string, number, number][] = [
  ["Octopuses have three hearts and blue blood.", 0.2, 2.6],
  ["Two hearts pump blood to the gills, while the third one feeds the rest of the body.", 3.0, 7.8],
  ["When an octopus swims, that third heart stops beating.", 8.2, 10.9],
  ["That is why they would rather crawl than swim.", 11.3, 13.6],
  ["Nature found a strange answer to a simple problem.", 14.0, 16.5],
];
const DURATION = 17;
/** Words spread evenly over each sentence. */
const words: CaptionWord[] = said.flatMap(([text, start, end]) => {
  const parts = text.split(" "), step = (end - start) / parts.length;
  return parts.map((w, i) => ({ text: w, start: r3(start + i * step), end: r3(start + (i + 1) * step - 0.02) }));
});
const scene = (n: number, extra: Record<string, unknown> = {}) => ({ text: said[n][0], description: `Doodle of sentence ${n + 1}`, keys: [], ...extra });
const story = (extra: Record<string, unknown> = {}) =>
  specSchema.parse({ format: "story", narration: { kind: "voice", voiceId: "george" }, scenes: said.map((_, n) => scene(n)), ...extra }) as StorySpec;

describe("scenes on the voice's clock", () => {
  it("splits timed words into scenes of one or two sentences, 2–8 s, always on word boundaries", () => {
    const counts = splitScenes(words);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(words.length);
    const texts = scenesFromCounts(words, counts);
    // Every scene ends a sentence and starts on a word: the edges are word boundaries.
    expect(texts.join(" ")).toBe(said.map((s) => s[0]).join(" "));
    expect(texts).toEqual([said[0][0], said[1][0], `${said[2][0]} ${said[3][0]}`, said[4][0]]);
    let at = 0;
    for (const n of counts) {
      const span = words[at + n - 1].end - words[at].start;
      expect(span).toBeGreaterThanOrEqual(2);
      expect(span).toBeLessThanOrEqual(8);
      at += n;
    }
    // A sentence over 8 s is split where the speaker pauses (at its comma here), never inside a word.
    const long = "This sentence keeps going and going for a very long time, until it finally ends after many many words.".split(" ");
    const slow = long.map((text, i) => ({ text, start: i * 0.6, end: i * 0.6 + 0.5 + (text.endsWith(",") ? 0.3 : 0) }));
    expect(scenesFromCounts(slow, splitScenes(slow))).toEqual([
      "This sentence keeps going and going for a very long time,", "until it finally ends after many many words.",
    ]);
    // A long voice never makes more than the scene limit; one word is one scene.
    const many = Array.from({ length: 300 }, (_, i) => ({ text: i % 3 === 2 ? "end." : "word", start: i * 0.55, end: i * 0.55 + 0.5 }));
    const capped = splitScenes(many);
    expect(capped.length).toBeLessThanOrEqual(STORY_MAX_SCENES);
    expect(capped.reduce((a, b) => a + b, 0)).toBe(300);
    expect(splitScenes([{ text: "Hi.", start: 0, end: 0.4 }])).toEqual([1]);
    expect(splitScenes([])).toEqual([]);
  });

  it("times the written words by the voice's words: by position, else by their letters", () => {
    const written = ["It", "costs", "$29.", "Wow."];
    const spoken = [{ text: "It", start: 3, end: 3.2 }, { text: "costs", start: 3.2, end: 3.5 }, { text: "twenty-nine", start: 3.5, end: 4 }, { text: "dollars.", start: 4, end: 4.5 }, { text: "Wow.", start: 5, end: 5.4 }];
    const timed = timedScript(written, spoken, 6);
    expect(timed.map((w) => w.text)).toEqual(written);
    expect(timed[0]).toEqual({ text: "It", start: 3, end: 3.2 });
    // The number read out gets the time between its neighbours.
    expect(timed[2].start).toBeCloseTo(3.5, 5);
    expect(timed[2].end).toBeLessThanOrEqual(5);
    expect(timed[3]).toEqual({ text: "Wow.", start: 5, end: 5.4 });
    // As many words: by position (the voice may write them differently).
    expect(timedScript(["a", "b"], [{ text: "A!", start: 1, end: 2 }, { text: "bee", start: 2, end: 3 }], 4)).toEqual([{ text: "a", start: 1, end: 2 }, { text: "b", start: 2, end: 3 }]);
    // Before a voice is made: estimated from the script, a pause after each sentence.
    const estimate = estimatedTimings(["Hi.", "Big", "news."]);
    expect(estimate[1].start - estimate[0].end).toBeCloseTo(0.35, 5);
    expect(estimate[2].start).toBe(estimate[1].end);
    // No timings at all: spread over the voice by length (never shown as subtitles).
    const spread = timedScript(["one", "three"], [], 4);
    expect(spread[0].start).toBe(0);
    expect(spread[1].end).toBeLessThanOrEqual(4);
  });

  it("starts every scene in the pause before its first word, on the frame grid, with its key words marked", () => {
    const spec = story({ scenes: said.map((_, n) => scene(n, n === 1 ? { keys: ["gills,", "third"] } : {})) });
    const timing = storyTiming(spec.scenes, words, DURATION);
    expect(timing.frames).toBe(510);
    expect(timing.scenes.map((s) => [s.first, s.startFrame])).toEqual([[0, 0], [7, 84], [24, 240], [33, 333], [42, 414]]);
    // 84 frames = 2.8 s: the middle of the pause from 2.58 s to 3.0 s.
    expect(timing.scenes[1].start).toBeCloseTo(2.8, 5);
    expect(timing.scenes.at(-1)!.endFrame).toBe(510);
    for (const s of timing.scenes) expect(timing.words[s.first].start).toBeGreaterThanOrEqual(s.start - 1e-9);
    // The scene's keys, by their letters, the first match each.
    expect(timing.words.filter((w) => w.emphasis).map((w) => w.text)).toEqual(["gills,", "third"]);
    // Scenes are at least half a second even when edges would crowd.
    const crowded = storyTiming([{ text: "One.", keys: [] }, { text: "Two.", keys: [] }, { text: "Three.", keys: [] }], [{ text: "One.", start: 0, end: 0.1 }, { text: "Two.", start: 0.12, end: 0.2 }, { text: "Three.", start: 0.22, end: 3 }], 3);
    expect(crowded.scenes.map((s) => s.endFrame - s.startFrame).every((n) => n >= 15)).toBe(true);
  });

  it("overlaps the pictures so each transition is centred on its scene edge and the total is the voice", () => {
    const spec = story({ scenes: said.map((_, n) => scene(n, { transition: ["auto", "fade", "cut", "slideup", "auto"][n] })) });
    const timing = storyTiming(spec.scenes, words, DURATION);
    const parts = storySegments(timing, spec.scenes.map((s) => s.transition));
    expect(parts.map((p) => p.transition && [p.transition.kind, p.transition.frames])).toEqual([null, ["fade", 18], null, ["slideup", 12], [AUTO_TRANSITIONS[3], transitionInfo[AUTO_TRANSITIONS[3]].frames]]);
    // Segments less their overlaps are exactly the voice; each starts half its transition before its scene's edge.
    expect(parts.reduce((n, p) => n + p.frames - (p.transition?.frames ?? 0), 0)).toBe(timing.frames);
    parts.forEach((p, k) => {
      expect(p.from + (p.transition?.frames ?? 0) / 2).toBe(timing.scenes[k].startFrame);
      expect(Number.isInteger(p.frames) && Number.isInteger(p.from)).toBe(true);
      const out = parts[k + 1]?.transition?.frames ?? 0;
      expect(p.from + p.frames - out / 2).toBe(timing.scenes[k].endFrame);
    });
    // Every transition is a whole, even number of frames, so half of it falls on each side of its edge.
    for (const k of transitionKinds) expect(transitionInfo[k].frames % 2).toBe(0);
    // "auto" varies along the video; a short scene shortens its transitions (40% of it), a tiny one has none.
    expect(resolveTransition("auto", 1)).toBe(AUTO_TRANSITIONS[0]);
    expect(new Set(Array.from({ length: 8 }, (_, i) => resolveTransition("auto", i + 1))).size).toBeGreaterThan(4);
    const short = storySegments({ words: [], frames: 100, scenes: [{ index: 0, first: 0, last: 0, start: 0, end: 2, startFrame: 0, endFrame: 60 }, { index: 1, first: 1, last: 1, start: 2, end: 100 / 30, startFrame: 60, endFrame: 100 }] }, ["auto", "fadeblack"]);
    expect(short[1].transition).toEqual({ kind: "fadeblack", frames: 16 });
  });
});

describe("timeline edits", () => {
  it("moves edges word by word, splits and merges without changing the script", () => {
    const scenes = story({ scenes: said.map((_, n) => scene(n, { keys: n === 1 ? ["gills,"] : [], imageId: id(n + 1) })) }).scenes;
    const script = storyScript(scenes);
    // Scene 2 now starts at word 5 of the script: four words of sentence 2 go to scene 1... and back.
    const moved = moveEdge(scenes, 1, 7 + 3);
    expect(moved[0].text).toBe(`${said[0][0]} Two hearts pump`);
    expect(moved[1].text).toBe("blood to the gills, while the third one feeds the rest of the body.");
    expect(storyScript(moved)).toBe(script);
    expect(moveEdge(moved, 1, 7)).toEqual(scenes);
    // Never empties a scene; the first scene has no edge before it.
    expect(moveEdge(scenes, 1, 0)[0].text).toBe("Octopuses");
    expect(moveEdge(scenes, 1, 999)[1].text).toBe("body.");
    expect(moveEdge(scenes, 0, 3)).toBe(scenes);
    // A split keeps the picture with the first part; the new scene needs its own; key words follow their words.
    const split = splitScene(scenes, 1, 5);
    expect(split).toHaveLength(6);
    expect([split[1].text, split[2].text]).toEqual(["Two hearts pump blood to", "the gills, while the third one feeds the rest of the body."]);
    expect([split[1].imageId, split[2].imageId, split[1].keys, split[2].keys]).toEqual([id(2), undefined, [], ["gills,"]]);
    expect(storyScript(split)).toBe(script);
    expect(splitScene(scenes, 1, 0)).toBe(scenes);
    expect(mergeScenes(split, 1)[1]).toMatchObject({ text: said[1][0], keys: ["gills,"], imageId: id(2) });
    expect(mergeScenes(scenes, 4)).toBe(scenes);
    // Key words by their letters, on and off.
    expect(toggleKey(scenes[0], "Blood.").keys).toEqual(["Blood"]);
    expect(toggleKey({ ...scenes[0], keys: ["blood"] }, "Blood.").keys).toEqual([]);
  });
});

describe("the format", () => {
  it("validates scenes, sources and the narration", () => {
    expect(story().scenes[0]).toMatchObject({ source: "image", transition: "auto", clipSeconds: 5, keys: [] });
    const bad = (s: Record<string, unknown>) => specSchema.safeParse({ format: "story", narration: { kind: "voice", voiceId: "george" }, scenes: [{ text: "Hello there.", ...s }] }).success;
    expect(bad({ description: "A dog" })).toBe(true);
    expect(bad({ description: "" })).toBe(false); // an AI picture needs a description
    expect(bad({ source: "own" })).toBe(false); // own media needs its file
    expect(bad({ source: "own", assetId: id(1) })).toBe(true);
    expect(bad({ source: "library" })).toBe(false);
    expect(bad({ source: "clip", description: "A dog", clipSeconds: 7 })).toBe(false);
    expect(bad({ description: "A dog", transition: "spin" })).toBe(false);
    expect(specSchema.safeParse({ format: "story", narration: { kind: "upload" }, scenes: [scene(0)] }).success).toBe(false);
    expect(specSchema.safeParse({ format: "story", narration: { kind: "voice", voiceId: "george" }, scenes: Array.from({ length: 41 }, () => scene(0)) }).success).toBe(false);
    expect(story().captions).toEqual({ enabled: true, style: "keyword" });
    expect(story().style).toBe("doodle");
  });

  it("prices the voice, each picture and each clip exactly, and only what is still missing", () => {
    const spec = story({ subject: "a small orange octopus with big eyes", style: "doodle", scenes: [
      scene(0), scene(1, { source: "clip" }), scene(2, { source: "clip", clipSeconds: 10, imageId: id(5) }),
      scene(3, { source: "own", assetId: id(6) }), scene(4, { source: "library", libraryId: id(7) }),
    ] });
    const voice = voiceCredits(storyScript(spec.scenes));
    expect(voice).toBe(2);
    expect(specCredits(spec)).toBe(voice + IMAGE_CREDITS * 2 + CLIP_CREDITS + CLIP_CREDITS * 2);
    // Pictures first, then the clips made from them.
    expect(pendingMedia(spec).map((m) => [m.kind, m.path.join("."), m.key, m.from, m.seconds])).toEqual([
      ["image", "scenes.0", "imageId", undefined, undefined], ["image", "scenes.1", "imageId", undefined, undefined],
      ["clip", "scenes.1", "clipId", "imageId", 5], ["clip", "scenes.2", "clipId", "imageId", 10],
    ]);
    // One subject and one style in every picture prompt.
    expect(pendingMedia(spec)[0].prompt).toBe(scenePrompt("Doodle of sentence 1", spec.subject, "doodle"));
    expect(pendingMedia(spec)[0].prompt).toContain("Recurring main character, the same in every scene: a small orange octopus with big eyes.");
    expect(pendingMedia(spec)[0].prompt).toContain(storyStyles.doodle.prompt);
    // Recorded for these words and this voice: no voice charge; another voice or new words cost it again.
    const recorded = { ...spec, generated: { key: narrationKey("george", storyScript(spec.scenes)), voiceAssetId: id(8), words } };
    expect(narrationCurrent(recorded)).toBe(true);
    expect(specCredits(recorded)).toBe(specCredits(spec) - voice);
    expect(narrationCurrent({ ...recorded, narration: { kind: "voice", voiceId: "aria" } })).toBe(false);
    expect(narrationCurrent({ ...recorded, scenes: recorded.scenes.map((s, n) => (n ? s : { ...s, text: "Octopuses have three hearts." })) })).toBe(false);
    // Moving a scene edge moves words between scenes, not the script: the voice stays paid.
    const moved = recorded.scenes.map((s, n) => (n === 0 ? { ...s, text: `${s.text} ${said[1][0].split(" ")[0]}` } : n === 1 ? { ...s, text: said[1][0].split(" ").slice(1).join(" ") } : s));
    expect(narrationCurrent({ ...recorded, scenes: moved })).toBe(true);
    // An own voiceover is free; made pictures and clips are free.
    const own = { ...spec, narration: { kind: "upload" as const, assetId: id(9), script: "" }, scenes: spec.scenes.map((s) => ({ ...s, imageId: id(10), clipId: id(11) })) };
    expect(specCredits(own)).toBe(0);
    expect(clipFor(4.9)).toBe(5);
    expect(clipFor(7)).toBe(10);
  });

  it("asks the image model for 9:16 pictures and the clip model to start from the scene's picture", () => {
    expect(falRequest("clip", "A doodle octopus waves.", { image: "https://app.test/api/render-inputs/r/0?token=t", seconds: 10 })).toEqual({
      model: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
      body: {
        prompt: "A doodle octopus waves. No text, captions, logos or watermarks in the picture.", duration: "10",
        negative_prompt: "blur, distortion, low quality, text, captions, subtitles, watermark, logo", cfg_scale: 0.5, image_url: "https://app.test/api/render-inputs/r/0?token=t",
      },
    });
    // Without a picture: the text-to-video model, 5 s, as before.
    expect(falRequest("clip", "A wave.")).toMatchObject({ model: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video", body: { duration: "5", aspect_ratio: "9:16" } });
    expect(falRequest("image", "A wave.")).toMatchObject({ model: "fal-ai/nano-banana-2", body: { aspect_ratio: "9:16" } });
    for (const s of storyStyleIds) expect(storyStyles[s].prompt.length).toBeGreaterThan(60);
  });
});

describe("the render plan", () => {
  const ctx = (extra: Partial<PlanContext> = {}): PlanContext => ({
    media: {
      [id(1)]: { key: "media/u/s1.jpg", kind: "image", duration: 0, ai: true },
      [id(2)]: { key: "media/u/s2.jpg", kind: "image", duration: 0, ai: true },
      [id(3)]: { key: "media/u/s2.mp4", kind: "video", duration: 5, ai: true },
      [id(4)]: { key: "media/u/mine.jpg", kind: "image", duration: 0 },
      [id(5)]: { key: "library/clip.mp4", kind: "video", duration: 2 },
      [id(6)]: { key: "media/u/s5.jpg", kind: "image", duration: 0, ai: true },
    },
    narration: { key: "media/u/voice.wav", duration: DURATION, words }, accent: "#112233", watermark: "", ...extra,
  });
  const made = () => story({ scenes: [
    scene(0, { imageId: id(1) }), scene(1, { source: "clip", imageId: id(2), clipId: id(3), transition: "fade" }),
    scene(2, { source: "own", assetId: id(4), transition: "cut" }), scene(3, { source: "library", libraryId: id(5), transition: "circleopen" }),
    scene(4, { imageId: id(6), keys: ["strange"], transition: "zoomin" }),
  ] });

  it("covers the voice exactly, centres every transition on its edge and plays the voice as one track", () => {
    const { compose } = planRender(made(), ctx());
    const at = (key: string) => compose.keys.indexOf(key);
    expect(compose.segments.map((s) => [s.kind, s.input, Math.round(s.duration * FPS), s.transition?.kind ?? null, s.transition ? Math.round(s.transition.duration * FPS) : 0])).toEqual([
      ["image", at("media/u/s1.jpg"), 84 + 9, null, 0],
      ["video", at("media/u/s2.mp4"), 156 + 9, "fade", 18],
      ["image", at("media/u/mine.jpg"), 93 + 8, null, 0],
      ["video", at("library/clip.mp4"), 81 + 8 + 8, "circleopen", 16],
      ["image", at("media/u/s5.jpg"), 96 + 8, "zoomin", 16],
    ]);
    // Whole frames; the segments less their overlaps are the voice's 17 s.
    for (const s of compose.segments) expect(Math.abs(s.duration * FPS - Math.round(s.duration * FPS))).toBeLessThan(1e-6);
    expect(compose.segments.reduce((n, s) => n + Math.round(s.duration * FPS) - Math.round((s.transition?.duration ?? 0) * FPS), 0)).toBe(510);
    // Every picture is silent; the voice is one track from 0 under all of them, music ducked under it.
    expect(compose.segments.every((s) => !s.audio)).toBe(true);
    expect(compose.voice).toEqual({ input: at("media/u/voice.wav"), start: 0, volume: 1 });
    // Stills move, each differently; the AI clip holds its last frame, the short library clip loops.
    expect(compose.segments.filter((s) => s.kind === "image").map((s) => s.motion)).toEqual(["zoom-in", "pan-left", "zoom-in"]); // scenes 1, 3, 5
    expect(compose.segments[1].loop).toBeUndefined();
    expect(compose.segments[3].loop).toBe(true);
    // Subtitles in Title Case with the key word coloured; marked AI-made (AI voice and pictures).
    expect(compose.ass).toContain("Strange");
    expect(compose.ass).toContain("\\1c&H3af5b8&");
    expect(compose.synthetic).toBe(true);
    expect(compose.coverAt).toBeGreaterThan(0.3);
    expect(compose.coverAt).toBeLessThan(2.8);
  });

  it("keeps three minutes of key word subtitles well within the renderer's 2 MB payload", () => {
    const long: CaptionWord[] = Array.from({ length: 480 }, (_, i) => ({ text: ["Octopuses", "have", "three", "hearts.", "Nature", "found", "a", "strange", "answer."][i % 9], start: i * 0.37, end: i * 0.37 + 0.33 }));
    const texts = scenesFromCounts(long, splitScenes(long));
    const spec = story({ scenes: texts.map((text, n) => ({ text, description: "A doodle", imageId: id(1), keys: n % 2 ? ["strange"] : [] })) });
    const { compose } = planRender(spec, ctx({ narration: { key: "media/u/voice.wav", duration: 178, words: long } }));
    expect(compose.segments.length).toBeLessThanOrEqual(STORY_MAX_SCENES);
    expect(compose.segments.reduce((n, s) => n + Math.round(s.duration * FPS) - Math.round((s.transition?.duration ?? 0) * FPS), 0)).toBe(178 * FPS);
    expect(JSON.stringify(compose).length).toBeLessThan(1.5 * 1024 * 1024);
  });

  it("shows no subtitles without real timings, refuses a missing picture and a voice over three minutes", () => {
    const quiet = planRender(made(), ctx({ narration: { key: "media/u/voice.wav", duration: DURATION, words: [] } }));
    expect(quiet.compose.ass).not.toContain("Octopuses");
    expect(quiet.compose.segments).toHaveLength(5);
    const off = planRender({ ...made(), captions: { enabled: false, style: "keyword" } }, ctx());
    expect(off.compose.ass).not.toContain("Octopuses");
    expect(() => planRender(story(), ctx())).toThrow("MEDIA_INPUT"); // pictures not made yet
    expect(() => planRender(made(), ctx({ narration: { key: "v", duration: 181, words } }))).toThrow("MEDIA_TOO_LONG");
    expect(() => planRender(made(), { ...ctx(), narration: undefined })).toThrow("MEDIA_INPUT");
  });
});

describe("the key word subtitles", () => {
  it("writes Title Case, reveals each word as it is said with a small pop, and colours one key word per group", () => {
    const group = [{ text: "fiber-optic", start: 1, end: 1.5, emphasis: true }, { text: "cable", start: 1.5, end: 1.9 }, { text: "into", start: 1.9, end: 2.1 }, { text: "the", start: 2.1, end: 2.2 }, { text: "skull.", start: 2.2, end: 2.8 }];
    const timeline = captionTimeline(styledCaptions(group, "keyword"), 1080, 1920);
    const texts = (t: number) => timeline.find((i) => t >= i.start && t < i.end)!.items.filter((i) => i.kind === "text" && i.layer === 2) as any[];
    expect(texts(1.2).map((i) => i.text)).toEqual(["Fiber-Optic"]);
    expect(texts(2.0).map((i) => [i.text, i.fill])).toEqual([["Fiber-Optic", "#b8f53a"], ["Cable", "#ffffff"], ["Into", "#ffffff"]]);
    // Words keep their place as the others appear; thick black outline, big letters, low in the frame.
    expect(texts(1.2)[0].x).toBe(texts(2.0)[0].x);
    expect(texts(2.0)[0].border).toMatchObject({ color: "#000000" });
    expect(texts(2.0)[0].border.width).toBeGreaterThan(texts(2.0)[0].size * 0.1);
    expect(texts(2.0)[0].y).toBeGreaterThan(1920 * 0.7);
    // A word pops in when said: 70% → 108% → 100% over 0.16 s.
    expect(texts(1.2)[0].anim).toEqual([{ t: 1, scale: 0.7 }, { t: 1.08, scale: 1.08 }, { t: 1.16, scale: 1 }]);
    // Without marks the longest word that is not a little one is the key word.
    expect(keyWordIndex([{ text: "Stop", start: 0, end: 1 }, { text: "scrolling.", start: 1, end: 2 }])).toBe(1);
    expect(keyWordIndex([{ text: "and", start: 0, end: 1 }, { text: "the", start: 1, end: 2 }])).toBe(-1);
    expect(keyWordIndex([{ text: "it's", start: 0, end: 1 }, { text: "big", start: 1, end: 2 }])).toBe(1);
    expect(titleCase("“fiber-optic cable/wire”")).toBe("“Fiber-Optic Cable/Wire”");
    expect(titleCase("don't")).toBe("Don't");
  });
});

describe("forced alignment", () => {
  it("keeps the words of the answer in order, within the recording", () => {
    const answer = { loss: 0.1, characters: [], words: [
      { text: "Hello", start: 0.5, end: 0.9, loss: 0.1 }, { text: " ", start: 0.9, end: 0.9 },
      { text: "there.", start: 0.85, end: 1.4 }, { text: "<b>x", start: 2, end: 2 }, { text: "late", start: 9.5, end: 12 }, { text: 3, start: 1, end: 2 },
    ] };
    expect(alignedWords(answer, 10)).toEqual([
      { text: "Hello", start: 0.5, end: 0.9 }, { text: "there.", start: 0.9, end: 1.4 }, { text: "bx", start: 2, end: 2.02 }, { text: "late", start: 9.5, end: 10 },
    ]);
    expect(alignedWords({ detail: "x" }, 10)).toEqual([]);
  });

  it("sends the recording and the exact script once, as multipart, and turns failures into codes", async () => {
    const seen: any[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      const form = init.body as FormData, file = form.get("file") as File;
      seen.push({ url, method: init.method, key: init.headers["xi-api-key"], redirect: init.redirect, text: form.get("text"), file: [file.name, file.type, file.size] });
      return Response.json({ words: [{ text: "Hi", start: 0.1, end: 0.3 }, { text: "there.", start: 0.3, end: 0.8 }], characters: [], loss: 0.2 });
    });
    const env: any = { ELEVENLABS_API_KEY: " el " };
    expect(await forcedAlignment(env, new Blob([new Uint8Array(100)], { type: "audio/wav" }), "Hi there.", 1)).toEqual([{ text: "Hi", start: 0.1, end: 0.3 }, { text: "there.", start: 0.3, end: 0.8 }]);
    expect(seen).toEqual([{ url: ALIGNMENT_URL, method: "POST", key: "el", redirect: "manual", text: "Hi there.", file: ["recording", "audio/wav", 100] }]);
    expect(ALIGNMENT_URL).toBe("https://api.elevenlabs.io/v1/forced-alignment");
    vi.stubGlobal("fetch", async () => Response.json({ detail: { status: "quota_exceeded" } }, { status: 401 }));
    await expect(forcedAlignment(env, new Blob(["x"]), "Hi", 1)).rejects.toMatchObject({ code: "ALIGN_UNAVAILABLE" });
    vi.stubGlobal("fetch", async () => Response.json({ words: [] }));
    await expect(forcedAlignment(env, new Blob(["x"]), "Hi", 1)).rejects.toMatchObject({ code: "ALIGN_FAILED" });
    await expect(forcedAlignment({} as any, new Blob(["x"]), "Hi", 1)).rejects.toMatchObject({ code: "ALIGN_UNAVAILABLE" });
  });
});

describe("the writer", () => {
  const answer = {
    pattern: "nobody-talks", topic: "Octopus hearts", why: "A strange fact viewers share.", caption: "Nature is weird.", hashtags: ["#ocean", "#facts!!"], title: "Three hearts",
    subject: "a small orange octopus with big round eyes", visualStyle: "doodle", voice: "george", music: "music2",
    scenes: [
      { text: "Octopuses have [excited] three hearts 🐙 and **blue** blood.", picture: "An orange octopus pointing at three hearts", keys: ["hearts", "purple", "blue"] },
      { text: "Two hearts pump blood to the gills.", picture: "x", keys: ["Gills"] },
      { text: "   ", picture: "Nothing", keys: [] },
      { text: "When it swims, the third heart stops.", picture: "The octopus swimming, one heart greyed out", keys: ["stops"] },
    ],
  };

  it("keeps plain spoken scenes, real key words and a picture for each; drops what does not fit", () => {
    const k = acceptStory(answer)!;
    expect(k.scenes).toEqual([
      { text: "Octopuses have three hearts and blue blood.", picture: "An orange octopus pointing at three hearts", keys: ["hearts", "blue"] },
      { text: "Two hearts pump blood to the gills.", picture: "An illustration of: Two hearts pump blood to the gills.", keys: ["gills"] },
      { text: "When it swims, the third heart stops.", picture: "The octopus swimming, one heart greyed out", keys: ["stops"] },
    ]);
    expect(k).toMatchObject({ pattern: "nobody-talks", subject: "a small orange octopus with big round eyes", visualStyle: "doodle", voice: "george", music: "music2" });
    // Over the length, the script ends at the last whole scene that fits; fewer than two is no script.
    expect(acceptStory(answer, 82)!.scenes.map((x) => x.text)).toEqual(["Octopuses have three hearts and blue blood.", "Two hearts pump blood to the gills."]);
    expect(acceptStory(answer, 60)).toBeNull();
    expect(acceptStory({ scenes: "x" })).toBeNull();
  });

  it("turns a script into a narrated video of AI pictures with an AI voice, in the owner's choices", () => {
    const spec = storyToSpec(acceptStory(answer)!, { mention: false, voiceId: "aria", style: "clay", music: { trackId: id(3), volume: 0.25 } })!;
    expect(spec).toMatchObject({
      format: "story", narration: { kind: "voice", voiceId: "aria" }, style: "clay", subject: "a small orange octopus with big round eyes",
      captions: { enabled: true, style: "keyword" }, music: { trackId: id(3), volume: 0.25 }, hashtags: ["#ocean", "#facts"], mention: false,
    });
    expect(spec.scenes.map((s) => [s.source, s.keys])).toEqual([["image", ["hearts", "blue"]], ["image", ["gills"]], ["image", ["stops"]]]);
    expect(storyToSpec(acceptStory(answer)!, { mention: true })!.narration).toEqual({ kind: "voice", voiceId: "george" });
    expect(storyShape(30)).toEqual({ chars: 450, count: 7 });
    expect(storyShape(160).count).toBe(36);
  });

  it("plans pictures by scene ID and is made only with AI credits, AI images and voices", () => {
    expect(acceptScenePlan({ subject: "a fox", scenes: [{ id: "s2", picture: "A fox at night", keys: ["night"] }, { id: "s9", picture: "Nope" }] }, ["Hello.", "It was night."]))
      .toEqual({ subject: "a fox", scenes: [{ description: "", keys: [] }, { description: "A fox at night", keys: ["night"] }] });
    expect(acceptScenePlan({ scenes: [] }, ["Hi."])).toBeNull();
    const c = { images: [], videos: [], clips: [], greens: [], music: [], characters: [] };
    expect(feasible(["story"], c, { aiMedia: true, talking: false, voice: true }, true)).toEqual({ ok: ["story"], missing: {} });
    expect(feasible(["story"], c, { aiMedia: true, talking: false, voice: true }, false).missing.story).toMatch(/AI credits/);
    expect(feasible(["story"], c, { aiMedia: true, talking: false, voice: false }, true).missing.story).toMatch(/aren't available/);
  });
});

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
        if (init.method === "POST") { const p = JSON.parse(init.body); log.push(p); jobs.set(p.id, p); return Response.json({ status: "running" }, { status: 202 }); }
        if (init.method === "DELETE") return Response.json({});
        const job = jobs.get(path[1]);
        if (!job) return new Response("{}", { status: 404 });
        if (path[2] === "file") return new Response(path[3] === "0" ? new Uint8Array(4000).fill(7) : jpeg());
        return Response.json({ status: "completed", duration: DURATION, files: 2 });
      },
    }),
  };
}
/** ElevenLabs character timings of the original text (`alignment`), saying `said`. */
function alignment() {
  const characters: string[] = [], starts: number[] = [], ends: number[] = [];
  said.forEach(([text, start, end], i) => {
    if (i) { characters.push(" "); starts.push(start - 0.1); ends.push(start); }
    const step = (end - start) / text.length;
    [...text].forEach((ch, k) => { characters.push(ch); starts.push(start + k * step); ends.push(start + (k + 1) * step); });
  });
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends };
}
/** ElevenLabs (speech, forced alignment) and fal; `refuseClip` makes the clip model refuse; `timings` false drops them. */
function providers({ refuseClip = false, timings = true } = {}) {
  const calls: { method: string; url: string; body?: any }[] = [];
  let n = 0;
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = String(input?.url ?? input), method = init.method || input?.method || "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).size}`])) : undefined;
    calls.push({ method, url, body });
    if (url === ALIGNMENT_URL) return Response.json({ words: words.map((w) => ({ ...w, loss: 0.1 })), characters: [], loss: 0.1 });
    if (url.includes("api.elevenlabs.io")) return Response.json({ audio_base64: Buffer.from(new Uint8Array(DURATION * 48000)).toString("base64"), ...(timings && { alignment: alignment() }) });
    const fal = url.match(/^https:\/\/queue\.fal\.run\/(.+?)(\/requests\/.*)?$/);
    if (fal && method === "POST") {
      if (refuseClip && fal[1].includes("kling")) return Response.json({ detail: [{ type: "content_policy_violation" }] }, { status: 422 });
      const r = `r${++n}`;
      return Response.json({ request_id: r, status_url: `https://queue.fal.run/${fal[1]}/requests/${r}/status`, response_url: `https://queue.fal.run/${fal[1]}/requests/${r}` });
    }
    if (fal && url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (fal) return Response.json(fal[1].includes("kling") ? { video: { url: "https://v3.fal.media/files/clip.mp4" } } : { images: [{ url: "https://v3.fal.media/files/shot.jpg" }] });
    if (url === "https://v3.fal.media/files/shot.jpg") return new Response(jpeg());
    if (url === "https://v3.fal.media/files/clip.mp4") return new Response(new Uint8Array(3000).fill(2));
    throw new Error("unexpected " + url);
  });
  return calls;
}
const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
async function setup() {
  const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", FAL_KEY: "fal", ELEVENLABS_API_KEY: "el", MEDIA_RENDERER: renderer() });
  const user = signedIn(sqlite);
  subscribe(sqlite, user.id, "starter");
  const w = (await call(worker, env, "POST", "/api/workspaces", { name: "Ocean Facts", timezone: "Europe/Sofia" }, user.cookie)).data.workspace;
  const own = crypto.randomUUID();
  await env.MEDIA.put(`media/${user.id}/${own}.jpg`, jpeg());
  sqlite.prepare("INSERT INTO media_assets(id,user_id,workspace_id,kind,name,object_key,mime,bytes,width,height,status,created_at,updated_at) VALUES (?,?,?,'upload','Reef',?,'image/jpeg',64,1080,1920,'ready',1,1)")
    .run(own, user.id, w.id, `media/${user.id}/${own}.jpg`);
  const spec = story({ subject: "a small orange octopus", scenes: [
    scene(0), scene(1, { source: "clip", transition: "fade" }), scene(2), scene(3, { source: "own", assetId: own }), scene(4, { transition: "circleopen" }),
  ] });
  const used = () => (sqlite.prepare("SELECT used FROM usage_windows WHERE id LIKE ?").get(`${user.id}:sub_%`) as any).used as number;
  const run = async () => { for (const c of env.CONTENT.created.splice(0)) await new ContentGeneration({} as any, env).run({ payload: c.params } as any, step as any); };
  return { env, sqlite, user, w, spec, own, used, run };
}
afterEach(() => vi.unstubAllGlobals());

describe("narrated videos in the content run", () => {
  it("charges the voice, pictures and clip once, makes the clip from its picture, and re-renders for free", async () => {
    const { env, sqlite, user, w, spec, own, used, run } = await setup();
    const calls = providers();
    const price = voiceCredits(storyScript(spec.scenes)) + 4 * IMAGE_CREDITS + CLIP_CREDITS;
    const created = await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    expect(created.data.credits).toBe(price);
    expect(used()).toBe(price);
    await run();
    const submits = () => calls.filter((c) => c.method === "POST" && c.url.startsWith("https://queue.fal.run/"));
    expect(submits().map((c) => c.url.split("/").slice(3).join("/"))).toEqual([
      "fal-ai/nano-banana-2", "fal-ai/nano-banana-2", "fal-ai/nano-banana-2", "fal-ai/nano-banana-2", "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    ]);
    let post = (await call(worker, env, "GET", `/api/posts/${created.data.id}`, undefined, user.cookie)).data.post;
    expect(post.renderStatus).toBe("ready");
    // The clip starts from scene 2's own picture, read through the run's capability link.
    const state = JSON.parse((sqlite.prepare("SELECT provider FROM runs WHERE post_id=?").get(post.id) as any).provider);
    const pictureKey = (sqlite.prepare("SELECT object_key FROM media_assets WHERE id=?").get(post.spec.scenes[1].imageId) as any).object_key;
    expect(submits()[4].body.image_url).toMatch(new RegExp(`/api/render-inputs/[0-9a-f-]{36}/${state.inputs.indexOf(pictureKey)}\\?token=`));
    expect(submits()[0].body.prompt).toContain("a small orange octopus");
    // The voice: spoken once, its words timed as written (no forced alignment needed).
    expect(calls.filter((c) => c.url.includes("api.elevenlabs.io")).map((c) => c.url.split("/")[4])).toEqual(["text-to-speech"]);
    expect(post.spec.generated.words).toHaveLength(words.length);
    expect(post.spec.scenes.map((s: any) => [s.source, !!s.imageId, !!s.clipId, s.assetId === own])).toEqual([
      ["image", true, false, false], ["clip", true, true, false], ["image", true, false, false], ["own", false, false, true], ["image", true, false, false],
    ]);
    // The render: five pictures with transitions, the voice as one track.
    const composes = () => env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose");
    const first = composes().at(-1);
    expect(first.segments.map((s: any) => [s.kind, s.transition?.kind ?? null])).toEqual([["image", null], ["video", "fade"], ["image", AUTO_TRANSITIONS[1]], ["image", AUTO_TRANSITIONS[2]], ["image", "circleopen"]]);
    expect(first.voice).toMatchObject({ start: 0, volume: 1 });
    expect(first.synthetic).toBe(true);
    expect(used()).toBe(price);

    const edit = async (change: (s: any) => any, credits = 0) => {
      const r = await call(worker, env, "PUT", `/api/posts/${post.id}`, { spec: change(post.spec), idempotencyKey: crypto.randomUUID() }, user.cookie);
      expect(r.data).toMatchObject({ rendering: true, credits });
      await run();
      post = (await call(worker, env, "GET", `/api/posts/${post.id}`, undefined, user.cookie)).data.post;
      expect(post.renderStatus).toBe("ready");
      return composes().at(-1);
    };
    // A transition, a scene edge and the subtitle style change: free (the voice and pictures are kept).
    const moved = await edit((s) => ({ ...s, captions: { enabled: true, style: "bold" }, scenes: s.scenes.map((x: any, n: number) => ({
      ...x, transition: n === 2 ? "slideup" : x.transition,
      text: n === 2 ? `${x.text} ${s.scenes[3].text.split(" ")[0]}` : n === 3 ? s.scenes[3].text.split(" ").slice(1).join(" ") : x.text,
    })) }));
    expect(moved.segments[2].transition.kind).toBe("slideup");
    // A new picture for one scene: only that scene is charged and made.
    await edit((s) => ({ ...s, scenes: s.scenes.map((x: any, n: number) => (n === 4 ? { ...x, imageId: undefined, description: "The octopus crawling" } : x)) }), IMAGE_CREDITS);
    expect(submits()).toHaveLength(6);
    expect(calls.filter((c) => c.url.includes("api.elevenlabs.io"))).toHaveLength(1);
    expect(used()).toBe(price + IMAGE_CREDITS);
    // Older pictures were cleaned up; the voice, the pictures, the clip and the latest render stay.
    const left = (sqlite.prepare("SELECT kind FROM media_assets WHERE post_id=? ORDER BY kind").all(post.id) as any[]).map((r) => r.kind);
    expect(left).toEqual(["ai_clip", "ai_image", "ai_image", "ai_image", "ai_image", "render", "slide", "voice"]);
  });

  it("refunds everything once when a clip is refused, before the voice is paid for", async () => {
    const { env, sqlite, user, w, spec, used, run } = await setup();
    const calls = providers({ refuseClip: true });
    const created = await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(used()).toBeGreaterThan(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await run();
    expect(used()).toBe(0);
    const post = (await call(worker, env, "GET", `/api/posts/${created.data.id}`, undefined, user.cookie)).data.post;
    expect(post.renderStatus).toBe("failed");
    expect(post.renderError).toMatch(/content filter.*credits were refunded/);
    expect(calls.some((c) => c.url.includes("elevenlabs"))).toBe(false);
    env.CONTENT.created.push({ params: { runId: (sqlite.prepare("SELECT id FROM runs WHERE post_id=?").get(post.id) as any).id } });
    await run();
    expect(used()).toBe(0);
  });

  it("times a voice without timings by forced alignment of the recording, never paying for the voice twice", async () => {
    const { env, user, w, spec, run } = await setup();
    const calls = providers({ timings: false });
    const simple = { ...spec, scenes: spec.scenes.map((s) => ({ ...s, source: "image" as const, assetId: undefined })) };
    const created = await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec: simple, idempotencyKey: crypto.randomUUID() }, user.cookie);
    await run();
    const post = (await call(worker, env, "GET", `/api/posts/${created.data.id}`, undefined, user.cookie)).data.post;
    expect(post.renderStatus).toBe("ready");
    const eleven = calls.filter((c) => c.url.includes("api.elevenlabs.io"));
    expect(eleven.map((c) => c.url)).toEqual([expect.stringContaining("/text-to-speech/"), ALIGNMENT_URL]);
    expect(eleven[1].body).toEqual({ file: `file:${44 + DURATION * 48000}`, text: storyScript(simple.scenes) });
    expect(post.spec.generated.words[0]).toMatchObject({ text: "Octopuses", start: words[0].start });
    const compose = env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose").at(-1);
    expect(compose.ass).toContain("Octopuses");
  });
});

describe("an owner's voiceover", () => {
  async function upload(env: any, sqlite: any, user: any, meta: Record<string, unknown>, extra: { mime?: string; duration?: number; bytes?: number } = {}) {
    const a = crypto.randomUUID(), key = `media/${user.id}/${a}.wav`;
    await env.MEDIA.put(key, new Uint8Array(extra.bytes ?? 2000));
    sqlite.prepare("INSERT INTO media_assets(id,user_id,kind,name,object_key,mime,bytes,duration,status,meta,created_at,updated_at) VALUES (?,?,'upload','Voiceover',?,?,?,?,'ready',?,1,1)")
      .run(a, user.id, key, extra.mime ?? "audio/wav", extra.bytes ?? 2000, extra.duration ?? DURATION, JSON.stringify(meta));
    return a;
  }

  it("is timed by its transcript, or by forced alignment of the exact script (made once, kept with the file)", async () => {
    const { env, sqlite, user } = await setup();
    const calls = providers();
    const transcript = { hasAudio: true, speech: { status: "found", at: 1 }, transcript: { language: "eng", words: words.map((w) => ({ ...w, text: w.text.toLowerCase() })) } };
    const a = await upload(env, sqlite, user, transcript);
    const plain = await call(worker, env, "POST", "/api/story/timing", { assetId: a }, user.cookie);
    expect(plain.status).toBe(200);
    expect(plain.data).toMatchObject({ source: "transcript", speech: "found", duration: DURATION });
    expect(plain.data.words[0].text).toBe("octopuses");
    const script = said.map((s) => s[0]).join("\n\n");
    const aligned = await call(worker, env, "POST", "/api/story/timing", { assetId: a, script }, user.cookie);
    expect(aligned.data.source).toBe("script");
    expect(aligned.data.words[0].text).toBe("Octopuses");
    // Sent once as its plain words; asked again, the stored alignment answers; the list of files never carries it.
    expect(calls.filter((c) => c.url === ALIGNMENT_URL).map((c) => c.body.text)).toEqual([said.map((s) => s[0]).join(" ")]);
    expect((await call(worker, env, "POST", "/api/story/timing", { assetId: a, script: ` ${script} ` }, user.cookie)).data.source).toBe("script");
    expect(calls.filter((c) => c.url === ALIGNMENT_URL)).toHaveLength(1);
    const listed = (await call(worker, env, "GET", "/api/media?type=audio", undefined, user.cookie)).data.assets.find((x: any) => x.id === a);
    expect(JSON.stringify(listed)).not.toContain("alignment");
    // Too long for a video, no sound, someone else's file.
    const long = await upload(env, sqlite, user, { hasAudio: true }, { duration: 200 });
    expect((await call(worker, env, "POST", "/api/story/timing", { assetId: long }, user.cookie)).status).toBe(400);
    const mute = await upload(env, sqlite, user, { hasAudio: false });
    expect((await call(worker, env, "POST", "/api/story/timing", { assetId: mute }, user.cookie)).status).toBe(400);
    const other = signedIn(sqlite);
    expect((await call(worker, env, "POST", "/api/story/timing", { assetId: a }, other.cookie)).status).toBe(404);
  });

  it("renders on the recording's clock with its words, free, and refuses a voiceover that is not one", async () => {
    const { env, sqlite, user, w, run, used } = await setup();
    providers();
    const a = await upload(env, sqlite, user, { hasAudio: true, speech: { status: "found", at: 1 }, transcript: { language: "eng", words } });
    const own = (sqlite.prepare("SELECT id FROM media_assets WHERE name='Reef'").get() as any).id;
    const spec = story({ narration: { kind: "upload", assetId: a }, scenes: said.map((_, n) => scene(n, { source: "own", assetId: own })) });
    const created = await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.data.credits).toBe(0);
    await run();
    expect(used()).toBe(0);
    const compose = env.MEDIA_RENDERER.log.filter((p: any) => p.operation === "compose").at(-1);
    expect(compose.segments).toHaveLength(5);
    expect(compose.voice).toMatchObject({ start: 0, volume: 1 });
    expect(compose.synthetic).toBe(false);
    const image = (sqlite.prepare("SELECT id FROM media_assets WHERE name='Reef'").get() as any).id;
    const bad = story({ narration: { kind: "upload", assetId: image }, scenes: [scene(0, { source: "own", assetId: own })] });
    expect((await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec: bad, idempotencyKey: crypto.randomUUID() }, user.cookie)).status).toBe(400);
  });
});

describe("planning and writing through the API", () => {
  const answer = (value: unknown) => ({ status: "completed", output_text: JSON.stringify(value) });

  it("describes pictures for scenes that have their words, and writes a narrated video for Create", async () => {
    const { env, user, w } = await setup();
    const seen: any[] = [];
    env.AI.run = async (_model: string, input: any) => {
      seen.push(input);
      if (input.instructions.includes("You plan the pictures"))
        return answer({ subject: "an octopus", scenes: said.map((s, n) => ({ id: `s${n + 1}`, picture: `Picture ${n + 1} of the octopus`, keys: [s[0].split(" ")[1]] })) });
      return answer({
        pattern: "nobody-talks", topic: "Octopus hearts", why: "Strange facts are shared.", caption: "Nature is weird.", hashtags: ["#ocean"], title: "Three hearts",
        subject: "an octopus", visualStyle: "watercolor", voice: "george", music: "",
        scenes: said.map((s, n) => ({ text: s[0], picture: `Picture ${n + 1}`, keys: [] })),
      });
    };
    const plan = await call(worker, env, "POST", "/api/story/plan", { workspaceId: w.id, texts: said.map((s) => s[0]), style: "doodle" }, user.cookie);
    expect(plan.status).toBe(200);
    expect(plan.data.scenes[0]).toEqual({ description: "Picture 1 of the octopus", keys: ["have"] });
    expect(JSON.parse(seen[0].input).scenes[0]).toEqual({ id: "s1", text: said[0][0] });
    const ideas = await call(worker, env, "POST", `/api/workspaces/${w.id}/ideas`, { count: 1, formats: ["story"], useCredits: true, prompt: "octopus facts", story: { seconds: 20, voiceId: "aria", style: "doodle" } }, user.cookie);
    expect(ideas.status).toBe(200);
    const spec = ideas.data.specs[0];
    expect(spec).toMatchObject({ format: "story", narration: { kind: "voice", voiceId: "aria" }, style: "doodle", subject: "an octopus" });
    expect(spec.scenes).toHaveLength(5);
    expect(seen[1].instructions).toMatch(/about 20 seconds of speech, about 300 characters in all, split into exactly 4 scenes/);
    expect(JSON.parse(seen[1].input).ownerRequest).toBe("octopus facts");
    // Without AI credits a narrated video cannot be written.
    expect((await call(worker, env, "POST", `/api/workspaces/${w.id}/ideas`, { count: 1, formats: ["story"], useCredits: false }, user.cookie)).status).toBe(400);
  });
});
