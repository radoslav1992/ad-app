import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import type { Env } from "../types";
import { alignmentWords, type CaptionWord } from "../../shared/captions";
import { providerVoiceId } from "../voices";
import { ProviderError } from "./http";

// Speech for talking AI creators, with per-character timings that become word-by-word captions.
export const SPEECH_MODEL = "eleven_v3";

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

/** Speaks `text` once (no automatic retries: each call is billed). Returns a WAV, its length and word timings. */
export async function speak(e: Env, voiceId: string, text: string, language = "en"): Promise<{ audio: Uint8Array; seconds: number; words: CaptionWord[] }> {
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
  return { audio: wav(pcm, 24000), seconds: pcm.length / 48000, words: alignmentWords(result.normalizedAlignment || result.alignment) };
}
