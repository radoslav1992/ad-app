import { z } from "zod";
import { CLIP_CREDITS, IMAGE_CREDITS, SPEECH_CHARS_PER_SECOND } from "./credits";
import type { CaptionWord } from "./captions";
import type { ComposeSegment } from "./render";

// AI B-roll for AI UGC posts, ported from rech-bg ("B-roll с AI": server/broll.ts, shared/generate.ts). The text model
// picks the sentences of the script worth showing and describes one shot for each, in one visual style; during each of
// them the picture cuts from the creator to the shot while the voice goes on, then cuts back. A shot names its sentence
// by its words: the times always come from the recording's word timings (never from the model), so they follow the
// voice, and a shot whose sentence is no longer in the script is simply not shown (nor paid for).

/** The creator keeps the opening seconds (the hook) and the last sentence (the call to action). */
export const BROLL_HOOK_SECONDS = 2.5;
/** A cut-away lasts its sentence, 3–5 s (one AI clip is 5 s), and never less than BROLL_SHORTEST. */
export const BROLL_MIN_SECONDS = 3, BROLL_MAX_SECONDS = 5, BROLL_SHORTEST = 2;
/** Cut-aways keep a breath of the creator between them and cover at most this share of the video. */
export const BROLL_GAP_SECONDS = 2, BROLL_MAX_COVER = 0.4;
export const BROLL_MAX_SHOTS = 4;
/** How many shots to aim for: about one per 12 s of video, 2 to 4. */
export const brollTarget = (seconds: number) => Math.min(BROLL_MAX_SHOTS, Math.max(2, Math.round(seconds / 12)));
/** The look shared by all shots when none was given. */
export const DEFAULT_BROLL_STYLE = "natural light, realistic, calm colours";

/** Where a shot's picture comes from: an AI image (moves slowly), an AI clip, or the owner's own media (free). */
export const brollSources = ["image", "clip", "own"] as const;
export type BrollSource = (typeof brollSources)[number];
/** What a shot costs to make; an AI clip of CLIP_SECONDS covers any cut-away. */
export const sourceCredits = (source: BrollSource) => (source === "clip" ? CLIP_CREDITS : source === "image" ? IMAGE_CREDITS : 0);

const uuid = z.uuid();
export const brollShotSchema = z
  .object({
    /** The sentence of the script it shows, as written. */
    sentence: z.string().trim().min(1).max(400),
    /** What the shot shows (the AI prompt; a note for own media). */
    description: z.string().trim().min(3).max(300),
    source: z.enum(brollSources).default("image"),
    /** The picture or clip: made by the run (AI) or chosen (own upload). */
    assetId: uuid.optional(),
    /** A clip from the shared library (own media only). */
    libraryId: uuid.optional(),
  })
  .refine((s) => (s.source === "own" ? !!s.assetId !== !!s.libraryId : !s.libraryId), "Choose a picture or clip for each B-roll shot.");
export const brollSchema = z.object({
  /** Off: rendered without cut-aways; made shots stay with the post, so turning it on again costs nothing. */
  enabled: z.boolean().default(true),
  /** One look for all AI shots, so they seem to come from one shoot. */
  style: z.string().trim().max(200).default(""),
  shots: z.array(brollShotSchema).max(BROLL_MAX_SHOTS),
});
export type BrollShot = z.infer<typeof brollShotSchema>;
export type Broll = z.infer<typeof brollSchema>;

const FPS = 30; // renderer/server.py: cuts on the frame grid keep the creator's lips on the voice's clock
const frame = (t: number) => Math.round(t * FPS) / FPS;
const round2 = (n: number) => Math.round(n * 100) / 100;
const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** Model or user text made safe to store and send on: one line, no markup or brackets, bounded. */
export const tidy = (text: string, max: number) =>
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/<[^>]*>/g, "").replace(/[<>{}[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

const ENDS = /[.!?…]["'»”’)]*$/;
/** Words grouped into sentences: a word ending in . ! ? … closes one (40 words at most). */
function grouped<T extends { text: string }>(words: T[]): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  for (const w of words) {
    current.push(w);
    if (ENDS.test(w.text) || current.length >= 40) { out.push(current); current = []; }
  }
  if (current.length) out.push(current);
  return out;
}
/** The script's sentences as spoken (the voice's [tags] are not said). */
export function scriptSentences(script: string): string[] {
  const words = script.replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean).map((text) => ({ text }));
  return grouped(words).map((s) => s.map((w) => w.text).join(" "));
}
export type TimedSentence = { text: string; start: number; end: number };
/**
 * When each sentence of the script is said. By position when the recording has as many sentences (the voice may spell
 * numbers out), else by the same words; null where it cannot be found.
 */
export function sentenceTimes(script: string, words: CaptionWord[]): (TimedSentence | null)[] {
  const written = scriptSentences(script);
  const said = grouped(words).map((s) => ({ text: s.map((w) => w.text).join(" "), start: s[0].start, end: s.at(-1)!.end }));
  if (said.length === written.length) return written.map((text, i) => ({ ...said[i], text }));
  return written.map((text) => {
    const hit = said.find((s) => norm(s.text) === norm(text));
    return hit ? { ...hit, text } : null;
  });
}
/** Rough word timings of a script before it is recorded (SPEECH_CHARS_PER_SECOND, a pause after each sentence). */
export function estimatedWords(script: string): CaptionWord[] {
  const out: CaptionWord[] = [];
  let t = 0.2;
  for (const s of scriptSentences(script)) {
    for (const text of s.split(" ")) {
      const length = (text.length + 1) / SPEECH_CHARS_PER_SECOND;
      out.push({ text, start: round2(t), end: round2(t + length) });
      t += length;
    }
    t += 0.3;
  }
  return out;
}
/** Where a shot's sentence is in the script (-1: gone). */
const sentenceIndex = (written: string[], sentence: string) => written.findIndex((w) => norm(w) === norm(sentence));

export type BrollOption = { id: string; index: number; text: string };
type Timing = { words: CaptionWord[]; duration: number };
/**
 * Sentences a shot may go on: not the hook (the first one), not the closing one, with something to show and, on a
 * recording's clock, room for a cut-away (placeShots).
 */
export function brollOptions(script: string, timing?: Timing): BrollOption[] {
  const written = scriptSentences(script);
  return written.flatMap((text, index) =>
    index === 0 || index === written.length - 1 || norm(text).length < 8
      || (timing && !placeShots([{ sentence: text }], script, timing.words, timing.duration).cuts.length) ? [] : [{ id: `s${index + 1}`, index, text }]);
}

export type Cutaway = { shot: number; start: number; end: number };
export type BrollSkip = "missing" | "hook" | "closing" | "short" | "crowded" | "pending";
/**
 * When each shot is on screen, on the recording's clock: from its sentence's first word for as long as the sentence
 * (3–5 s, at least 2 s), ending before the closing sentence, on the frame grid. A shot is left out, with the reason,
 * when its sentence is gone from the script, is the hook or the closing one, has no room, would crowd an earlier
 * cut-away (or the 40% share), or is not `ready` (no picture yet). Shots are taken in script order.
 */
export function placeShots(shots: Pick<BrollShot, "sentence">[], script: string, words: CaptionWord[], duration: number, ready: (shot: number) => boolean = () => true) {
  const written = scriptSentences(script), times = sentenceTimes(script, words);
  // The creator is back for the closing sentence, and for at least the renderer's shortest segment (0.5 s).
  const closing = Math.min(duration - 0.6, times[written.length - 1]?.start ?? duration);
  const cuts: Cutaway[] = [], skipped: { shot: number; reason: BrollSkip }[] = [];
  const order = shots.map((s, shot) => ({ shot, index: sentenceIndex(written, s.sentence) })).sort((a, b) => a.index - b.index);
  for (const { shot, index } of order) {
    const t = index >= 0 ? times[index] : null;
    const skip = (reason: BrollSkip) => skipped.push({ shot, reason });
    if (!t) { skip("missing"); continue; }
    if (index === written.length - 1) { skip("closing"); continue; }
    const start = frame(t.start);
    if (index === 0 || start < BROLL_HOOK_SECONDS) { skip("hook"); continue; }
    const end = frame(Math.min(closing, start + Math.min(BROLL_MAX_SECONDS, Math.max(BROLL_MIN_SECONDS, t.end - t.start))));
    if (end - start < BROLL_SHORTEST) { skip("short"); continue; }
    const covered = cuts.reduce((n, c) => n + c.end - c.start, 0);
    if (cuts.length >= BROLL_MAX_SHOTS || covered + end - start > duration * BROLL_MAX_COVER + 0.01
      || cuts.some((c) => start < c.end + BROLL_GAP_SECONDS && end > c.start - BROLL_GAP_SECONDS)) { skip("crowded"); continue; }
    if (!ready(shot)) { skip("pending"); continue; }
    cuts.push({ shot, start, end });
  }
  return { cuts: cuts.sort((a, b) => a.start - b.start), skipped };
}

export type PlannedShot = { sentence: string; description: string; start?: number; end?: number };
/**
 * The model's picks, checked (rech-bg's acceptMoments): known sentences only (by ID, or by their exact words), a
 * description each, in script order, at most `target`. With the recording's words the picks must fit on its clock
 * (placeShots: spaced, within the 40% share) and carry their times; before it, never two neighbouring sentences.
 */
export function acceptShots(value: unknown, script: string, target: number, timing?: Timing) {
  const answer = z.object({
    style: z.string().optional(),
    shots: z.array(z.object({ sentence: z.string(), description: z.string() })),
  }).safeParse(value);
  if (!answer.success) return { style: "", shots: [] as PlannedShot[] };
  const options = brollOptions(script, timing);
  const byId = new Map(options.map((o) => [o.id, o])), byText = new Map(options.map((o) => [norm(o.text), o]));
  const picked = answer.data.shots
    .map((s) => ({ option: byId.get(s.sentence.trim()) || byText.get(norm(s.sentence)), description: tidy(s.description, 300) }))
    .filter((p): p is { option: BrollOption; description: string } => !!p.option && p.description.length >= 3)
    .sort((a, b) => a.option.index - b.option.index);
  const shots: PlannedShot[] = [], used: number[] = [];
  for (const { option, description } of picked) {
    if (shots.length >= Math.min(target, BROLL_MAX_SHOTS)) break;
    if (!timing && used.some((i) => Math.abs(i - option.index) < 2)) continue;
    const next = [...shots, { sentence: option.text, description }];
    if (timing) {
      const { cuts } = placeShots(next, script, timing.words, timing.duration);
      if (cuts.length < next.length) continue;
      next.forEach((s, i) => { const c = cuts.find((x) => x.shot === i)!; s.start = round2(c.start); s.end = round2(c.end); });
    }
    shots.splice(0, shots.length, ...next);
    used.push(option.index);
  }
  return { style: tidy(answer.data.style || "", 200), shots };
}

/** The description sent to the image or clip model: the shot, then the look all shots share. */
export const brollPrompt = (description: string, style: string) =>
  `${description.trim().replace(/([^.!?])$/, "$1.")}${style.trim() ? ` Visual style: ${style.trim()}.` : ""}`.slice(0, 600);
/**
 * AI shots still to make, with their place in `shots`: B-roll on, no picture yet, and a sentence that can be shown
 * (still in the script, not the first or last one). Each is one paid generation of the run (credits: `specCredits`).
 */
export function brollPending(broll: Broll | undefined, script: string): { kind: "image" | "clip"; prompt: string; index: number }[] {
  if (!broll?.enabled) return [];
  const written = scriptSentences(script);
  return broll.shots.flatMap((s, index) => {
    const at = sentenceIndex(written, s.sentence);
    if (s.source === "own" || s.assetId || at <= 0 || at === written.length - 1) return [];
    return [{ kind: s.source, prompt: brollPrompt(s.description, broll.style || DEFAULT_BROLL_STYLE), index }];
  });
}
/** Credits the B-roll still costs. */
export const brollCredits = (broll: Broll | undefined, script: string) => brollPending(broll, script).reduce((n, m) => n + sourceCredits(m.kind), 0);
/** The owner's files the shots use (made or chosen), on or off: made ones stay with the post. */
export const brollAssets = (broll: Broll | undefined) => (broll?.shots || []).flatMap((s) => (s.assetId ? [s.assetId] : []));
/** Library clips the shots use. */
export const brollLibrary = (broll: Broll | undefined) => (broll?.shots || []).flatMap((s) => (s.libraryId ? [s.libraryId] : []));

/**
 * The picture of a post with cut-aways: the creator's video, resumed where it was due after each shot (so the lips
 * stay on the voice's clock), and each shot during its span. All are silent: the voice is its own track underneath.
 */
export function cutawaySegments(cuts: Cutaway[], duration: number, creator: number, shot: (cut: Cutaway, n: number) => ComposeSegment): ComposeSegment[] {
  const out: ComposeSegment[] = [];
  const talk = (from: number, to: number) => out.push({ kind: "video", input: creator, trim: Math.round(from * 1000) / 1000, duration: round2(to - from), audio: 0 });
  let at = 0;
  cuts.forEach((cut, n) => {
    if (cut.start > at + 0.01) talk(at, cut.start);
    out.push(shot(cut, n));
    at = cut.end;
  });
  if (duration > at + 0.01) talk(at, duration);
  return out;
}
