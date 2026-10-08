import { z } from "zod";
import { captionStyles, type CaptionStyle } from "./captions";
import { textLookSchema, defaultLook } from "./overlay";
import { CLIP_CREDITS, IMAGE_CREDITS, avatarCredits, speechSeconds, talkingCredits, voiceCredits, type AvatarKind } from "./credits";

// The post formats and the editable description ("spec") of a post. A spec references media by ID (the owner's
// uploads and website images, the shared library, characters) or asks for AI media with a prompt. The server owns
// everything under `generated` (voices, avatar videos, word timings): an edit from the browser never sets it.

export const formatIds = ["slideshow", "text", "hook_demo", "green_screen", "ugc"] as const;
export type FormatId = (typeof formatIds)[number];
export const formats: Record<FormatId, { name: string; short: string; description: string; ai: boolean }> = {
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
  /** The demo: an uploaded video, from `start` for `seconds`. */
  demo: z.object({ assetId: uuid, start: z.number().min(0).max(600).default(0), seconds: z.number().min(2).max(45).default(12) }),
  demoText: screen(200).default(""),
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
export const specSchema = z.discriminatedUnion("format", [slideshowSpec, textSpec, hookDemoSpec, greenScreenSpec, ugcSpec]);
export type Spec = z.infer<typeof specSchema>;
export type SlideshowSpec = z.infer<typeof slideshowSpec>;
export type TextSpec = z.infer<typeof textSpec>;
export type UgcSpec = z.infer<typeof ugcSpec>;
export type HookDemoSpec = z.infer<typeof hookDemoSpec>;
export type GreenScreenSpec = z.infer<typeof greenScreenSpec>;

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

/** Every AI image or clip the spec still asks for (a prompt without its asset), with where it goes. */
export function pendingMedia(spec: Spec): { kind: "image" | "clip"; prompt: string; path: (string | number)[] }[] {
  const out: { kind: "image" | "clip"; prompt: string; path: (string | number)[] }[] = [];
  if (spec.format === "slideshow")
    spec.slides.forEach((s, i) => { if (!s.image.assetId && !s.image.color && s.image.prompt) out.push({ kind: "image", prompt: s.image.prompt, path: ["slides", i, "image"] }); });
  if (spec.format === "text" && !spec.background.assetId && !spec.background.libraryId && !spec.background.color && spec.background.prompt)
    out.push({ kind: spec.background.clip ? "clip" : "image", prompt: spec.background.prompt, path: ["background"] });
  if (spec.format === "green_screen" && !spec.background.assetId && !spec.background.color && spec.background.prompt)
    out.push({ kind: "image", prompt: spec.background.prompt, path: ["background"] });
  return out;
}
/**
 * Credits to make a spec ready: AI media it still asks for, and a talking recording when it has none for its
 * current words. `characterKind` tells library characters from people's own (they cost more per second).
 */
export function specCredits(spec: Spec, characterKind: AvatarKind = "library") {
  let credits = pendingMedia(spec).reduce((n, m) => n + (m.kind === "clip" ? CLIP_CREDITS : IMAGE_CREDITS), 0);
  const t = talking(spec);
  if (t && !recordingCurrent(spec)) credits += talkingCredits(t.text, characterKind);
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
  }
}
/** All of the owner's media asset IDs a spec references, for ownership checks. */
export function referencedAssets(spec: Spec): string[] {
  const ids: (string | undefined)[] = [];
  if (spec.format === "slideshow") ids.push(...spec.slides.map((s) => s.image.assetId));
  if (spec.format === "text" || spec.format === "green_screen") ids.push(spec.background.assetId);
  if (spec.format === "hook_demo") ids.push(spec.demo.assetId);
  if (spec.music?.assetId) ids.push(spec.music.assetId);
  return [...new Set(ids.filter((x): x is string => !!x))];
}
/** Library items a spec references. */
export function referencedLibrary(spec: Spec): string[] {
  const ids: (string | undefined)[] = [spec.music?.trackId];
  if (spec.format === "text") ids.push(spec.background.libraryId);
  if (spec.format === "hook_demo" && "libraryId" in spec.hookClip) ids.push(spec.hookClip.libraryId);
  if (spec.format === "green_screen") ids.push(spec.clipId);
  return [...new Set(ids.filter((x): x is string => !!x))];
}
/** The hook shown in lists and on the swipe card. */
export function specHook(spec: Spec) {
  if (spec.format === "slideshow") return spec.slides[0]?.text || "";
  if (spec.format === "ugc") return spec.hook || spec.script.split(/(?<=[.!?])\s/)[0] || "";
  if (spec.format === "text" || spec.format === "green_screen") return spec.text.split("\n")[0];
  return spec.hook;
}
/** The parts of a spec that change the picture or sound; edits elsewhere (caption, hashtags) need no new render. */
export function visualPart(spec: Spec) {
  const { caption: _c, hashtags: _h, title: _t, pattern: _p, topic: _o, why: _w, mention: _m, ...rest } = spec as Spec & Record<string, unknown>;
  return JSON.stringify(rest);
}
