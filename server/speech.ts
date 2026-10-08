import { z } from "zod";
import type { Env } from "./types";
import { DAY, now } from "./types";
import { json } from "./db";
import { hit, token } from "./security";
import { SPEECH_MAX_SECONDS, TRANSCRIPT_MAX_WORDS, type SpeechStatus, type Transcript } from "../shared/speech";
import type { CaptionWord } from "../shared/captions";

// Speech in uploaded videos and tracks, for subtitles. After an upload is checked (or on request, "Find speech"), the
// renderer cuts its sound into small MP3 parts and Workers AI Whisper transcribes each part with word timings. The
// words are kept in the file's meta (bounded); failures only mean "no subtitles", never a failed upload. It is free,
// so it is bounded per person and per day.

export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
/** Seconds of sound per transcribed part (about 0.5 MB of MP3, well under a megabyte as base64). */
export const SPEECH_PART_SECONDS = 120;
/** Transcriptions per person and day (automatic ones after uploads and "Find speech" together). */
export const SPEECH_PER_DAY = 30;
/** How long the renderer may read a ready upload for its sound. */
const LISTEN_SECONDS = 3600;
/** A transcription that has not finished by then is reported as failed (it can be tried again). */
const PENDING_SECONDS = 1800;

// The Whisper answer, as documented for @cf/openai/whisper-large-v3-turbo (Workers AI model page and
// @cloudflare/workers-types): transcription_info.language, text, and segments with no_speech_prob, avg_logprob and
// words [{ word, start, end }] in seconds.
const whisperOutput = z.object({
  transcription_info: z.object({ language: z.string().optional() }).partial().optional(),
  text: z.string().optional(),
  segments: z.array(z.object({
    no_speech_prob: z.number().optional(),
    avg_logprob: z.number().optional(),
    words: z.array(z.object({ word: z.string().optional(), start: z.number().optional(), end: z.number().optional() })).optional(),
  })).optional(),
});

const round = (n: number) => Math.round(n * 100) / 100;
/**
 * The words of one Whisper answer, moved by `offset` seconds (where its part starts in the file). Segments Whisper
 * itself thinks are not speech are dropped (its rule: likely silence and low confidence), as are sound notes like
 * "[Music]" or "♪".
 */
export function whisperWords(result: unknown, offset = 0): { language: string; words: CaptionWord[] } {
  const r = whisperOutput.safeParse(result);
  if (!r.success) return { language: "", words: [] };
  const words: CaptionWord[] = [];
  for (const segment of r.data.segments || []) {
    if ((segment.no_speech_prob ?? 0) > 0.6 && (segment.avg_logprob ?? 0) < -1) continue;
    for (const w of segment.words || []) {
      // eslint-disable-next-line no-control-regex -- control characters never belong in a caption
      const text = (w.word || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
      if (!text || /^[[(♪*].*[\])♪*]$|^♪+$/u.test(text)) continue;
      if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
      const start = round(offset + Math.max(0, w.start!));
      words.push({ text, start, end: Math.max(round(offset + w.end!), round(start + 0.05)) });
    }
  }
  const language = (r.data.transcription_info?.language || "").toLowerCase().replace(/[^a-z-]/g, "").slice(0, 12);
  return { language, words };
}

/** Bytes as base64 (Whisper's `audio` input), in slices so large buffers do not overflow the call stack. */
export function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
/** Transcribes the parts of a file's sound (part n starts at n × `partSeconds`) into one transcript, in time order. */
export async function transcribe(env: Env, parts: Uint8Array[], partSeconds: number): Promise<Transcript> {
  const words: CaptionWord[] = [];
  let language = "";
  for (let n = 0; n < parts.length; n++) {
    const result = await env.AI.run(WHISPER_MODEL, {
      audio: base64(parts[n]), task: "transcribe", vad_filter: true,
      // Not conditioning on the previous text keeps a mistake from repeating through the rest of a part.
      condition_on_previous_text: false,
    });
    const part = whisperWords(result, n * partSeconds);
    words.push(...part.words.filter((w) => w.start < (n + 1) * partSeconds + 1));
    language ||= part.language;
  }
  words.sort((a, b) => a.start - b.start);
  return { language, words: words.slice(0, TRANSCRIPT_MAX_WORDS) };
}

/** What the API tells about a file's speech: its status (null: never checked) and language. */
export function speechView(a: { kind?: string; mime: string; meta: string | null }) {
  const meta = json<any>(a.meta, {});
  const s = meta.speech as { status?: SpeechStatus; at?: number; language?: string } | undefined;
  if (!s?.status) return { speech: null, speechLanguage: null };
  const status: SpeechStatus = s.status === "pending" && (s.at || 0) < now() - PENDING_SECONDS ? "failed" : s.status;
  return { speech: status, speechLanguage: status === "found" ? s.language || null : null };
}
/** The stored transcript of a file, if speech was found. */
export function storedTranscript(meta: string | null): Transcript | null {
  const t = json<any>(meta, {}).transcript;
  return t && Array.isArray(t.words) && t.words.length ? { language: String(t.language || ""), words: t.words } : null;
}
/** Whether a file can hold speech worth transcribing: an own video or track with sound, up to 10 minutes. */
export function mayHaveSpeech(a: { kind: string; mime: string; duration: number }, hasAudio: boolean | null | undefined) {
  return a.kind === "upload" && /^(video|audio)\//.test(a.mime) && hasAudio !== false && a.duration >= 1 && a.duration <= SPEECH_MAX_SECONDS;
}
/**
 * Meta for a file whose speech is about to be transcribed: pending, with a capability token the renderer reads it
 * with. Null when the person's daily allowance is used up.
 */
export async function claimSpeech(env: Env, userId: string, meta: Record<string, unknown>) {
  if ((await hit(env, "speech-day", DAY, userId)) > SPEECH_PER_DAY) return null;
  return { ...meta, speech: { status: "pending", at: now() }, listen: { token: token(), until: now() + LISTEN_SECONDS } };
}
