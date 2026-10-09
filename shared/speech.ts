import type { CaptionWord } from "./captions";

// Speech in uploaded videos and tracks: transcribed once by ElevenLabs Scribe (server/speech.ts), kept with word
// timings in the file's `meta`, and shown as subtitles where a post uses that part of the clip. Files up to 10 minutes
// are transcribed for free after the upload is checked; longer videos (for clips) on request, for AI credits.

/** Longest file whose speech is transcribed for free (automatically after the upload, or "Find speech"). */
export const SPEECH_MAX_SECONDS = 600;
/** Longest video at all (paid plans); its speech is transcribed on request (speechCredits). */
export const LONG_VIDEO_SECONDS = 7200;
/** Words kept per file: two hours of fast speech. */
export const TRANSCRIPT_MAX_WORDS = 30000;
/** "pending": being transcribed; "found": words were heard; "none": no speech; "failed": could not be checked. */
export type SpeechStatus = "pending" | "found" | "none" | "failed";
export type Transcript = { language: string; words: CaptionWord[] };

const round = (n: number) => Math.round(n * 100) / 100;
/**
 * The words heard in [trim, trim + length) of a clip, moved so that `trim` lands on `at` of the post's clock. A word
 * belongs to the part that holds its middle (the others are dropped); its ends are cut to that part.
 */
export function clipWords(words: CaptionWord[], trim: number, length: number, at: number): CaptionWord[] {
  const end = trim + length, out: CaptionWord[] = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2;
    if (mid < trim || mid >= end) continue;
    out.push({ text: w.text, start: round(at + Math.max(w.start, trim) - trim), end: round(at + Math.min(w.end, end) - trim) });
  }
  return out;
}
/** The words of a clip that loops (from its start) to fill `seconds`, on the post's clock (server/render-plan.ts). */
export function loopedWords(words: CaptionWord[], clipSeconds: number, seconds: number): CaptionWord[] {
  const length = clipSeconds > 0.5 ? clipSeconds : seconds, out: CaptionWord[] = [];
  for (let at = 0, n = 0; at < seconds - 0.05 && n < 20; at += length, n++) out.push(...clipWords(words, 0, Math.min(length, seconds - at), at));
  return out;
}
