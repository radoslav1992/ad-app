import { captionAss, emptyAss, withItems, withWatermark } from "./caption-ass";
import { captionPresets, type CaptionDocument } from "../shared/captions";
import { overlayItems, type TextLook } from "../shared/overlay";
import { motionFor } from "../shared/layers";
import { FRAME, type ComposePayload, type ComposeSegment, type StillsPayload } from "../shared/render";
import { HOOK_CLIP_MAX_SECONDS, type Spec } from "../shared/formats";

// A post's spec → renderer payloads. Pure: every referenced file is resolved beforehand (R2 key, length, sound) and
// inputs are R2 keys here; the workflow turns them into capability links. Times are seconds on the output clock.

/** A resolved file: its R2 key, what it is, its length, a green-screen colour, and whether it is AI-made. */
export type Media = { key: string; kind: "image" | "video" | "audio"; duration: number; chroma?: string; ai?: boolean };
export type PlanContext = {
  /** Media by asset ID or library ID. */
  media: Record<string, Media>;
  /** The talking recording's video (and word timings) for UGC and talking hooks. */
  avatar?: { key: string; duration: number; words: { text: string; start: number; end: number }[] };
  accent: string;
  watermark: string;
};
export type Plan = { compose: Omit<ComposePayload, "id" | "urls"> & { keys: string[] }; stills: (Omit<StillsPayload, "id" | "urls"> & { keys: string[] }) | null };

const { width: W, height: H } = FRAME;
const MAX_SECONDS = 180;
const round = (n: number) => Math.round(n * 100) / 100;

class Inputs {
  keys: string[] = [];
  add(key: string) {
    const i = this.keys.indexOf(key);
    if (i >= 0) return i;
    this.keys.push(key);
    return this.keys.length - 1;
  }
}
function need(ctx: PlanContext, id: string | undefined): Media {
  const m = id ? ctx.media[id] : undefined;
  if (!m) throw new Error("MEDIA_INPUT");
  return m;
}
/** A picture reference as a segment: an image (moving slowly), a video, or a plain colour. */
function pictureSegment(ctx: PlanContext, inputs: Inputs, ref: { assetId?: string; libraryId?: string; color?: string }, duration: number, i: number, audio = 0): ComposeSegment[] {
  if (ref.assetId || ref.libraryId) {
    const m = need(ctx, ref.assetId || ref.libraryId);
    if (m.kind === "image") return [{ kind: "image", input: inputs.add(m.key), duration, motion: motionFor(i) }];
    if (m.kind === "video") return fillWithClip(inputs.add(m.key), m.duration, duration, audio);
  }
  return [{ kind: "color", color: ref.color || ctx.accent, duration }];
}
/** A clip repeated (from its start) to fill `duration`: short reaction clips loop instead of freezing. */
function fillWithClip(input: number, clip: number, duration: number, audio: number): ComposeSegment[] {
  const out: ComposeSegment[] = [];
  const length = clip > 0.5 ? clip : duration;
  for (let t = 0; t < duration - 0.05 && out.length < 20; t += length)
    out.push({ kind: "video", input, trim: 0, duration: round(Math.min(length, duration - t)), audio });
  return out;
}
function text(ass: string, value: string, look: TextLook, from: number, to: number) {
  return value.trim() && to > from ? withItems(ass, overlayItems(value, look, W, H), from, to) : ass;
}
function music(ctx: PlanContext, inputs: Inputs, spec: Spec, duck: [number, number][]) {
  const id = spec.music?.trackId || spec.music?.assetId;
  if (!id) return null;
  const m = need(ctx, id);
  return { input: inputs.add(m.key), volume: spec.music!.volume, duck };
}
const total = (segments: ComposeSegment[]) => round(segments.reduce((n, s) => n + s.duration, 0));

export function planRender(spec: Spec, ctx: PlanContext): Plan {
  const inputs = new Inputs();
  let segments: ComposeSegment[] = [], ass = emptyAss(W, H), duck: [number, number][] = [], overlay: ComposePayload["overlay"] = null;
  let stills: Plan["stills"] = null, synthetic = false, coverAt = 0.6;
  switch (spec.format) {
    case "slideshow": {
      const s = spec.secondsPerSlide;
      spec.slides.forEach((slide, i) => {
        segments.push(...pictureSegment(ctx, inputs, slide.image, s, i));
        ass = text(ass, slide.text, spec.look, i * s, (i + 1) * s);
      });
      // The same slides as still pictures, for photo posts (TikTok photo mode, Instagram carousel).
      const stillInputs = new Inputs();
      stills = {
        operation: "stills", width: W, height: H, synthetic,
        slides: spec.slides.map((slide) => {
          const ref = slide.image.assetId ? need(ctx, slide.image.assetId) : null;
          const base = ref && ref.kind === "image" ? { input: stillInputs.add(ref.key) } : { color: slide.image.color || ctx.accent };
          return { ...base, ass: withMark(text(emptyAss(W, H), slide.text, spec.look, 0, 10), ctx) };
        }),
        keys: stillInputs.keys,
      };
      break;
    }
    case "text": {
      segments = pictureSegment(ctx, inputs, spec.background, spec.seconds, 0, spec.clipAudio ? 1 : 0);
      ass = text(ass, spec.text, spec.look, 0, spec.seconds);
      break;
    }
    case "green_screen": {
      segments = pictureSegment(ctx, inputs, spec.background, spec.seconds, 0);
      const clip = need(ctx, spec.clipId);
      overlay = { input: inputs.add(clip.key), start: 0, end: spec.seconds, chroma: clip.chroma || "#00ff00", similarity: 0.3, blend: 0.1, width: 0.95, x: 0.5, y: 1, audio: spec.clipAudio ? 1 : 0 };
      ass = text(ass, spec.text, spec.look, 0, spec.seconds);
      break;
    }
    case "hook_demo": {
      let hook: number;
      if ("libraryId" in spec.hookClip) {
        const clip = need(ctx, spec.hookClip.libraryId);
        hook = round(Math.min(clip.duration || 3, HOOK_CLIP_MAX_SECONDS));
        segments.push({ kind: "video", input: inputs.add(clip.key), trim: 0, duration: hook, audio: 0 });
      } else {
        if (!ctx.avatar) throw new Error("MEDIA_INPUT");
        hook = round(Math.min(ctx.avatar.duration, HOOK_CLIP_MAX_SECONDS + 4));
        segments.push({ kind: "video", input: inputs.add(ctx.avatar.key), trim: 0, duration: hook, audio: 1 });
        duck = [[0, hook]];
        synthetic = true;
      }
      const demo = need(ctx, spec.demo.assetId);
      const start = Math.min(spec.demo.start, Math.max(0, demo.duration - 1));
      const length = round(Math.max(1, Math.min(spec.demo.seconds, demo.duration - start || spec.demo.seconds)));
      segments.push({ kind: "video", input: inputs.add(demo.key), trim: start, duration: length, audio: 0 });
      ass = text(ass, spec.hook, spec.look, 0, hook);
      ass = text(ass, spec.demoText, { ...spec.look, position: "top" }, hook, hook + length);
      coverAt = Math.min(1, hook / 2);
      break;
    }
    case "ugc": {
      if (!ctx.avatar) throw new Error("MEDIA_INPUT");
      const d = round(ctx.avatar.duration);
      segments = [{ kind: "video", input: inputs.add(ctx.avatar.key), trim: 0, duration: d, audio: 1 }];
      const preset = captionPresets.find((p) => p.id === spec.captionStyle);
      const doc: CaptionDocument = {
        words: ctx.avatar.words, style: spec.captionStyle, format: "9:16", position: "bottom", enabled: true,
        uppercase: preset?.uppercase ?? false, resolution: "1080p", accent: preset?.accent,
      };
      ass = ctx.avatar.words.length ? captionAss(doc) : ass;
      ass = text(ass, spec.hook, spec.hookLook, 0, Math.min(3, d));
      duck = [[0, d]];
      synthetic = true;
      coverAt = Math.min(1.2, d / 2);
      break;
    }
  }
  const length = total(segments);
  if (length > MAX_SECONDS) throw new Error("MEDIA_TOO_LONG");
  // Marked as AI-made when any picture or sound in it is (EU AI Act Art. 50, platform AI labels).
  const ai = (keys: string[]) => Object.values(ctx.media).some((m) => m.ai && keys.includes(m.key));
  synthetic = synthetic || ai(inputs.keys);
  if (stills) stills.synthetic = stills.synthetic || ai(stills.keys);
  return {
    compose: {
      operation: "compose", width: W, height: H, segments, voice: null, music: music(ctx, inputs, spec, duck), overlay,
      ass: withMark(ass, ctx), coverAt: Math.min(coverAt, Math.max(0, length - 0.1)), synthetic, keys: inputs.keys,
    },
    stills,
  };
}
const withMark = (ass: string, ctx: PlanContext) => (ctx.watermark ? withWatermark(ass, ctx.watermark, W, H) : ass);
