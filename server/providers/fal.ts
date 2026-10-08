import type { Env } from "../types";
import { CLIP_SECONDS } from "../../shared/credits";
import { failureCode, falQueueUrl, providerFetch, ProviderError } from "./http";

// AI images (slides, backgrounds, character portraits) and short AI video clips through fal's queue API.
const IMAGE_MODEL = "fal-ai/nano-banana-2";
const CLIP_MODEL = "fal-ai/kling-video/v2.5-turbo/pro/text-to-video";
const NEGATIVE = "blur, distortion, low quality, text, captions, subtitles, watermark, logo";
export type FalTicket = { request_id: string; status_url: string; response_url: string };

const auth = (e: Env) => {
  const key = e.FAL_KEY?.trim();
  if (!key) throw new ProviderError("GENERATION_UNAVAILABLE");
  return { Authorization: `Key ${key}` };
};
/** The model and its input (pure, for tests). Pictures are portrait 9:16 for short-form; no text is drawn in them. */
export function falRequest(kind: "image" | "clip", prompt: string) {
  const text = `${prompt.trim()} No text, captions, logos or watermarks in the picture.`;
  if (kind === "image")
    return { model: IMAGE_MODEL, body: { prompt: text, num_images: 1, aspect_ratio: "9:16", resolution: "2K", output_format: "jpeg", limit_generations: true } };
  // Clips are silent: the post's music and voice play over them.
  return { model: CLIP_MODEL, body: { prompt: text, duration: String(CLIP_SECONDS), aspect_ratio: "9:16", negative_prompt: NEGATIVE, cfg_scale: 0.5 } };
}
/** Submits once; the caller stores the ticket before anything else so a retry polls instead of paying again. */
export async function submitFal(e: Env, kind: "image" | "clip", prompt: string): Promise<FalTicket> {
  const { model, body } = falRequest(kind, prompt);
  const r = await providerFetch(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers: { ...auth(e), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new ProviderError(await failureCode(r, "GENERATION"));
  const t = (await r.json()) as any;
  if (!t?.request_id) throw new ProviderError("GENERATION_FAILED");
  return { request_id: String(t.request_id), status_url: falQueueUrl(String(t.status_url)), response_url: falQueueUrl(String(t.response_url)) };
}
/** "pending" while queued or running, "done" when the result can be read. */
export async function falStatus(e: Env, ticket: FalTicket): Promise<"pending" | "done"> {
  const r = await providerFetch(falQueueUrl(ticket.status_url), { headers: auth(e), signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new ProviderError(r.status >= 500 ? "GENERATION_STATUS" : await failureCode(r, "GENERATION"));
  const status = ((await r.json()) as any)?.status;
  if (status === "COMPLETED") return "done";
  if (status === "IN_QUEUE" || status === "IN_PROGRESS") return "pending";
  throw new ProviderError("GENERATION_FAILED");
}
/** The output file's URL (image or video). */
export async function falResult(e: Env, kind: "image" | "clip", ticket: FalTicket) {
  const r = await providerFetch(falQueueUrl(ticket.response_url), { headers: auth(e), signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new ProviderError(r.status >= 500 ? "GENERATION_RESULT" : await failureCode(r, "GENERATION"));
  const result = (await r.json()) as any;
  const url = kind === "image" ? result?.images?.[0]?.url : result?.video?.url;
  if (typeof url !== "string") throw new ProviderError("GENERATION_FAILED");
  return url;
}
