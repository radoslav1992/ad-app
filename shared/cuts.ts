import type { CaptionWord } from "./captions";
import { clipWords } from "./speech";

// Instant cuts for talking clips (ported from rech-bg's "Мигновен монтаж"): which parts of a recording to keep, from
// its word timings. Shared by the editor's preview and the render plan, so both cut at exactly the same places.
export type KeepRange = [number, number];
export type CutOptions = {
  /** Silences longer than this (seconds) are shortened to a natural gap. */
  maxPause: number;
  /** Remove hesitation sounds such as "um", "uh", "erm". */
  fillers: boolean;
};
export const defaultCutOptions: CutOptions = { maxPause: 0.6, fillers: true };
/** The most parts the renderer joins in one clip. */
export const MAX_KEEP_RANGES = 300;
const PAD_BEFORE = 0.12, PAD_AFTER = 0.2;
const round = (n: number) => Math.round(n * 1000) / 1000;
const FPS = 30;
const frame = (n: number) => Math.round((n / FPS) * 1e6) / 1e6;

/**
 * English and Bulgarian hesitation sounds (the whole word, ignoring punctuation and case). Single vowels are real
 * words in some languages, so only drawn-out ones count.
 */
export function isFiller(text: string) {
  const w = text.toLowerCase().replace(/[^\p{L}]/gu, "");
  return /^(ъ+[мх]*|м+|а{2,}м*|ам{2,}|е{2,}м*|ем{2,}|ерм+|хм+|ъхъ|u+h*m+|u+h+|e+r+m*|h+m+)$/u.test(w);
}

/**
 * Ranges of the recording to keep: speech without long pauses (and without fillers), with a little air around each
 * phrase. Without words (no speech found) the whole clip is kept.
 */
export function autoCuts(words: CaptionWord[], duration: number, options: CutOptions = defaultCutOptions): KeepRange[] {
  const kept = words.filter((w) => w.end > w.start && w.start < duration && !(options.fillers && isFiller(w.text)));
  if (!kept.length) return [[0, round(duration)]];
  const ranges: KeepRange[] = [];
  let start = Math.max(0, kept[0].start - PAD_BEFORE), end = kept[0].end;
  for (const w of kept.slice(1)) {
    if (w.start - end > options.maxPause) {
      ranges.push([round(start), round(Math.min(duration, end + PAD_AFTER))]);
      start = Math.max(0, w.start - PAD_BEFORE);
    }
    end = Math.max(end, w.end);
  }
  ranges.push([round(start), round(Math.min(duration, end + PAD_AFTER))]);
  // Too many parts to render: allow longer pauses rather than dropping the end of the clip.
  if (ranges.length > MAX_KEEP_RANGES) return autoCuts(words, duration, { ...options, maxPause: options.maxPause * 1.5 + 0.1 });
  return normalizeKeep(ranges, duration);
}

/** Sorted, merged, within the clip and not too many — the form the renderer accepts. */
export function normalizeKeep(ranges: KeepRange[], duration: number): KeepRange[] {
  const sorted = ranges
    .map(([a, b]) => [Math.max(0, a), Math.min(duration, b)] as KeepRange)
    .filter(([a, b]) => b - a >= 0.1)
    .sort((x, y) => x[0] - y[0]);
  const merged: KeepRange[] = [];
  for (const [a, b] of sorted) {
    const last = merged.at(-1);
    if (last && a <= last[1] + 0.05) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  // On the 1/30 s frame grid, so the render keeps exactly as much picture as sound in every part.
  return merged.slice(0, MAX_KEEP_RANGES).map(([a, b]) => [frame(Math.floor(a * FPS + 1e-6)), Math.min(round(duration), frame(Math.ceil(b * FPS - 1e-6)))]);
}

export const keptDuration = (keep: KeepRange[] | null, duration: number) =>
  round(keep ? keep.reduce((sum, [a, b]) => sum + (b - a), 0) : duration);

/**
 * The parts to keep of the window [start, start + length) of a longer recording, on the window's own clock (0 =
 * `start`): the cuts of a hook & demo's demo or of a clip's moment.
 */
export function windowCuts(words: CaptionWord[], start: number, length: number, options: CutOptions = defaultCutOptions): KeepRange[] {
  return autoCuts(clipWords(words, start, length, 0), length, options);
}

/** Source time → time in the cut clip, or null when that moment was cut out. */
export function toCutTime(t: number, keep: KeepRange[] | null) {
  if (!keep) return t;
  let offset = 0;
  for (const [a, b] of keep) {
    if (t < a) return null;
    if (t <= b) return offset + (t - a);
    offset += b - a;
  }
  return null;
}
/** Time in the cut clip → source time (for seeking the video element in the preview). */
export function toSourceTime(t: number, keep: KeepRange[] | null) {
  if (!keep) return t;
  let offset = 0;
  for (const [a, b] of keep) {
    if (t < offset + (b - a)) return a + (t - offset);
    offset += b - a;
  }
  return keep.length ? keep.at(-1)![1] : t;
}
/** Caption words of the source moved onto the cut clip's clock; words that were cut out, even partly, are dropped. */
export function cutWords(words: CaptionWord[], keep: KeepRange[] | null): CaptionWord[] {
  if (!keep) return words;
  const out: CaptionWord[] = [];
  for (const w of words) {
    const start = toCutTime(w.start, keep), end = toCutTime(w.end, keep);
    // A word that a cut runs through (e.g. a removed "um" touching the next phrase) is dropped.
    if (start === null || end === null || end <= start || end - start < w.end - w.start - 0.01) continue;
    out.push({ ...w, start: round(start), end: round(end) });
  }
  return out;
}
