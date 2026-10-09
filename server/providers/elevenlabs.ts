import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { z } from "zod";
import type { Env } from "../types";
import { alignmentWords, type CaptionWord } from "../../shared/captions";
import { providerVoiceId } from "../voices";
import { failureCode, providerFetch, ProviderError } from "./http";

// Speech for talking AI creators and narrated videos, with per-character timings that become word-by-word captions;
// and forced alignment (rech-bg's fallback for missing timings, server/studio-speech.ts): known words timed on a
// recording, for a voice without timings and for an owner's voiceover whose exact script they gave.
export const SPEECH_MODEL = "eleven_v3";
export const ALIGNMENT_URL = "https://api.elevenlabs.io/v1/forced-alignment";

/** 16-bit mono PCM as a WAV file. */
export function wav(pcm: Uint8Array, rate: number) {
  const out = new Uint8Array(44 + pcm.length), v = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
  text(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); text(8, "WAVE"); text(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, "data"); v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/**
 * Speaks `text` once (no automatic retries: each call is billed). Returns a WAV, its length and word timings: of the
 * normalized text (numbers read out; captions of what is heard), or of the `original` text (a narrated video's scenes
 * are counted in the words as written).
 */
export async function speak(e: Env, voiceId: string, text: string, language = "en", timing: "normalized" | "original" = "normalized"): Promise<{ audio: Uint8Array; seconds: number; words: CaptionWord[] }> {
  const voice = providerVoiceId(e, voiceId);
  if (!e.ELEVENLABS_API_KEY?.trim() || !voice) throw new ProviderError("VOICE_UNAVAILABLE");
  const client = new ElevenLabsClient({ apiKey: e.ELEVENLABS_API_KEY.trim() });
  let result;
  try {
    result = await client.textToSpeech.convertWithTimestamps(voice, {
      text, modelId: SPEECH_MODEL, languageCode: language.slice(0, 2), outputFormat: "pcm_24000",
    }, { maxRetries: 0, timeoutInSeconds: 240 });
  } catch (error) {
    const status = (error as any)?.statusCode;
    throw new ProviderError(status === 401 || status === 402 ? "VOICE_UNAVAILABLE" : status === 429 ? "VOICE_BUSY" : "VOICE_FAILED");
  }
  if (!result.audioBase64 || result.audioBase64.length > 20_000_000) throw new ProviderError("VOICE_FAILED");
  const pcm = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
  if (!pcm.length || pcm.length % 2) throw new ProviderError("VOICE_FAILED");
  const alignment = timing === "original" ? result.alignment || result.normalizedAlignment : result.normalizedAlignment || result.alignment;
  return { audio: wav(pcm, 24000), seconds: pcm.length / 48000, words: alignmentWords(alignment) };
}

// The forced-alignment answer (ElevenLabs ForcedAlignmentResponseModel): characters and words, each {text, start, end}.
const alignmentOutput = z.object({ words: z.array(z.object({ text: z.unknown(), start: z.unknown(), end: z.unknown() }).partial()) });
const round = (n: number) => Math.round(n * 100) / 100;
/**
 * The timed words of a forced alignment: spaces and empty tokens dropped, times only going forward, within the
 * recording, each at least 20 ms, without brackets or control characters.
 */
export function alignedWords(result: unknown, duration: number): CaptionWord[] {
  const r = alignmentOutput.safeParse(result);
  if (!r.success) return [];
  const limit = duration > 0 ? duration : Infinity, out: CaptionWord[] = [];
  let end = 0;
  for (const w of r.data.words) {
    if (typeof w.text !== "string" || typeof w.start !== "number" || typeof w.end !== "number" || !Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    // eslint-disable-next-line no-control-regex -- control characters never belong in a caption
    const text = w.text.replace(/[[\]<>\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text) continue;
    const start = round(Math.min(limit, Math.max(end, 0, w.start))), finish = round(Math.min(limit, Math.max(w.end, start + 0.02)));
    if (finish <= start) continue;
    out.push({ text, start, end: finish });
    end = finish;
  }
  return out;
}
/**
 * Times `text` on the recording `file` (forced alignment), once: no automatic retries, each call is billed. The words
 * come back in the order of the text.
 */
export async function forcedAlignment(e: Env, file: Blob, text: string, duration: number): Promise<CaptionWord[]> {
  const key = e.ELEVENLABS_API_KEY?.trim();
  if (!key) throw new ProviderError("ALIGN_UNAVAILABLE");
  const body = new FormData();
  body.set("file", file, "recording");
  body.set("text", text);
  const r = await providerFetch(ALIGNMENT_URL, { method: "POST", headers: { "xi-api-key": key }, body, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new ProviderError(await failureCode(r, "ALIGN"));
  const words = alignedWords(await r.json().catch(() => null), duration);
  if (!words.length) throw new ProviderError("ALIGN_FAILED");
  return words;
}
