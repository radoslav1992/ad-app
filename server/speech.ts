import { z } from "zod";
import type { Env } from "./types";
import { DAY, now } from "./types";
import { json } from "./db";
import { take, token } from "./security";
import { failureCode, providerFetch, ProviderError } from "./providers/http";
import { LONG_VIDEO_SECONDS, SPEECH_MAX_SECONDS, TRANSCRIPT_MAX_WORDS, type SpeechStatus, type Transcript } from "../shared/speech";
import type { CaptionWord } from "../shared/captions";

// Speech in uploaded videos and tracks, for subtitles, captions, instant cuts and clips. ElevenLabs Scribe v2 (the
// pipeline rech-bg runs in production) reads the file itself through a short-lived capability link and returns word
// timings in the language it detects. The words are kept in the file's meta (bounded); failures only mean "no
// subtitles", never a failed upload. Files up to 10 minutes are transcribed for free, so that is bounded per person
// and day (files and minutes); longer videos are transcribed on request for AI credits (a run of kind "speech").

export const SCRIBE_MODEL = "scribe_v2";
export const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
/** Free transcriptions per person and day (automatic ones after uploads and "Find speech" together): files… */
export const SPEECH_FILES_PER_DAY = 20;
/** …and minutes of sound (Scribe costs about $0.40 an hour). */
export const SPEECH_MINUTES_PER_DAY = 30;
/** How long Scribe may read a file through its link; a run never lives longer (maintenance fails it). */
const LISTEN_SECONDS = 3 * 3600;
/** A transcription that has not finished by then is reported as failed (it can be tried again). */
const PENDING_SECONDS = 3600;

// The Scribe answer (ElevenLabs speech-to-text, as in @elevenlabs/elevenlabs-js SpeechToTextChunkResponseModel):
// language_code (ISO 639-3, e.g. "eng"), text, and words [{ text, start, end, type: word|spacing|audio_event }].
const scribeOutput = z.object({
  language_code: z.string().optional(),
  words: z.array(z.object({ text: z.unknown(), start: z.unknown(), end: z.unknown(), type: z.unknown() }).partial()).optional(),
});
const round = (n: number) => Math.round(n * 100) / 100;
/**
 * The words of a Scribe answer, as rech-bg keeps them: only real words with times, never before the previous word's
 * end (times only go forward), cut to the file's length, without brackets or control characters.
 */
export function scribeWords(result: unknown, duration: number): Transcript {
  const r = scribeOutput.safeParse(result);
  if (!r.success) return { language: "", words: [] };
  const limit = duration > 0 ? duration : Infinity, words: CaptionWord[] = [];
  let end = 0;
  for (const w of r.data.words || []) {
    if (w.type !== "word" || typeof w.text !== "string" || typeof w.start !== "number" || typeof w.end !== "number" || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    const start = round(Math.max(end, 0, w.start)), finish = round(Math.min(limit, w.end));
    end = finish;
    // eslint-disable-next-line no-control-regex -- control characters never belong in a caption
    const text = w.text.replace(/[[\]<>\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (text && finish > start) words.push({ text, start, end: finish });
  }
  const language = (r.data.language_code || "").toLowerCase().replace(/[^a-z-]/g, "").slice(0, 12);
  return { language, words: words.slice(0, TRANSCRIPT_MAX_WORDS) };
}

/**
 * Transcribes the file behind `url` (a capability link Scribe downloads from) once: no automatic retries, each call is
 * billed. No language is given, so Scribe detects it.
 */
export async function transcribe(e: Env, url: string, duration: number): Promise<Transcript> {
  const key = e.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ProviderError("SPEECH_UNAVAILABLE");
  const body = new FormData();
  body.set("model_id", SCRIBE_MODEL);
  body.set("source_url", url);
  body.set("timestamps_granularity", "word");
  body.set("tag_audio_events", "false");
  // About ten minutes, and more for long videos (Scribe answers when the whole file is done).
  const r = await providerFetch(SCRIBE_URL, {
    method: "POST", headers: { "xi-api-key": key }, body, signal: AbortSignal.timeout((10 + Math.min(duration, LONG_VIDEO_SECONDS) / 240) * 60000),
  });
  if (!r.ok) throw new ProviderError(await failureCode(r, "SPEECH"));
  return scribeWords(await r.json(), duration);
}

/** What the API tells about a file's speech: its status (null: never checked) and language. */
export function speechView(a: { kind?: string; mime: string; meta: string | null }) {
  const meta = json<any>(a.meta, {});
  const s = meta.speech as { status?: SpeechStatus; at?: number; language?: string } | undefined;
  if (!s?.status) return { speech: null, speechLanguage: null };
  const status: SpeechStatus = s.status === "pending" && (s.at || 0) < now() - PENDING_SECONDS ? "failed" : s.status;
  return { speech: status, speechLanguage: status === "found" ? s.language || null : null };
}
/** The stored transcript of a file, if speech was found; only the words in [from, to] when a range is given. */
export function storedTranscript(meta: string | null, from = 0, to = Infinity): Transcript | null {
  const t = json<any>(meta, {}).transcript;
  if (!t || !Array.isArray(t.words) || !t.words.length) return null;
  const words = from > 0 || to < Infinity ? t.words.filter((w: CaptionWord) => w.end >= from && w.start <= to) : t.words;
  return { language: String(t.language || ""), words };
}
const ownSound = (a: { kind: string; mime: string; duration: number }, hasAudio: boolean | null | undefined) =>
  a.kind === "upload" && /^(video|audio)\//.test(a.mime) && hasAudio !== false && a.duration >= 1;
/** Whether a file's speech is transcribed for free: an own video or track with sound, up to 10 minutes. */
export function mayHaveSpeech(a: { kind: string; mime: string; duration: number }, hasAudio: boolean | null | undefined) {
  return ownSound(a, hasAudio) && a.duration <= SPEECH_MAX_SECONDS;
}
/** Whether a longer file can be transcribed on request (paid): an own video or track with sound, up to 2 hours. */
export function mayTranscribe(a: { kind: string; mime: string; duration: number }, hasAudio: boolean | null | undefined) {
  return ownSound(a, hasAudio) && a.duration > SPEECH_MAX_SECONDS && a.duration <= LONG_VIDEO_SECONDS;
}
/** Meta for a file whose speech is about to be transcribed: pending, with a capability token Scribe reads it with. */
export function listening(meta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...meta, speech: { status: "pending", at: now(), ...extra }, listen: { token: token(), until: now() + LISTEN_SECONDS } };
}
/**
 * Meta for a free transcription of a file `seconds` long, or null when the person's daily allowance (files or
 * minutes) is used up.
 */
export async function claimSpeech(env: Env, userId: string, meta: Record<string, unknown>, seconds: number) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (!(await take(env, "speech-minutes", DAY, userId, minutes, SPEECH_MINUTES_PER_DAY))) return null;
  if (!(await take(env, "speech-files", DAY, userId, 1, SPEECH_FILES_PER_DAY))) {
    await take(env, "speech-minutes", DAY, userId, -minutes, SPEECH_MINUTES_PER_DAY);
    return null;
  }
  return listening(meta);
}
