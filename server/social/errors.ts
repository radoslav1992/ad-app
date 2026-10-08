import { platforms, type PlatformId } from "../../shared/social";
import type { FailureCode } from "./types";

/**
 * A provider call that failed, as a short code. The message never carries provider text, tokens or URLs; `detail` is
 * the provider's own error code (letters, digits, `_.-` only), safe to log.
 */
export class SocialError extends Error {
  /** The provider definitely did not publish anything (a refusal before or instead of the irreversible call). */
  nothingPosted = false;
  constructor(readonly code: FailureCode, readonly retryable = false, readonly status = 0, readonly detail = "") {
    super(`SOCIAL_${code}`);
    this.name = "SocialError";
  }
}

/** A provider error code reduced to something safe to log and compare. */
export const safeCode = (v: unknown) =>
  typeof v === "string" || typeof v === "number" ? String(v).replace(/[^\w.-]/g, "").slice(0, 60) : "";

/** The usual meaning of an HTTP status from a provider API. */
export function byStatus(status: number): [FailureCode, boolean] {
  if (status === 401) return ["AUTH_EXPIRED", false];
  if (status === 403) return ["PERMISSION", false];
  if (status === 429) return ["RATE_LIMITED", true];
  if (status === 408 || status >= 500 || status === 0) return ["PROVIDER_ERROR", true];
  return ["PROVIDER_ERROR", false];
}

/** Builds (and logs, without any payload) a provider failure. */
export function failure(platform: PlatformId, status: number, mapped?: [FailureCode, boolean] | null, detail = ""): SocialError {
  const [code, retryable] = mapped ?? byStatus(status);
  console.warn("Social API call failed", { platform, status, code, detail: safeCode(detail) });
  const e = new SocialError(code, retryable, status, safeCode(detail));
  // A clear refusal (4xx) or an overloaded gateway means the request was not carried out.
  e.nothingPosted = (status >= 400 && status < 500) || status === 502 || status === 503 || status === 504;
  return e;
}

/** OAuth token endpoint errors (RFC 6749 codes, shared by all four networks). */
export function oauthFailure(platform: PlatformId, status: number, error: unknown): SocialError {
  const code = safeCode(error);
  if (code === "invalid_grant") return failure(platform, status, ["AUTH_EXPIRED", false], code);
  if (code === "invalid_client" || code === "unauthorized_client") return failure(platform, status, ["NOT_CONFIGURED", false], code);
  if (code === "invalid_scope" || code === "access_denied") return failure(platform, status, ["PERMISSION", false], code);
  return failure(platform, status, status >= 400 && status < 500 && status !== 429 ? ["PROVIDER_ERROR", false] : null, code);
}

/** Whether nothing can have been published by the failed call. */
export const nothingPosted = (e: unknown) => e instanceof SocialError && e.nothingPosted;

/** What people read when publishing fails: short, plain English, no provider text. */
export function failureMessage(platform: PlatformId | null, code: string, detail = "") {
  const name = platform ? platforms[platform].name : "the network";
  if (platform === "tiktok" && detail === "unaudited_client_can_only_post_to_private_accounts")
    return "TikTok only accepts private posts from this app for now. Set your TikTok account to private, or try again later.";
  switch (code) {
    case "AUTH_EXPIRED": return `Reconnect your ${name} account, then try again.`;
    case "PERMISSION": return `Reconnect your ${name} account and allow posting, then try again.`;
    case "RATE_LIMITED": return `${name} is limiting how often this account can post. Try again later.`;
    case "ACCOUNT_LIMITED": return `${name} isn't letting this account post right now. Try again later.`;
    case "MEDIA_REJECTED": return `${name} didn't accept this post. Check that it meets ${name}'s requirements.`;
    case "NOT_CONFIGURED": return `Publishing to ${name} is not set up right now. Try again later.`;
    case "NO_CHANNEL": return "Create a YouTube channel for this Google account, then reconnect it.";
    case "TIMEOUT": return `${name} took too long to confirm this post. Check your ${name} profile before retrying.`;
    case "INTERRUPTED": return `Publishing was interrupted. Check your ${name} profile before retrying, so it isn't posted twice.`;
    case "NOT_READY": return "This post isn't ready to publish. Check that it is approved and finished.";
    case "PLAN": return "Auto-publishing needs a paid plan.";
    default: return `${name} had a problem publishing this post. Try again.`;
  }
}
