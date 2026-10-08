// Calls to paid AI providers. workerd accepts only "follow" or "manual" redirects: redirects are rejected so a
// credential or a paid POST is never forwarded somewhere else. Provider messages are never stored or logged (they
// can echo prompts or personal data); failures become short codes.

/** A provider failure with a stable code (survives Workflow serialization as the message). */
export class ProviderError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export async function providerFetch(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ProviderError("PROVIDER_REDIRECT");
  }
  return response;
}
/** A fal queue URL (status/result) as returned by the queue; anything else is refused. */
export function falQueueUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== "https://queue.fal.run" || url.username || url.password || !url.pathname.includes("/requests/")) throw new ProviderError("PROVIDER_URL");
  return url.href;
}
/** Hosts provider outputs are downloaded from (fal, HeyGen and their storage/CDNs). */
export function outputUrl(value: string) {
  const url = new URL(value);
  const allowed = ["fal.media", "falserverless.io", "fal.run", "amazonaws.com", "storage.googleapis.com", "cloudfront.net", "heygen.ai", "heygen.com"];
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowed.some((h) => url.hostname === h || url.hostname.endsWith("." + h)))
    throw new ProviderError("PROVIDER_URL");
  return url.href;
}
/** Downloads a provider output, following at most two CDN redirects; every hop must pass outputUrl. */
export async function fetchOutput(url: string, signal: AbortSignal) {
  let next = outputUrl(url);
  for (let hop = 0; hop <= 2; hop++) {
    const r = await fetch(next, { redirect: "manual", signal });
    if (r.status < 300 || r.status >= 400) return r;
    await r.body?.cancel();
    const location = r.headers.get("Location");
    if (!location || hop === 2) break;
    next = outputUrl(new URL(location, next).href);
  }
  throw new ProviderError("PROVIDER_DOWNLOAD");
}
/** Classifies a failed provider response without reading its message into logs. */
export async function failureCode(r: Response, prefix: string) {
  const body = (await r.json().catch(() => null)) as any;
  const types = [body?.error_type, ...(Array.isArray(body?.detail) ? body.detail.map((d: any) => d?.type) : [])];
  const detail = typeof body?.detail === "string" ? body.detail.toLowerCase() : typeof body?.error?.message === "string" ? body.error.message.toLowerCase() : "";
  if (types.includes("content_policy_violation") || /content.?policy|safety|nsfw|moderat/.test(detail)) return `${prefix}_REJECTED`;
  if ([401, 402, 403].includes(r.status) || /balance|credits|top.?up|quota/.test(detail)) return `${prefix}_UNAVAILABLE`;
  if (r.status === 429) return `${prefix}_BUSY`;
  return `${prefix}_FAILED`;
}
