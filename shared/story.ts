import { z } from "zod";
import { CLIP_CREDITS, CLIP_SECONDS, IMAGE_CREDITS, SPEECH_CHARS_PER_SECOND, voiceCredits } from "./credits";
import type { CaptionWord } from "./captions";

// Narrated Video ("story"): a voiceover (an AI voice reading a script, or the owner's own recording) laid out on its own
// clock and split into scenes of one or two sentences; each scene shows a picture in one shared style (an AI image
// that moves slowly, an AI clip made from that image, the owner's media or a library clip), with a transition at every
// scene boundary and word-by-word subtitles over the whole voice. Scenes hold their words, never times: times come from
// the voice's word timings (ElevenLabs, forced alignment or the transcript), so a scene edge is always on a word
// boundary. The script writer and the scene splitter are ported from rech-bg (server/studio-writer.ts, "Студио").

/** The render's cap (renderer/server.py MAX_OUTPUT). */
export const STORY_MAX_SECONDS = 180;
/** A picture per scene: one input and one segment each (renderer MAX_SEGMENTS). */
export const STORY_MAX_SCENES = 40;
/** The AI voice's script: about 160 s of speech. */
export const STORY_MAX_CHARS = 2400;
/** Scenes are one or two sentences, about 2–8 seconds; the splitter aims for TARGET. */
export const SCENE_MIN_SECONDS = 2, SCENE_MAX_SECONDS = 8, SCENE_TARGET_SECONDS = 4.5;
/** A scene is never shorter than the renderer's shortest segment (0.5 s). */
const MIN_SCENE_FRAMES = 15;
export const FPS = 30;
/** Lengths the writer offers (seconds of speech, with their names); automations make short ones (30 s). */
export const storyLengths: readonly [number, string][] = [[20, "20 seconds"], [30, "30 seconds"], [45, "45 seconds"], [60, "1 minute"], [90, "1½ minutes"], [120, "2 minutes"], [160, "2 min 40 s"]];

/**
 * Picture styles: one suffix for every scene's image prompt, so the whole video looks drawn by one hand. The tile is a
 * small drawn sample (src/app/StoryStyles.tsx), never an AI picture.
 */
export const storyStyles = {
  doodle: {
    name: "Doodle", short: "Hand-drawn cartoon",
    prompt: "hand-drawn doodle cartoon illustration, bold black ink outlines of even thickness, flat pastel colours (mint, peach, lavender, butter yellow, sky blue), simple shapes, plain light background, friendly expressive faces, no shading or gradients, like a whiteboard explainer sketch",
  },
  watercolor: {
    name: "Watercolor", short: "Soft painted washes",
    prompt: "soft watercolour painting, loose wet-on-wet washes, visible paper texture, gentle bleeding edges, muted harmonious colours, light pencil lines, airy white space",
  },
  clay: {
    name: "3D clay", short: "Claymation figures",
    prompt: "3D claymation scene, soft rounded plasticine figures and objects with visible fingerprints, matte clay materials, warm studio lighting, shallow depth of field, miniature diorama set, bright cheerful colours",
  },
  comic: {
    name: "Comic", short: "Inked, halftone",
    prompt: "comic book illustration, bold ink lines, cel shading, halftone dot texture, saturated primary colours, dynamic framing, dramatic lighting, no speech bubbles or lettering",
  },
  flat: {
    name: "Flat vector", short: "Clean geometric",
    prompt: "flat vector illustration, clean geometric shapes without outlines, limited modern colour palette, subtle grain, simple background, plenty of negative space, explainer-video style",
  },
  cinematic: {
    name: "Cinematic photo", short: "Realistic, filmic",
    prompt: "cinematic photograph, realistic, shot on 35mm film, shallow depth of field, soft natural light, rich colour grading, detailed textures",
  },
  anime: {
    name: "Anime", short: "Cel-shaded drawing",
    prompt: "anime illustration, clean cel-shaded line art, expressive characters, vibrant colours, painterly sky and background detail, soft lighting, modern Japanese animated film look (no existing characters)",
  },
} as const;
export type StoryStyle = keyof typeof storyStyles;
export const storyStyleIds = Object.keys(storyStyles) as StoryStyle[];

/**
 * Transitions at scene boundaries (FFmpeg xfade in the render; CSS in the preview), each a whole, even number of frames
 * so it is centred on its boundary: half before, half after.
 */
export const transitionKinds = ["fade", "fadeblack", "dissolve", "slideleft", "slideup", "wipeleft", "smoothleft", "circleopen", "zoomin"] as const;
export type TransitionKind = (typeof transitionKinds)[number];
export const transitionInfo: Record<TransitionKind, { name: string; frames: number }> = {
  fade: { name: "Fade", frames: 18 },
  fadeblack: { name: "Fade through black", frames: 20 },
  dissolve: { name: "Dissolve", frames: 18 },
  slideleft: { name: "Slide left", frames: 12 },
  slideup: { name: "Slide up", frames: 12 },
  wipeleft: { name: "Wipe", frames: 14 },
  smoothleft: { name: "Soft wipe", frames: 14 },
  circleopen: { name: "Circle", frames: 16 },
  zoomin: { name: "Zoom", frames: 16 },
};
/** A scene's way in: "auto" (a varied, calm sequence), "cut" (none) or one transition. */
export const storyTransitions = ["auto", "cut", ...transitionKinds] as const;
export type StoryTransition = (typeof storyTransitions)[number];
/**
 * What "auto" uses, boundary after boundary: mostly soft, with an occasional livelier one. Not "zoomin" (halfway it
 * fills the frame with the middle of the old picture: one flat colour on a simple drawing) nor "dissolve" (grainy).
 */
export const AUTO_TRANSITIONS: TransitionKind[] = ["fade", "smoothleft", "slideup", "fade", "circleopen", "smoothleft", "fade", "slideleft", "fadeblack"];
/** The transition into scene `index` (≥ 1). */
export const resolveTransition = (choice: StoryTransition, index: number): TransitionKind | null =>
  choice === "cut" ? null : choice === "auto" ? AUTO_TRANSITIONS[(index - 1) % AUTO_TRANSITIONS.length] : choice;

/** Where a scene's picture comes from. */
export const sceneSources = ["image", "clip", "own", "library"] as const;
export type SceneSource = (typeof sceneSources)[number];
/** AI clips are made in these lengths (seconds; the clip model makes 5 or 10). */
export const clipLengths = [5, 10] as const;

const uuid = z.uuid();
export const storySceneSchema = z
  .object({
    /** The words said in this scene (one or two sentences), as written or as transcribed. */
    text: z.string().trim().min(1).max(600),
    /** What the picture shows (the AI prompt; a note for own media). */
    description: z.string().trim().max(300).default(""),
    /** The scene's key words (copied from its text), shown in the accent colour by the "keyword" caption style. */
    keys: z.array(z.string().trim().min(1).max(60)).max(8).default([]),
    source: z.enum(sceneSources).default("image"),
    /** The AI picture made for the scene (also the first frame of its AI clip). */
    imageId: uuid.optional(),
    /** The AI clip made from that picture. */
    clipId: uuid.optional(),
    clipSeconds: z.union([z.literal(5), z.literal(10)]).default(5),
    /** Own media (an image or a video). */
    assetId: uuid.optional(),
    /** A clip from the shared library. */
    libraryId: uuid.optional(),
    transition: z.enum(storyTransitions).default("auto"),
  })
  .refine((s) => s.source !== "own" || !!s.assetId, "Choose a picture or video for each scene with your own media.")
  .refine((s) => s.source !== "library" || !!s.libraryId, "Choose a library clip for each scene that uses one.")
  .refine((s) => !["image", "clip"].includes(s.source) || s.description.length >= 3 || !!s.imageId, "Describe the picture of each AI scene.");
export type StoryScene = z.infer<typeof storySceneSchema>;
/** The voiceover: an AI voice reading the scenes, or the owner's recording (audio or video) and, optionally, its exact script. */
export const narrationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("voice"), voiceId: z.string().min(1).max(40) }),
  z.object({
    kind: z.literal("upload"), assetId: uuid,
    /** The exact words said, to time them by forced alignment; empty: the recording's transcript. */
    script: z.string().trim().max(STORY_MAX_CHARS * 2).default(""),
  }),
]);
export type Narration = z.infer<typeof narrationSchema>;

const ENDS = /[.!?…]["'»”’)]*$/;
const PAUSE_PUNCT = /[,;:—–-]["'»”’)]*$/;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Letters and digits only, lower case: how words are compared. */
export const normWord = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** A text's spoken words (single spaces). */
export const textWords = (text: string) => text.split(/\s+/).filter(Boolean);
/** Scene text made plain: one line, single spaces, no markup or brackets (they would be read out or break captions). */
export const plainText = (text: string, max = 600) =>
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<[^>]*>/g, "").replace(/[<>{}[\]*#_~]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
/** The script an owner gives for their recording, as it is aligned: its plain words, single spaces. */
export const alignedScriptText = (script: string) => textWords(plainText(script, STORY_MAX_CHARS * 2)).join(" ");
/** What the AI voice reads: the scenes in order. */
export const storyScript = (scenes: Pick<StoryScene, "text">[]) => scenes.map((s) => textWords(s.text).join(" ")).join(" ");

/** A short, stable fingerprint of a text (cyrb53): the voice is paid again only when its script changes. */
export function fingerprint(text: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** Same voice and the same words: the same paid recording. */
export const narrationKey = (voiceId: string, script: string) => `story:${voiceId}:${script.length}:${fingerprint(script)}`;

/**
 * The script's words with times. By position when the voice has as many words; else matched by their letters, and a
 * word said differently (a number read out, a dash) gets the time between its neighbours. Never longer than `duration`.
 */
export function timedScript(written: string[], said: CaptionWord[], duration: number): CaptionWord[] {
  if (!written.length) return [];
  const end = duration > 0 ? duration : said.at(-1)?.end ?? written.length * 0.4;
  if (said.length === written.length) return written.map((text, i) => ({ text, start: said[i].start, end: Math.min(end, said[i].end) }));
  const hit: (CaptionWord | null)[] = written.map(() => null);
  let j = 0;
  written.forEach((w, i) => {
    const target = normWord(w);
    if (!target) return;
    for (let k = j; k < Math.min(said.length, j + 8); k++) if (normWord(said[k].text) === target) { hit[i] = said[k]; j = k + 1; return; }
  });
  // Words not found share the time between the found ones around them (by their length).
  const out: CaptionWord[] = [];
  for (let i = 0; i < written.length;) {
    if (hit[i]) { out.push({ text: written[i], start: hit[i]!.start, end: Math.min(end, hit[i]!.end) }); i++; continue; }
    let k = i;
    while (k < written.length && !hit[k]) k++;
    const from = out.at(-1)?.end ?? (said[0]?.start ?? 0), to = k < written.length ? hit[k]!.start : end;
    const weights = written.slice(i, k).map((w) => w.length + 1), sum = weights.reduce((a, b) => a + b, 0);
    let t = from;
    for (let n = i; n < k; n++) {
      const d = ((to - from) * weights[n - i]) / sum;
      out.push({ text: written[n], start: round2(t), end: round2(Math.max(t, t + d - 0.02)) });
      t += d;
    }
    i = k;
  }
  return out;
}
/** Rough word timings of a script before it is recorded (SPEECH_CHARS_PER_SECOND, a pause after each sentence). */
export function estimatedTimings(words: string[]): CaptionWord[] {
  const out: CaptionWord[] = [];
  let t = 0.2;
  for (const text of words) {
    const length = (text.length + 1) / SPEECH_CHARS_PER_SECOND;
    out.push({ text, start: round2(t), end: round2(t + length) });
    t += length + (ENDS.test(text) ? 0.35 : 0);
  }
  return out;
}

/**
 * Scenes from timed words (rech-bg's scene split, on the voice's clock): sentences, a long one split at a comma or at
 * its longest pause, then joined into scenes of one or two sentences of about 2–8 s, at most STORY_MAX_SCENES. Returns
 * how many words each scene has (always ≥ 1, summing to the words).
 */
export function splitScenes(words: CaptionWord[], maxScenes = STORY_MAX_SCENES): number[] {
  if (!words.length) return [];
  const span = (a: number, b: number) => words[b].end - words[a].start;
  // Sentences as [first, last] word ranges.
  let pieces: [number, number][] = [];
  let first = 0;
  words.forEach((w, i) => { if (ENDS.test(w.text) || i === words.length - 1) { pieces.push([first, i]); first = i + 1; } });
  // A sentence longer than the longest scene is split where the speaker pauses: a comma near the middle, else the
  // longest gap between words.
  const splitLong = (a: number, b: number): [number, number][] => {
    if (b <= a || span(a, b) <= SCENE_MAX_SECONDS) return [[a, b]];
    const mid = (words[a].start + words[b].end) / 2;
    let best = -1, score = -Infinity;
    for (let i = a; i < b; i++) {
      const gap = words[i + 1].start - words[i].end, distance = Math.abs(words[i].end - mid) / Math.max(1, span(a, b));
      const s = (PAUSE_PUNCT.test(words[i].text) ? 1 : 0) + gap * 2 - distance * 1.5;
      if (s > score) { score = s; best = i; }
    }
    return [...splitLong(a, best), ...splitLong(best + 1, b)];
  };
  pieces = pieces.flatMap(([a, b]) => splitLong(a, b));
  // Joined greedily: a scene takes the next piece when it is under the minimum, or when it is one sentence under the
  // target and joining brings it closer to the target; never beyond the longest scene. The shortest scene allowed
  // grows with a long voice (at most maxScenes).
  const total = words.at(-1)!.end - words[0].start;
  const shortest = Math.max(SCENE_MIN_SECONDS, total / maxScenes);
  const join = (min: number, target: number) => {
    const scenes: [number, number, number][] = [];
    for (const [a, b] of pieces) {
      const last = scenes.at(-1), now = last ? span(last[0], last[1]) : 0, joined = last ? span(last[0], b) : 0;
      if (last && joined <= Math.max(SCENE_MAX_SECONDS, min * 2) && (now < min || (last[2] < 2 && now < target && Math.abs(joined - target) < Math.abs(now - target)))) {
        last[1] = b; last[2]++;
      } else scenes.push([a, b, 1]);
    }
    // A last scene that is too short joins the one before it.
    if (scenes.length > 1 && span(scenes.at(-1)![0], scenes.at(-1)![1]) < min) { const l = scenes.pop()!; scenes.at(-1)![1] = l[1]; }
    return scenes;
  };
  let scenes = join(shortest, Math.max(SCENE_TARGET_SECONDS, shortest));
  for (let grow = 1.25; scenes.length > maxScenes && grow < 20; grow *= 1.25) scenes = join(shortest * grow, Math.max(SCENE_TARGET_SECONDS, shortest) * grow);
  while (scenes.length > maxScenes) { const l = scenes.pop()!; scenes.at(-1)![1] = l[1]; }
  return scenes.map(([a, b]) => b - a + 1);
}
/** Scene texts from timed words and word counts per scene. */
export const scenesFromCounts = (words: CaptionWord[], counts: number[]) => {
  let at = 0;
  return counts.map((n) => { const text = words.slice(at, at + n).map((w) => w.text).join(" "); at += n; return text; });
};

export type TimedScene = { index: number; first: number; last: number; start: number; end: number; startFrame: number; endFrame: number };
export type StoryTiming = {
  /** The script's words on the voice's clock, with each scene's key words marked. */
  words: CaptionWord[];
  /** Frames of the whole video (the voice's length on the frame grid). */
  frames: number;
  scenes: TimedScene[];
};
/**
 * Every scene on the voice's clock. A scene starts in the middle of the pause before its first word, on the frame grid
 * (the first one at 0) and lasts until the next one starts (the last one until the end of the voice). Each lasts at
 * least half a second: edges are pushed apart where words come too fast.
 */
export function storyTiming(scenes: Pick<StoryScene, "text" | "keys">[], said: CaptionWord[], duration: number): StoryTiming {
  const counts = scenes.map((s) => textWords(s.text).length);
  const written = scenes.flatMap((s) => textWords(s.text));
  const words = timedScript(written, said, duration);
  const frames = Math.max(1, Math.round(duration * FPS));
  // Key words: the first word of the scene that matches each key.
  let at = 0;
  for (const [n, s] of scenes.entries()) {
    const keys = new Set(s.keys.map(normWord).filter(Boolean));
    for (let i = at; i < at + counts[n] && keys.size; i++) {
      const k = normWord(words[i].text);
      if (keys.has(k)) { words[i] = { ...words[i], emphasis: true }; keys.delete(k); }
    }
    at += counts[n];
  }
  const firsts: number[] = [];
  at = 0;
  for (const n of counts) { firsts.push(at); at += n; }
  const edges = firsts.map((f, k) => {
    if (k === 0) return 0;
    const before = words[f - 1], next = words[f];
    return Math.round(((before.end + next.start) / 2) * FPS);
  });
  edges.push(frames);
  // At least MIN_SCENE_FRAMES each: forward, then back from the end.
  for (let k = 1; k < edges.length - 1; k++) edges[k] = Math.max(edges[k], edges[k - 1] + MIN_SCENE_FRAMES);
  for (let k = edges.length - 2; k >= 1; k--) edges[k] = Math.min(edges[k], edges[k + 1] - MIN_SCENE_FRAMES);
  // Too many scenes for the time: edges never cross (storySegments leaves the squeezed scenes out).
  for (let k = 1; k < edges.length - 1; k++) edges[k] = Math.min(frames, Math.max(0, edges[k - 1], edges[k]));
  return {
    words, frames,
    scenes: counts.map((n, k) => ({
      index: k, first: firsts[k], last: firsts[k] + n - 1,
      startFrame: edges[k], endFrame: edges[k + 1], start: edges[k] / FPS, end: edges[k + 1] / FPS,
    })),
  };
}

export type StorySegment = {
  /** The scene's index in the spec. */
  scene: number;
  /** Output frame where the segment's picture starts (its transition in starts here) and how many frames it shows. */
  from: number; frames: number;
  /** The transition into it: centred on the scene's start; `frames` of overlap with the segment before. */
  transition: { kind: TransitionKind; frames: number } | null;
};
/**
 * The pictures as overlapping segments (the renderer's compose with transitions): each segment covers its scene plus
 * half of each transition next to it, so a transition of T frames runs from T/2 before its boundary to T/2 after it,
 * and the segments' frames less the overlaps add up to the voice's length exactly. A transition is shortened to fit
 * 40% of the shorter scene beside it (and left out when that is under 4 frames).
 */
export function storySegments(timing: StoryTiming, transitions: StoryTransition[]): StorySegment[] {
  // A scene squeezed under the shortest segment (too many scenes for the time) is left out: the one before it lasts on.
  const kept = timing.scenes.filter((s, k) => k === 0 || s.endFrame - s.startFrame >= MIN_SCENE_FRAMES);
  const scenes = kept.map((s, k) => ({ ...s, endFrame: kept[k + 1]?.startFrame ?? timing.frames }));
  const lengths = scenes.map((s) => s.endFrame - s.startFrame);
  const overlap = scenes.map((s, k) => {
    const kind = k ? resolveTransition(transitions[s.index] ?? "auto", s.index) : null;
    if (!kind) return null;
    const room = Math.floor((Math.min(lengths[k - 1], lengths[k]) * 0.4) / 2) * 2;
    const frames = Math.min(transitionInfo[kind].frames, room);
    return frames >= 4 ? { kind, frames } : null;
  });
  return scenes.map((s, k) => {
    const into = overlap[k]?.frames ?? 0, out = overlap[k + 1]?.frames ?? 0;
    return { scene: s.index, from: s.startFrame - into / 2, frames: lengths[k] + into / 2 + out / 2, transition: overlap[k] };
  });
}

// Edits of the timeline (the editor's): they only move words between scenes, so the script and its paid recording stay.
const words = (s: Pick<StoryScene, "text">) => textWords(s.text);
/** Keys that still are words of the text. */
const keysIn = (text: string, keys: string[]) => keys.filter((k) => textWords(text).some((w) => normWord(w) === normWord(k)));
/**
 * Moves the edge before scene `k` so that scene `k` starts at word `first` of the whole script (scene k-1 and k keep at
 * least one word each); the script itself is unchanged, so a recorded voice stays paid.
 */
export function moveEdge(scenes: StoryScene[], k: number, first: number): StoryScene[] {
  if (k < 1 || k >= scenes.length) return scenes;
  const before = scenes.slice(0, k - 1).reduce((n, s) => n + words(s).length, 0);
  const pair = [...words(scenes[k - 1]), ...words(scenes[k])];
  const cut = Math.min(pair.length - 1, Math.max(1, first - before));
  const a = pair.slice(0, cut).join(" "), b = pair.slice(cut).join(" ");
  if (a === scenes[k - 1].text && b === scenes[k].text) return scenes;
  return scenes.map((s, i) => (i === k - 1 ? { ...s, text: a, keys: keysIn(a, s.keys) } : i === k ? { ...s, text: b, keys: keysIn(b, s.keys) } : s));
}
/** Splits scene `k` before its word `at` (≥ 1): the new scene keeps the look and needs its own picture. */
export function splitScene(scenes: StoryScene[], k: number, at: number): StoryScene[] {
  const w = words(scenes[k]);
  if (at < 1 || at >= w.length) return scenes;
  const s = scenes[k], a = w.slice(0, at).join(" "), b = w.slice(at).join(" ");
  const second: StoryScene = { ...s, text: b, keys: keysIn(b, s.keys), imageId: undefined, clipId: undefined, transition: "auto" };
  return [...scenes.slice(0, k), { ...s, text: a, keys: keysIn(a, s.keys) }, second, ...scenes.slice(k + 1)];
}
/** Joins scene `k` with the next one: their words, the first one's picture. */
export function mergeScenes(scenes: StoryScene[], k: number): StoryScene[] {
  if (k < 0 || k >= scenes.length - 1) return scenes;
  const a = scenes[k], b = scenes[k + 1];
  return [...scenes.slice(0, k), { ...a, text: `${a.text} ${b.text}`, keys: [...a.keys, ...b.keys.filter((x) => !a.keys.some((y) => normWord(y) === normWord(x)))].slice(0, 8) }, ...scenes.slice(k + 2)];
}
/** Marks or unmarks a word of a scene as a key word (shown in the accent colour). */
export function toggleKey(scene: StoryScene, word: string): StoryScene {
  const w = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").slice(0, 60);
  if (!w) return scene;
  const on = scene.keys.some((k) => normWord(k) === normWord(w));
  return { ...scene, keys: on ? scene.keys.filter((k) => normWord(k) !== normWord(w)) : [...scene.keys, w].slice(0, 8) };
}
/** The description sent to the image model: the scene, the recurring subject, the style; calm space low for subtitles. */
export function scenePrompt(description: string, subject: string, style: StoryStyle) {
  const who = subject.trim() ? ` Recurring main character, the same in every scene: ${subject.trim().replace(/[.!?]$/, "")}.` : "";
  return `${description.trim().replace(/([^.!?])$/, "$1.")}${who} Style: ${storyStyles[style].prompt}. Vertical 9:16 frame, main subject in the upper two thirds, the bottom third calm and simple.`.slice(0, 1000);
}
/** The description sent to the clip model with the scene's picture: gentle motion, the picture kept as it is. */
export const clipPrompt = (description: string) =>
  `${description.trim().replace(/([^.!?])$/, "$1.")} Gentle natural motion of the subject and one slow camera move; keep the drawing style, characters and colours exactly as in the image.`.slice(0, 900);

/** What a scene still costs: its AI picture (if not made) and its AI clip (if not made). */
export function sceneCredits(scene: Pick<StoryScene, "source" | "imageId" | "clipId" | "clipSeconds">) {
  if (scene.source !== "image" && scene.source !== "clip") return 0;
  return (scene.imageId ? 0 : IMAGE_CREDITS) + (scene.source === "clip" && !scene.clipId ? CLIP_CREDITS * (scene.clipSeconds / CLIP_SECONDS) : 0);
}
/** The AI voice's price for a script (it is paid again only for new words or another voice). */
export const narrationCredits = (script: string) => voiceCredits(script);
/** The clip length that covers a scene of `seconds` (5 s, else 10 s). */
export const clipFor = (seconds: number): 5 | 10 => (seconds <= 5.2 ? 5 : 10);
