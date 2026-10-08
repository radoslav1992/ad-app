import type { Env } from "../types";
import { now } from "../types";
import type { PlatformId } from "../../shared/social";
import { open, seal } from "../crypto";
import { platformFor } from "./index";
import { SocialError } from "./errors";
import type { Tokens } from "./types";

export type AccountRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  platform: PlatformId;
  external_id: string;
  name: string;
  handle: string | null;
  avatar_url: string | null;
  credentials: string;
  expires_at: number | null;
  status: "active" | "expired" | "revoked";
  created_at: number;
  updated_at: number;
};

/**
 * When the connection stops working unless the person reconnects: the refresh token's end (none for Google), or the
 * access token's when there is no refresh token. Instagram's long-lived token is refreshed with itself.
 */
export function connectionExpiry(platform: PlatformId, tokens: Tokens): number | null {
  if (platform !== "instagram" && tokens.refreshToken) return tokens.refreshExpiresAt ?? null;
  return tokens.expiresAt ?? null;
}

async function readTokens(env: Env, sealed: string) {
  try {
    return await open<Tokens>(env, sealed);
  } catch (e) {
    // Unset key: a 503 for the request. A key change or damaged value: the account has to be connected again.
    if (e instanceof Error && e.message === "Sealed value is not readable") throw new SocialError("AUTH_EXPIRED");
    throw e;
  }
}

/**
 * The account's tokens, refreshed first when they are about to expire. Two workers refreshing at once (TikTok rotates
 * refresh tokens) settle on whichever saved first; a token that still works is used when a refresh fails.
 */
export async function freshTokens(env: Env, account: AccountRow): Promise<Tokens> {
  const platform = platformFor(account.platform);
  const tokens = await readTokens(env, account.credentials);
  const left = (tokens.expiresAt ?? Number.MAX_SAFE_INTEGER) - now();
  if (left > platform.refreshWindow) return tokens;
  const refreshable = !!platform.refresh && (platform.id === "instagram" || !!tokens.refreshToken);
  if (!refreshable) {
    if (left > 60) return tokens;
    throw new SocialError("AUTH_EXPIRED");
  }
  let next: Tokens;
  try {
    next = await platform.refresh!(env, tokens);
  } catch (e) {
    const current = await env.DB.prepare("SELECT credentials FROM social_accounts WHERE id=?").bind(account.id).first<{ credentials: string }>();
    if (current && current.credentials !== account.credentials) return readTokens(env, current.credentials);
    if (left > 5 * 60) {
      console.warn("Social token refresh failed; using the current token", { platform: platform.id, account: account.id, code: (e as Error)?.message });
      return tokens;
    }
    throw e;
  }
  const sealed = await seal(env, next);
  const saved = await env.DB.prepare("UPDATE social_accounts SET credentials=?,expires_at=?,status='active',updated_at=? WHERE id=? AND credentials=?")
    .bind(sealed, connectionExpiry(platform.id, next), now(), account.id, account.credentials)
    .run();
  if (!saved.meta.changes) {
    const current = await env.DB.prepare("SELECT credentials FROM social_accounts WHERE id=?").bind(account.id).first<{ credentials: string }>();
    if (current) return readTokens(env, current.credentials);
  }
  account.credentials = sealed;
  return next;
}

/** The person has to connect the account again (tokens expired, revoked or unreadable). */
export async function markExpired(env: Env, accountId: string) {
  await env.DB.prepare("UPDATE social_accounts SET status='expired',updated_at=? WHERE id=? AND status='active'").bind(now(), accountId).run();
}
