import { z } from "zod";

// "Follow the speaker" (ported from rech-bg's "Следвай говорещия"): where the 9:16 crop of a wider video sits over
// time, so a vertical clip keeps the speaker in view. The renderer measures it (face tracking, renderer/server.py
// `track`) for the moment a clip uses; it is kept with the post and used by the render and the editor's preview.
// Each point is [t, x]: t in seconds on the video's own clock, x the crop's centre as a share of the video's width.
// Points are keyframes where the crop starts or stops moving; it moves linearly between them and holds before the
// first and after the last. Two points at the same time are a jump (a hard cut in the video). No points: no face was
// found, and the picture stays centred.
export const MAX_TRACK_POINTS = 400;
/** Times go up to the longest video (2 hours) and a little more. */
const MAX_TIME = 7300;
export type TrackPoint = [number, number];
const point = z.tuple([z.number().finite().min(0).max(MAX_TIME), z.number().finite().min(0).max(1)]);
export const trackSchema = z.object({
  v: z.literal(1),
  points: z.array(point).max(MAX_TRACK_POINTS)
    // Time never goes back, and a time holds at most one jump (two points).
    .refine((p) => p.every(([t], i) => i === 0 || (t >= p[i - 1][0] && (i < 2 || t > p[i - 2][0]))), "Invalid track"),
});
export type Track = z.infer<typeof trackSchema>;

/** A stored path (JSON), or null when it is missing or not a valid path. */
export function parseTrack(json: string | null | undefined): Track | null {
  if (!json) return null;
  try {
    const parsed = trackSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The crop's centre (share of the video's width) at time `t`: linear between keyframes, held at the ends. */
export function trackX(points: readonly TrackPoint[] | null | undefined, t: number): number {
  if (!points?.length || !Number.isFinite(t)) return 0.5;
  if (t < points[0][0]) return points[0][1];
  // The last point at or before t (after a jump, the point after it).
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (points[m][0] <= t) lo = m; else hi = m - 1;
  }
  const [a, xa] = points[lo], next = points[lo + 1];
  if (!next) return xa;
  const [b, xb] = next;
  return b > a ? xa + ((xb - xa) * (t - a)) / (b - a) : xb;
}

/**
 * Left edge of a picture `drawnWidth` wide in a frame `frameWidth` wide, placed so that `centre` (share of the
 * picture's width) is in the middle of the frame, without uncovering the frame's sides. The render crops the same
 * window (renderer/server.py `follow_crop`). A picture no wider than the frame stays centred.
 */
export function followLeft(drawnWidth: number, frameWidth: number, centre: number) {
  if (drawnWidth <= frameWidth) return (frameWidth - drawnWidth) / 2;
  return Math.min(0, Math.max(frameWidth - drawnWidth, frameWidth / 2 - centre * drawnWidth));
}

const r2 = (n: number) => Math.round(n * 100) / 100, r3 = (n: number) => Math.round(n * 1000) / 1000;
/**
 * The path over [from, from + length) of the video, on that window's own clock (0 = `from`), as a render segment
 * that starts there reads it: the position at the start, the keyframes inside, the position at the end.
 */
export function trackWindow(points: readonly TrackPoint[] | null | undefined, from: number, length: number): TrackPoint[] {
  if (!points?.length) return [];
  // The 1/100 s grid of the stored points stays a grid, so no two keyframes merge into a third point at one time.
  const at = r2(from), end = r2(length);
  const inside = points.map(([t, x]) => [r2(t - at), x] as TrackPoint).filter(([t]) => t > 0 && t < end).slice(0, MAX_TRACK_POINTS - 2);
  return [[0, r3(trackX(points, from))], ...inside, [end, r3(trackX(points, from + length - 1e-6))]];
}
