import type { Env } from "../types";
import { failureCode, providerFetch, ProviderError } from "./http";

// Talking AI creators: HeyGen lip-syncs a character to a recorded voice. A library character linked to a saved
// HeyGen avatar ("look") uses Avatar III; a character that is only a portrait is animated from the photo (Avatar IV).
const endpoint = "https://api.heygen.com/v3/videos";
const looks = "https://api.heygen.com/v3/avatars/looks";
export type HeyGenTicket = { video_id: string };

function validId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new ProviderError("AVATAR_FAILED");
  return id;
}
function headers(e: Env) {
  const key = e.HEYGEN_API_KEY?.trim();
  if (!key) throw new ProviderError("AVATAR_UNAVAILABLE");
  return { "x-api-key": key };
}
/** The request body (pure, for tests): a saved look, or a photo animated directly. */
export function heygenRequest(id: string, character: { lookId: string } | { imageUrl: string }, audioUrl: string) {
  return {
    ...("lookId" in character
      ? { type: "avatar", avatar_id: validId(character.lookId), engine: { type: "avatar_iii" } }
      : {
          type: "image", image: { type: "url", url: character.imageUrl },
          motion_prompt: "A person talking naturally and enthusiastically to the camera, like a casual social media video. Subtle head movement and natural expressions.",
          expressiveness: "medium",
        }),
    audio_url: audioUrl,
    title: `post ${id}`,
    resolution: "1080p",
    // The avatar's own shape: asking for another one letterboxes it. The renderer crops it to fill 9:16.
    aspect_ratio: "auto",
    output_format: "mp4",
  };
}
/** Submits once (Idempotency-Key = run ID, so a lost response can be recovered by sending the same request). */
export async function submitAvatarVideo(e: Env, id: string, character: { lookId: string } | { imageUrl: string }, audioUrl: string): Promise<HeyGenTicket> {
  const r = await providerFetch(endpoint, {
    method: "POST",
    headers: { ...headers(e), "Content-Type": "application/json", "Idempotency-Key": id },
    body: JSON.stringify(heygenRequest(id, character, audioUrl)),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new ProviderError(await failureCode(r, "AVATAR"));
  const body = (await r.json()) as any;
  if (body?.error || !body?.data?.video_id) throw new ProviderError("AVATAR_FAILED");
  return { video_id: validId(body.data.video_id) };
}
export async function avatarVideoStatus(e: Env, ticket: HeyGenTicket): Promise<{ state: "pending" } | { state: "done"; url: string }> {
  // The URL is rebuilt from the ID: a credential is never sent to a stored URL.
  const r = await providerFetch(`${endpoint}/${validId(ticket.video_id)}`, { headers: headers(e), signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new ProviderError(r.status >= 500 ? "AVATAR_STATUS" : await failureCode(r, "AVATAR"));
  const data = ((await r.json()) as any)?.data;
  if (!data || data.id !== ticket.video_id) throw new ProviderError("AVATAR_FAILED");
  if (["waiting", "pending", "processing"].includes(data.status)) return { state: "pending" };
  if (data.status === "completed" && typeof data.video_url === "string") return { state: "done", url: data.video_url };
  throw new ProviderError(data.error?.code === "moderation_failed" ? "AVATAR_REJECTED" : "AVATAR_FAILED");
}
/** Our copy at HeyGen is not needed once the video is stored here (best effort). */
export async function deleteAvatarVideo(e: Env, ticket: HeyGenTicket) {
  try {
    await providerFetch(`${endpoint}/${validId(ticket.video_id)}`, { method: "DELETE", headers: headers(e), signal: AbortSignal.timeout(20000) });
  } catch { /* Kept at the provider; not a failure of the post. */ }
}
/** A look's engines and preview, for administrators linking a library character to a saved avatar. */
export async function heygenLook(e: Env, lookId: string) {
  const r = await providerFetch(`${looks}/${validId(lookId)}`, { headers: headers(e), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new ProviderError(await failureCode(r, "AVATAR"));
  const look = ((await r.json()) as any)?.data;
  if (!look || look.id !== lookId) throw new ProviderError("AVATAR_FAILED");
  return {
    id: String(look.id),
    name: typeof look.name === "string" ? look.name.slice(0, 80) : "",
    engines: Array.isArray(look.supported_api_engines) ? look.supported_api_engines.filter((x: unknown) => typeof x === "string").slice(0, 10) : [],
    preview: typeof look.preview_image_url === "string" ? look.preview_image_url : typeof look.image_url === "string" ? look.image_url : null,
  };
}
