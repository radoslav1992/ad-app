import type { Env } from "./types";
import { voices } from "../shared/voices";

// The speech provider's voice for each public voice ID (ElevenLabs premade voices). ELEVENLABS_VOICES (JSON) can
// replace any of them without a deploy of new code.
const defaults: Record<string, string> = {
  aria: "9BWtsMINqrJLrRacOk9x",
  sarah: "EXAVITQu4vr4xnSDxMaL",
  jessica: "cgSgspJ2msm6clMCkdW9",
  laura: "FGY2WhTYpPnrIDTdsKH5",
  matilda: "XrExE9yKIg1WjnnlVkGX",
  alice: "Xb7hH8MSUJpSbSDYk0k2",
  liam: "TX3LPaxmHKxFdv7VOQHJ",
  chris: "iP95p4xoKVk53GoZ742B",
  eric: "cjVigY5qzO86Huf0OWal",
  brian: "nPczCjzI2devNBz1zQrb",
  will: "bIHbv24MWmeRgasZH58o",
  george: "JBFqnCBsd6RMkjVDRZzb",
};
export function providerVoiceId(e: Env, id: string): string | null {
  if (!voices.some((v) => v.id === id)) return null;
  try {
    const custom = e.ELEVENLABS_VOICES ? JSON.parse(e.ELEVENLABS_VOICES) : {};
    if (typeof custom[id] === "string" && /^[A-Za-z0-9]{10,40}$/.test(custom[id])) return custom[id];
  } catch { /* A malformed override falls back to the defaults. */ }
  return defaults[id] ?? null;
}
export const isVoice = (id: string) => voices.some((v) => v.id === id);
