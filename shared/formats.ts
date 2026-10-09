import { z } from "zod";
import { captionStyles, type CaptionStyle } from "./captions";
import { textLookSchema, defaultLook } from "./overlay";
import { CLIP_CREDITS, CLIP_SECONDS, IMAGE_CREDITS, avatarCredits, speechSeconds, talkingCredits, voiceCredits, type AvatarKind } from "./credits";
import { brollAssets, brollLibrary, brollPending, brollSchema } from "./broll";
import {
  clipPrompt, narrationKey, narrationSchema, scenePrompt, storySceneSchema, storyScript, storyStyleIds, STORY_MAX_CHARS, STORY_MAX_SCENES, type StoryStyle,
} from "./story";
import { trackSchema } from "./track";
import { LONG_VIDEO_SECONDS } from "./speech";

// The post formats and the editable description ("spec") of a post. A spec references media by ID (the owner's
// uploads and website images, the shared library, characters) or asks for AI media with a prompt. The server owns
// everything under `generated` (voices, avatar videos, word timings): an edit from the browser never sets it.

/** The formats the writer makes (Blitz batches, automations, manual drafts). */
export const formatIds = ["slideshow", "text", "hook_demo", "green_screen", "ugc", "story"] as const;
export type FormatId = (typeof formatIds)[number];
/** Every post format: the written ones, and clips cut from a long video (the Clips page, server/shorts.ts). */
export const postFormatIds = [...formatIds, "clip"] as const;
export type PostFormatId = (typeof postFormatIds)[number];
export const formats: Record<PostFormatId, { name: string; short: string; description: string; ai: boolean }> = {
  slideshow: {
    name: "Slideshow",
    short: "Photo carousel",
    description: "Swipeable photos with bold text. Posts as a TikTok photo post or an Instagram carousel, or as a video.",
    ai: false,
  },
  text: {
    name: "Wall of Text",
    short: "Text over a clip",
    description: "A short clip — a reaction, a moment, b-roll — with your thought written over it.",
    ai: false,
  },
  hook_demo: {
    name: "Video Hook & Demo",
    short: "Reaction, then product",
    description: "A three-second hook that stops the scroll, then your product demo with a caption.",
    ai: false,
  },
  green_screen: {
    name: "Green Screen Meme",
    short: "Creator over a picture",
    description: "A reacting creator keyed over your screenshot or picture, with meme text.",
    ai: false,
  },
  ugc: {
    name: "AI UGC",
    short: "Talking creator",
    description: "An AI creator talks about your product straight to camera, with word-by-word captions.",
    ai: true,
  },
  story: {
    name: "Narrated Video",
    short: "Voiceover with pictures",
    description: "An AI voiceover or your own, with a new picture for every sentence in one style, smooth transitions and big word-by-word subtitles.",
    ai: true,
  },
  clip: {
    name: "Clip",
    short: "From a long video",
    description: "The strongest moment of your podcast, webinar or demo call: framed on the speaker, with animated captions.",
    ai: false,
  },
};

const uuid = z.uuid();
const prompt = z.string().trim().min(3).max(400);
const hex = z.string().regex(/^#[0-9a-f]{6}$/i);
/**
 * A picture: an existing image (`assetId`), a plain colour, or an AI image from `prompt` (filled in with its asset
 * once made). The first one set wins in that order.
 */
export const imageRefSchema = z
  .object({ assetId: uuid.optional(), color: hex.optional(), prompt: prompt.optional() })
  .refine((r) => r.assetId || r.color || r.prompt, "Choose an image or describe one.");
export type ImageRef = z.infer<typeof imageRefSchema>;
/** A background: an own image/video, a library clip, a colour, an AI image or an AI clip (`clip`), in that order. */
export const backgroundSchema = z
  .object({ assetId: uuid.optional(), libraryId: uuid.optional(), color: hex.optional(), prompt: prompt.optional(), clip: z.boolean().optional() })
  .refine((r) => r.assetId || r.libraryId || r.color || r.prompt, "Choose a background or describe one.");
export type Background = z.infer<typeof backgroundSchema>;
/** A library track or an own upload (audio), at a volume. */
export const musicSchema = z
  .object({ trackId: uuid.optional(), assetId: uuid.optional(), volume: z.number().min(0).max(1).default(0.35) })
  .refine((m) => !!m.trackId !== !!m.assetId, "Choose one track.")
  .nullable()
  .default(null);
export type Music = z.infer<typeof musicSchema>;

const screen = (max: number) => z.string().trim().max(max);
const hashtag = z.string().trim().regex(/^#?[\p{L}\p{N}_]{1,60}$/u).transform((t) => (t.startsWith("#") ? t : `#${t}`));
const look = textLookSchema.default(defaultLook());
const common = {
  /** Post text (TikTok description, Instagram caption, YouTube description, LinkedIn commentary). */
  caption: z.string().trim().max(2200).default(""),
  hashtags: z.array(hashtag).max(15).default([]),
  /** YouTube title. */
  title: z.string().trim().max(100).default(""),
  /** The hook pattern the idea is built on (shared/hooks.ts). */
  pattern: z.string().max(40).optional(),
  /** Short topic label shown on the card, e.g. "AI service pricing". */
  topic: z.string().trim().max(60).default(""),
  /** Why this post should work for the brand (shown under "Why this content?"). */
  why: z.string().trim().max(400).default(""),
  /** Whether the post names the brand, or is pure value content. */
  mention: z.boolean().default(true),
};
const generatedVoice = z.object({
  /** What the voice and video were made from; a change asks for a new (paid) recording. */
  key: z.string().max(200),
  voiceAssetId: uuid.optional(),
  videoAssetId: uuid.optional(),
  words: z.array(z.object({ text: z.string().max(80), start: z.number(), end: z.number() })).max(2000).default([]),
});
export type Generated = z.infer<typeof generatedVoice>;

/**
 * Subtitles from the speech in an uploaded clip (transcribed when it was uploaded, shared/speech.ts): off unless
 * switched on, and the caption style they use. Posts made before subtitles existed have them off.
 */
export const subtitlesSchema = z
  .object({ enabled: z.boolean().default(false), style: z.enum(captionStyles).default("classic" satisfies CaptionStyle) })
  .default({ enabled: false, style: "classic" });
export type Subtitles = z.infer<typeof subtitlesSchema>;
/**
 * Instant cuts of a talking clip (shared/cuts.ts): long pauses, and filler sounds with `fillers`, are cut out where the
 * transcript shows them. Off unless switched on; posts made before cuts existed have none.
 */
export const cutsSchema = z
  .object({ enabled: z.boolean().default(false), fillers: z.boolean().default(true) })
  .default({ enabled: false, fillers: true });
export type Cuts = z.infer<typeof cutsSchema>;

export const slideSchema = z.object({ text: screen(300), image: imageRefSchema });
export const slideshowSpec = z.object({
  format: z.literal("slideshow"),
  slides: z.array(slideSchema).min(2).max(10),
  look,
  secondsPerSlide: z.number().min(1.5).max(6).default(3),
  music: musicSchema,
  ...common,
});
export const textSpec = z.object({
  format: z.literal("text"),
  /** The wall of text (or a short hook). */
  text: screen(600).min(1),
  background: backgroundSchema,
  /** Keep the background clip's own sound. */
  clipAudio: z.boolean().default(false),
  /** Subtitles of the background clip's speech (an own upload, with its sound kept). */
  subtitles: subtitlesSchema,
  look,
  seconds: z.number().min(4).max(30).default(8),
  music: musicSchema,
  ...common,
});
export const ugcSpec = z.object({
  format: z.literal("ugc"),
  characterId: uuid,
  voiceId: z.string().min(1).max(40),
  /** What the creator says (spoken; plain text). */
  script: z.string().trim().min(20).max(900),
  /** On-screen title for the first seconds (optional). */
  hook: screen(140).default(""),
  hookLook: textLookSchema.default({ ...defaultLook(), position: "top" }),
  captionStyle: z.enum(captionStyles).default("bold" satisfies CaptionStyle),
  music: musicSchema,
  /** AI B-roll: shots cut in over chosen sentences while the voice goes on (shared/broll.ts). */
  broll: brollSchema.optional(),
  generated: generatedVoice.optional(),
  ...common,
});
export const hookClipSchema = z.union([
  z.object({ libraryId: uuid }),
  z.object({ characterId: uuid, voiceId: z.string().min(1).max(40), line: z.string().trim().min(3).max(200) }),
]);
export const hookDemoSpec = z.object({
  format: z.literal("hook_demo"),
  /** On-screen hook over the reaction. */
  hook: screen(200).min(1),
  hookClip: hookClipSchema,
  /** The demo: an uploaded video, from `start` for `seconds` (before cuts). */
  demo: z.object({ assetId: uuid, start: z.number().min(0).max(LONG_VIDEO_SECONDS).default(0), seconds: z.number().min(2).max(45).default(12) }),
  demoText: screen(200).default(""),
  /** Subtitles of what is said in the demo (the part of it that is used). */
  subtitles: subtitlesSchema,
  /** Pauses (and fillers) cut out of a talking demo. */
  cuts: cutsSchema,
  look,
  music: musicSchema,
  generated: generatedVoice.optional(),
  ...common,
});
export const greenScreenSpec = z.object({
  format: z.literal("green_screen"),
  text: screen(300).min(1),
  /** The picture behind the creator: a screenshot, product photo or AI image. */
  background: imageRefSchema,
  /** A green-screen clip from the library. */
  clipId: uuid,
  clipAudio: z.boolean().default(false),
  look: textLookSchema.default({ ...defaultLook(), position: "top" }),
  seconds: z.number().min(3).max(20).default(7),
  music: musicSchema,
  ...common,
});
/** A clip's moment lasts 5–90 seconds of its video (the Clips page suggests 15–60). */
export const CLIP_MIN_SECONDS = 5, CLIP_MAX_SECONDS = 90;
/** Seconds the hook title of a clip stays on screen. */
export const CLIP_TITLE_SECONDS = 3;
export const clipSpec = z.object({
  format: z.literal("clip"),
  /** The moment: seconds `start` to `end` of an uploaded (long) video. */
  source: z.object({ assetId: uuid, start: z.number().min(0).max(LONG_VIDEO_SECONDS), end: z.number().min(0).max(LONG_VIDEO_SECONDS) })
    .refine((s) => s.end - s.start >= CLIP_MIN_SECONDS - 0.01 && s.end - s.start <= CLIP_MAX_SECONDS + 0.01, `A clip lasts ${CLIP_MIN_SECONDS} to ${CLIP_MAX_SECONDS} seconds.`),
  cuts: cutsSchema,
  /** Keep the speaker in the middle of a wider video (face tracking); off, or no face found: the centre. */
  follow: z.boolean().default(true),
  /** Captions of what is said (the video's transcript), in one of the twenty styles. */
  captions: z.object({ enabled: z.boolean().default(true), style: z.enum(captionStyles).default("bold" satisfies CaptionStyle) }).default({ enabled: true, style: "bold" }),
  /** On-screen title for the first seconds (optional). */
  hook: screen(140).default(""),
  hookLook: textLookSchema.default({ ...defaultLook(), position: "top" }),
  music: musicSchema,
  /** Server-owned: where the speaker is in this moment (measured when it is made), for `key` = trackKey. */
  tracked: z.object({ key: z.string().max(200), track: trackSchema }).optional(),
  ...common,
});
/**
 * A narrated video (shared/story.ts): the voiceover, its scenes (words, picture, transition) in one picture style with
 * one recurring subject, and subtitles over the whole voice. `generated` is the AI voice once recorded.
 */
export const storySpec = z.object({
  format: z.literal("story"),
  narration: narrationSchema,
  scenes: z.array(storySceneSchema).min(1).max(STORY_MAX_SCENES)
    .refine((scenes) => storyScript(scenes).length <= STORY_MAX_CHARS * 2, "The script is too long for one video."),
  style: z.enum(storyStyleIds as [StoryStyle, ...StoryStyle[]]).default("doodle"),
  /** One description of the recurring subject or character, repeated in every scene's picture prompt. */
  subject: z.string().trim().max(300).default(""),
  captions: z.object({ enabled: z.boolean().default(true), style: z.enum(captionStyles).default("keyword" satisfies CaptionStyle) }).default({ enabled: true, style: "keyword" }),
  music: musicSchema,
  generated: generatedVoice.optional(),
  ...common,
});
export const specSchema = z.discriminatedUnion("format", [slideshowSpec, textSpec, hookDemoSpec, greenScreenSpec, ugcSpec, storySpec, clipSpec]);
export type Spec = z.infer<typeof specSchema>;
export type SlideshowSpec = z.infer<typeof slideshowSpec>;
export type TextSpec = z.infer<typeof textSpec>;
export type UgcSpec = z.infer<typeof ugcSpec>;
export type HookDemoSpec = z.infer<typeof hookDemoSpec>;
export type GreenScreenSpec = z.infer<typeof greenScreenSpec>;
export type ClipSpec = z.infer<typeof clipSpec>;
export type StorySpec = z.infer<typeof storySpec>;
/** The AI voice of a narrated video is recorded for its current words and voice (no new recording is paid). */
export function narrationCurrent(spec: StorySpec) {
  return spec.narration.kind === "voice" && !!spec.generated?.voiceAssetId && spec.generated.key === narrationKey(spec.narration.voiceId, storyScript(spec.scenes));
}
/** The moment a clip's speaker path was measured for: a new moment needs a new measurement. */
export const trackKey = (spec: ClipSpec) => `${spec.source.assetId}:${spec.source.start}:${spec.source.end}`;

/** The hook clip of a hook + demo is at most this long; the demo follows it. */
export const HOOK_CLIP_MAX_SECONDS = 6;

/** The text that identifies a talking recording: same character, voice and words = same paid recording. */
export const recordingKey = (characterId: string, voiceId: string, text: string) => `${characterId}:${voiceId}:${text.trim()}`.slice(0, 200);
/** The talking part of a spec, if any: who says what. */
export function talking(spec: Spec): { characterId: string; voiceId: string; text: string } | null {
  if (spec.format === "ugc") return { characterId: spec.characterId, voiceId: spec.voiceId, text: spec.script };
  if (spec.format === "hook_demo" && "characterId" in spec.hookClip)
    return { characterId: spec.hookClip.characterId, voiceId: spec.hookClip.voiceId, text: spec.hookClip.line };
  return null;
}
/** The talking recording still matches the spec (no new voice or video is needed). */
export function recordingCurrent(spec: Spec) {
  const t = talking(spec);
  if (!t || !("generated" in spec) || !spec.generated?.videoAssetId) return false;
  return spec.generated.key === recordingKey(t.characterId, t.voiceId, t.text);
}

/**
 * An AI image or clip to make: its asset goes to `key` (default "assetId") of the object at `path`. A clip `from` an
 * image is made from the asset in that field of the same object (made earlier in the same run); `seconds`: its length.
 */
export type PendingMedia = { kind: "image" | "clip"; prompt: string; path: (string | number)[]; key?: string; from?: string; seconds?: 5 | 10 };
/** Every AI image or clip the spec still asks for (a prompt without its asset), with where it goes. */
export function pendingMedia(spec: Spec): PendingMedia[] {
  const out: PendingMedia[] = [];
  if (spec.format === "slideshow")
    spec.slides.forEach((s, i) => { if (!s.image.assetId && !s.image.color && s.image.prompt) out.push({ kind: "image", prompt: s.image.prompt, path: ["slides", i, "image"] }); });
  if (spec.format === "text" && !spec.background.assetId && !spec.background.libraryId && !spec.background.color && spec.background.prompt)
    out.push({ kind: spec.background.clip ? "clip" : "image", prompt: spec.background.prompt, path: ["background"] });
  if (spec.format === "green_screen" && !spec.background.assetId && !spec.background.color && spec.background.prompt)
    out.push({ kind: "image", prompt: spec.background.prompt, path: ["background"] });
  if (spec.format === "ugc") for (const m of brollPending(spec.broll, spec.script)) out.push({ kind: m.kind, prompt: m.prompt, path: ["broll", "shots", m.index] });
  if (spec.format === "story") {
    // Every picture first, then the clips made from them.
    spec.scenes.forEach((s, i) => {
      if ((s.source === "image" || s.source === "clip") && !s.imageId)
        out.push({ kind: "image", prompt: scenePrompt(s.description, spec.subject, spec.style), path: ["scenes", i], key: "imageId" });
    });
    spec.scenes.forEach((s, i) => {
      if (s.source === "clip" && !s.clipId) out.push({ kind: "clip", prompt: clipPrompt(s.description), path: ["scenes", i], key: "clipId", from: "imageId", seconds: s.clipSeconds });
    });
  }
  return out;
}
/**
 * Credits to make a spec ready: AI media it still asks for, and a talking recording when it has none for its
 * current words. `characterKind` tells library characters from people's own (they cost more per second).
 */
export function specCredits(spec: Spec, characterKind: AvatarKind = "library") {
  let credits = pendingMedia(spec).reduce((n, m) => n + (m.kind === "clip" ? CLIP_CREDITS * ((m.seconds ?? CLIP_SECONDS) / CLIP_SECONDS) : IMAGE_CREDITS), 0);
  const t = talking(spec);
  if (t && !recordingCurrent(spec)) credits += talkingCredits(t.text, characterKind);
  if (spec.format === "story" && spec.narration.kind === "voice" && !narrationCurrent(spec)) credits += voiceCredits(storyScript(spec.scenes));
  return credits;
}
export { voiceCredits, avatarCredits, speechSeconds };

/** Rough length of the finished video in seconds (the real one is known after rendering). */
export function estimatedSeconds(spec: Spec) {
  switch (spec.format) {
    case "slideshow": return spec.slides.length * spec.secondsPerSlide;
    case "text": case "green_screen": return spec.seconds;
    case "ugc": return speechSeconds(spec.script) + 0.5;
    case "hook_demo": return Math.min(HOOK_CLIP_MAX_SECONDS, "line" in spec.hookClip ? speechSeconds(spec.hookClip.line) : 3) + spec.demo.seconds;
    case "clip": return spec.source.end - spec.source.start;
    case "story": return narrationCurrent(spec) && spec.generated?.words.length ? spec.generated.words.at(-1)!.end + 0.3 : speechSeconds(storyScript(spec.scenes)) + 0.5;
  }
}
/** All of the owner's media asset IDs a spec references, for ownership checks. */
export function referencedAssets(spec: Spec): string[] {
  const ids: (string | undefined)[] = [];
  if (spec.format === "slideshow") ids.push(...spec.slides.map((s) => s.image.assetId));
  if (spec.format === "text" || spec.format === "green_screen") ids.push(spec.background.assetId);
  if (spec.format === "hook_demo") ids.push(spec.demo.assetId);
  if (spec.format === "ugc") ids.push(...brollAssets(spec.broll));
  if (spec.format === "clip") ids.push(spec.source.assetId);
  if (spec.format === "story") {
    if (spec.narration.kind === "upload") ids.push(spec.narration.assetId);
    for (const s of spec.scenes) ids.push(s.imageId, s.clipId, s.assetId);
  }
  if (spec.music?.assetId) ids.push(spec.music.assetId);
  return [...new Set(ids.filter((x): x is string => !!x))];
}
/** Library items a spec references. */
export function referencedLibrary(spec: Spec): string[] {
  const ids: (string | undefined)[] = [spec.music?.trackId];
  if (spec.format === "text") ids.push(spec.background.libraryId);
  if (spec.format === "hook_demo" && "libraryId" in spec.hookClip) ids.push(spec.hookClip.libraryId);
  if (spec.format === "green_screen") ids.push(spec.clipId);
  if (spec.format === "ugc") ids.push(...brollLibrary(spec.broll));
  if (spec.format === "story") ids.push(...spec.scenes.map((s) => s.libraryId));
  return [...new Set(ids.filter((x): x is string => !!x))];
}
/** The hook shown in lists and on the swipe card. */
export function specHook(spec: Spec) {
  if (spec.format === "slideshow") return spec.slides[0]?.text || "";
  if (spec.format === "ugc") return spec.hook || spec.script.split(/(?<=[.!?])\s/)[0] || "";
  if (spec.format === "clip") return spec.hook || spec.topic || "Clip";
  if (spec.format === "story") return storyScript(spec.scenes).split(/(?<=[.!?])\s/)[0] || spec.topic || "";
  if (spec.format === "text" || spec.format === "green_screen") return spec.text.split("\n")[0];
  return spec.hook;
}
/** The parts of a spec that change the picture or sound; edits elsewhere (caption, hashtags) need no new render. */
export function visualPart(spec: Spec) {
  const { caption: _c, hashtags: _h, title: _t, pattern: _p, topic: _o, why: _w, mention: _m, ...rest } = spec as Spec & Record<string, unknown>;
  return JSON.stringify(rest);
}
