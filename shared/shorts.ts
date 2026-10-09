import type { CaptionStyle } from "./captions";

// Clips from a long video (ported from rech-bg's "Кратки клипове"): the moments the writer finds in a transcribed
// video (server/shorts.ts), and the clip post each chosen moment becomes.

/** A moment: seconds `start` to `end` of the video, a hook title, why it works, and the post text it would go with. */
export type Moment = { title: string; why: string; caption: string; hashtags: string[]; start: number; end: number; text: string };
/** Moments the writer is asked for last 15–60 seconds; picks a little outside that (sentence edges) are accepted. */
export const MOMENT_MIN_SECONDS = 12, MOMENT_MAX_SECONDS = 75;
/** How many moments one search may ask for. */
export const MOMENT_COUNTS = [3, 5, 8] as const;

/** The choices that apply to every clip made from a video's moments. */
export type ClipOptions = { cuts: boolean; fillers: boolean; follow: boolean; style: CaptionStyle; title: boolean };
export const defaultClipOptions: ClipOptions = { cuts: true, fillers: true, follow: true, style: "bold", title: true };

/** The clip post of a moment (the post schema checks it when it is saved). */
export function momentSpec(assetId: string, m: Moment, o: ClipOptions): Record<string, unknown> {
  return {
    format: "clip",
    source: { assetId, start: m.start, end: m.end },
    cuts: { enabled: o.cuts, fillers: o.fillers },
    follow: o.follow,
    captions: { enabled: true, style: o.style },
    hook: o.title ? m.title : "",
    caption: m.caption,
    hashtags: m.hashtags,
    title: m.title.slice(0, 100),
    topic: "Clip",
    why: m.why,
    mention: false,
    music: null,
  };
}
