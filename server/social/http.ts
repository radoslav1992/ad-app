import type { Env } from "../types";
import type { PlatformId } from "../../shared/social";
import { b64url } from "../crypto";
import { SocialError, failure } from "./errors";

/**
 * Every provider call: no redirects followed (a credential is never sent on to another host), a bounded timeout,
 * and nothing about the request or answer logged except platform, status and a short code.
 */
export async function send(
  platform: PlatformId,
  url: string,
  init: RequestInit & { timeout?: number; resumable?: boolean } = {},
): Promise<Response> {
  const { timeout = 30_000, resumable, ...rest } = init;
  let r: Response;
  try {
    r = await fetch(url, { ...rest, redirect: "manual", signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    console.warn("Social API unreachable", { platform, error: e instanceof Error ? e.name : "Error" });
    throw new SocialError("PROVIDER_ERROR", true);
  }
  // YouTube answers an unfinished resumable upload with 308 (Resume Incomplete); any other 3xx is refused.
  if (r.status >= 300 && r.status < 400 && !(resumable && r.status === 308)) {
    await r.body?.cancel().catch(() => {});
    throw failure(platform, r.status, ["PROVIDER_ERROR", false], "redirect");
  }
  return r;
}

/** The JSON body, or null when there is none (never thrown: error answers are often HTML). */
export async function json(r: Response): Promise<any> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

export const form = (fields: Record<string, string>) => new URLSearchParams(fields);

/** An https URL on one of `hosts` (or their subdomains), before anything is sent to it. */
export function checkedUrl(platform: PlatformId, value: unknown, hosts: string[]) {
  try {
    const url = new URL(String(value));
    if (url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
        hosts.some((h) => url.hostname === h || url.hostname.endsWith("." + h)))
      return url.href;
  } catch {}
  throw failure(platform, 0, ["PROVIDER_ERROR", false], "unexpected_url");
}

/** Bytes `offset` … `offset + length - 1` of a stored file. */
export async function readRange(env: Env, key: string, offset: number, length: number): Promise<ArrayBuffer> {
  const o = await env.MEDIA.get(key, { range: { offset, length } });
  if (!o) throw new SocialError("NOT_READY");
  const bytes = await o.arrayBuffer();
  if (bytes.byteLength !== length) throw new SocialError("NOT_READY");
  return bytes;
}

/** At most `max` UTF-16 units (what the networks count), never splitting a surrogate pair. */
export function clip(text: string, max: number) {
  if (text.length <= max) return text;
  let out = text.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trimEnd();
}

/** A PKCE code verifier (RFC 7636): 64 unreserved characters. */
export const codeVerifier = () => b64url(crypto.getRandomValues(new Uint8Array(48)));
async function digest(text: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
/** The S256 challenge as RFC 7636 defines it (base64url). */
export const challenge = async (verifier: string) => b64url(await digest(verifier));
/** TikTok's variant: the SHA-256 of the verifier, hex-encoded. */
export const hexChallenge = async (verifier: string) =>
  Array.from(await digest(verifier), (b) => b.toString(16).padStart(2, "0")).join("");

export const bearer = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}` });
