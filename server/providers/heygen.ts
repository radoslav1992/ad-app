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
  // An unknown (or another account's private) look: the admin's input, not a provider failure.
  if (r.status === 404) { await r.body?.cancel(); throw new ProviderError("AVATAR_NOT_FOUND"); }
  if (!r.ok) throw new ProviderError(await failureCode(r, "AVATAR"));
  const look = ((await r.json()) as any)?.data;
  if (!look || look.id !== lookId) throw new ProviderError("AVATAR_FAILED");
  const summary = lookSummary(look);
  return { id: String(look.id), name: summary.name, engines: summary.engines, preview: summary.previewImageUrl };
}

// HeyGen's stock avatars (ported from rech-bg's video-heygen.ts): administrators browse them page by page and import
// chosen ones into the library through the existing bulk import, which checks each look again.
/** The fields of a look we show; HeyGen's names, genders and tags are short display text, cleaned. */
export function lookSummary(look: any) {
  const engines = Array.isArray(look?.supported_api_engines)
    ? (look.supported_api_engines as unknown[]).filter((e): e is string => typeof e === "string" && /^[a-z0-9_]{1,40}$/.test(e)).slice(0, 10)
    : [];
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\p{Cc}<>]/gu, "").trim().slice(0, max) : "");
  return {
    status: (look?.status === "processing" ? "processing" : look?.status === "completed" || look?.status === undefined ? "completed" : "failed") as "processing" | "completed" | "failed",
    name: text(look?.name, 80),
    gender: text(look?.gender, 20).toLowerCase(),
    /** Short descriptive labels (style, setting…), for searching the catalogue. */
    tags: Array.isArray(look?.tags) ? (look.tags as unknown[]).map((t) => text(t, 40)).filter(Boolean).slice(0, 12) : [],
    /** The engines HeyGen lists for this look (e.g. avatar_iii, avatar_iv, avatar_v). */
    engines,
    previewImageUrl: typeof look?.preview_image_url === "string" ? (look.preview_image_url as string) : typeof look?.image_url === "string" ? (look.image_url as string) : null,
  };
}
export type HeyGenLookSummary = ReturnType<typeof lookSummary> & { id: string };
/** One page (50) of HeyGen's stock looks (`ownership=public`); `nextToken` is null on the last page. */
export async function listHeyGenStockLooks(e: Env, token?: string): Promise<{ looks: HeyGenLookSummary[]; nextToken: string | null }> {
  const query = new URLSearchParams({ ownership: "public", limit: "50", ...(token ? { token } : {}) });
  const r = await providerFetch(`${looks}?${query}`, { headers: headers(e), signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new ProviderError(await failureCode(r, "AVATAR"));
  const body = (await r.json()) as any;
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.items) ? body.data.items : Array.isArray(body?.data?.looks) ? body.data.looks : null;
  if (body?.error || !list) throw new ProviderError("AVATAR_FAILED");
  const next = body?.next_token ?? body?.data?.next_token;
  return {
    looks: (list as any[]).filter((l) => typeof l?.id === "string" && /^[a-zA-Z0-9_-]{1,160}$/.test(l.id)).map((l) => ({ id: l.id as string, ...lookSummary(l) })),
    nextToken: (body?.has_more ?? body?.data?.has_more) !== false && typeof next === "string" && /^[\w.~+/=-]{1,1000}$/.test(next) ? next : null,
  };
}

const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;
/** A HeyGen-hosted https address (heygen.ai or heygen.com, no credentials or odd ports), or a refusal. */
export function heygenImageUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError("PROVIDER_URL"); }
  const host = url.hostname;
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !["heygen.ai", "heygen.com"].some((h) => host === h || host.endsWith("." + h)))
    throw new ProviderError("PROVIDER_URL");
  return url.href;
}
/**
 * A HeyGen-hosted image, e.g. a stock look's preview, for the admin page (whose policy allows only our own images):
 * https on heygen.ai or heygen.com only (each redirect too), no credentials sent, at most 5 MB, and only JPEG, PNG or
 * WebP by its bytes.
 */
export async function fetchHeyGenImage(src: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: "image/jpeg" | "image/png" | "image/webp" }> {
  let next = heygenImageUrl(src);
  for (let hop = 0; hop <= 2; hop++) {
    const r = await fetch(next, { redirect: "manual", signal: AbortSignal.timeout(20000) });
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel();
      const location = r.headers.get("Location");
      if (!location || hop === 2) break;
      next = heygenImageUrl(new URL(location, next).href);
      continue;
    }
    if (!r.ok || !r.body || Number(r.headers.get("Content-Length")) > MAX_PREVIEW_BYTES) { await r.body?.cancel(); break; }
    const chunks: Uint8Array[] = [], reader = r.body.getReader();
    let size = 0;
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      size += part.value.length;
      if (size > MAX_PREVIEW_BYTES) { await reader.cancel(); throw new ProviderError("PROVIDER_DOWNLOAD"); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    chunks.reduce((at, c) => { bytes.set(c, at); return at + c.length; }, 0);
    const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, mime: "image/jpeg" };
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) return { bytes, mime: "image/png" };
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { bytes, mime: "image/webp" };
    break;
  }
  throw new ProviderError("PROVIDER_DOWNLOAD");
}
