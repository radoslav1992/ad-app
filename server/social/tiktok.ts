import type { Env } from "../types";
import { now } from "../types";
import type { FailureCode, Platform, PublishContext, PublishResult, Ticket, Tokens } from "./types";
import { SocialError, failure, oauthFailure, safeCode } from "./errors";
import { bearer, checkedUrl, clip, form, hexChallenge, json, readRange, send } from "./http";

// TikTok: Login Kit (OAuth 2 v2) and the Content Posting API (Direct Post).
const AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com/v2";
const MiB = 1024 * 1024;
const SCOPES = ["user.info.basic", "video.publish"] as const;

// The provider's own error codes and what they mean for us.
const codes: Record<string, [FailureCode, boolean]> = {
  access_token_invalid: ["AUTH_EXPIRED", false],
  scope_not_authorized: ["PERMISSION", false],
  scope_permission_missed: ["PERMISSION", false],
  rate_limit_exceeded: ["RATE_LIMITED", true],
  spam_risk_too_many_posts: ["ACCOUNT_LIMITED", true],
  spam_risk_too_many_pending_share: ["ACCOUNT_LIMITED", true],
  spam_risk_user_banned_from_posting: ["ACCOUNT_LIMITED", false],
  spam_risk: ["ACCOUNT_LIMITED", false],
  reached_active_user_cap: ["ACCOUNT_LIMITED", true],
  unaudited_client_can_only_post_to_private_accounts: ["ACCOUNT_LIMITED", false],
  url_ownership_unverified: ["NOT_CONFIGURED", false],
  privacy_level_option_mismatch: ["PROVIDER_ERROR", false],
  file_format_check_failed: ["MEDIA_REJECTED", false],
  duration_check_failed: ["MEDIA_REJECTED", false],
  frame_rate_check_failed: ["MEDIA_REJECTED", false],
  picture_size_check_failed: ["MEDIA_REJECTED", false],
  video_pull_failed: ["MEDIA_REJECTED", true],
  photo_pull_failed: ["MEDIA_REJECTED", true],
  auth_removed: ["AUTH_EXPIRED", false],
  user_banned_from_posting: ["ACCOUNT_LIMITED", false],
  internal: ["PROVIDER_ERROR", true],
};

/** A Content Posting / user API call: JSON in, `{ data, error: { code: "ok" } }` out. */
async function api(tokens: Tokens, path: string, payload: unknown, timeout = 30_000) {
  const r = await send("tiktok", `${API}${path}`, {
    method: "POST",
    headers: { ...bearer(tokens.accessToken), "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(payload),
    timeout,
  });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  const code = safeCode(body?.error?.code);
  if (!r.ok || (code && code !== "ok")) throw failure("tiktok", r.status, codes[code] ?? null, code);
  return { data: (body?.data ?? {}) as Record<string, any>, text };
}

async function token(env: Env, fields: Record<string, string>): Promise<Tokens> {
  // https://developers.tiktok.com/doc/oauth-user-access-token-management
  const r = await send("tiktok", `${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: form({ client_key: env.TIKTOK_CLIENT_KEY!, client_secret: env.TIKTOK_CLIENT_SECRET!, ...fields }),
  });
  const d = await json(r);
  if (!r.ok || typeof d?.access_token !== "string" || !d.access_token) throw oauthFailure("tiktok", r.status, d?.error);
  const at = now();
  return {
    accessToken: d.access_token,
    refreshToken: typeof d.refresh_token === "string" ? d.refresh_token : undefined,
    expiresAt: at + (Number(d.expires_in) || 86400),
    refreshExpiresAt: d.refresh_expires_in ? at + Number(d.refresh_expires_in) : undefined,
    scope: typeof d.scope === "string" ? d.scope : undefined,
    extra: typeof d.open_id === "string" ? { openId: d.open_id } : undefined,
  };
}

type Creator = {
  level: string;
  options: string[];
  noComments: boolean;
  noDuet: boolean;
  noStitch: boolean;
  maxDuration: number;
  username: string;
};
/** What this creator may post right now: privacy levels and interaction settings. */
async function creator(tokens: Tokens): Promise<Creator> {
  // https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
  const { data } = await api(tokens, "/post/publish/creator_info/query/", {});
  const options = Array.isArray(data.privacy_level_options) ? data.privacy_level_options.filter((o: unknown) => typeof o === "string") : [];
  // Unaudited apps can only post privately: TikTok then offers (or accepts) SELF_ONLY alone.
  const level = options.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : options[0];
  if (!level) throw failure("tiktok", 200, ["ACCOUNT_LIMITED", false], "no_privacy_options");
  return {
    level,
    options,
    noComments: !!data.comment_disabled,
    noDuet: !!data.duet_disabled,
    noStitch: !!data.stitch_disabled,
    maxDuration: Number(data.max_video_post_duration_sec) || 0,
    username: typeof data.creator_username === "string" ? data.creator_username.slice(0, 100) : "",
  };
}

/** Starts a post; refused as public by an unaudited app, it is started again as private (nothing was posted yet). */
async function init(tokens: Tokens, path: string, c: Creator, payload: (level: string) => unknown) {
  try {
    return await api(tokens, path, payload(c.level));
  } catch (e) {
    if (e instanceof SocialError && e.detail === "unaudited_client_can_only_post_to_private_accounts" &&
        c.level !== "SELF_ONLY" && c.options.includes("SELF_ONLY"))
      return api(tokens, path, payload("SELF_ONLY"));
    throw e;
  }
}

/**
 * How a video is cut for FILE_UPLOAD: chunks of 5–64 MB sent in order, `total_chunk_count = floor(size / chunk_size)`,
 * the last chunk taking the remaining bytes (up to 128 MB); a file under 5 MB goes whole.
 * https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 */
export function tiktokChunks(size: number) {
  const chunk = 10 * MiB;
  if (size <= chunk) return { chunkSize: size, count: 1 };
  return { chunkSize: chunk, count: Math.floor(size / chunk) };
}

async function upload(env: Env, ctx: PublishContext, uploadUrl: string) {
  if (ctx.media.kind !== "video") return;
  const size = ctx.media.bytes;
  const { chunkSize, count } = tiktokChunks(size);
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
    const last = i === count - 1;
    try {
      const bytes = await readRange(env, ctx.media.key, start, end - start + 1);
      // https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
      const r = await send("tiktok", uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${size}` },
        body: bytes,
        timeout: 180_000,
      });
      await r.body?.cancel().catch(() => {});
      if (r.status !== 201 && r.status !== 206 && r.status !== 200) throw failure("tiktok", r.status, null, "upload");
    } catch (e) {
      // Until the last chunk is sent nothing can be published: the post may be started again from scratch.
      if (!last && e instanceof SocialError) e.nothingPosted = true;
      throw e;
    }
  }
}

/** The public post ID is a 64-bit number: read it from the text, JSON numbers lose its last digits. */
function postId(text: string) {
  return /"publicaly_available_post_id"\s*:\s*\[\s*"?(\d{1,25})/.exec(text)?.[1] ?? "";
}

export const tiktok: Platform = {
  id: "tiktok",
  configured: (env) => !!(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET),
  scopes: SCOPES,
  refreshWindow: 30 * 60,

  async authorizeUrl(env, { state, redirectUri, codeVerifier }) {
    // https://developers.tiktok.com/doc/login-kit-web (PKCE: https://developers.tiktok.com/doc/login-kit-desktop,
    // where TikTok defines code_challenge as the hex-encoded SHA-256 of the verifier).
    const q = new URLSearchParams({
      client_key: env.TIKTOK_CLIENT_KEY!,
      response_type: "code",
      scope: SCOPES.join(","),
      redirect_uri: redirectUri,
      state,
      code_challenge: await hexChallenge(codeVerifier),
      code_challenge_method: "S256",
    });
    return `${AUTHORIZE}?${q}`;
  },

  async exchange(env, { code, redirectUri, codeVerifier }) {
    const tokens = await token(env, { code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: codeVerifier });
    const granted = (tokens.scope || "").split(/[,\s]+/);
    if (!granted.includes("video.publish")) throw new SocialError("PERMISSION");
    // https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info (`username` needs user.info.profile; the
    // creator info below has it with video.publish).
    const r = await send("tiktok", `${API}/user/info/?fields=open_id,union_id,avatar_url,display_name`, { headers: bearer(tokens.accessToken) });
    const body = await json(r);
    const code2 = safeCode(body?.error?.code);
    const user = body?.data?.user;
    if (!r.ok || (code2 && code2 !== "ok") || typeof user?.open_id !== "string") throw failure("tiktok", r.status, codes[code2] ?? null, code2);
    let handle: string | undefined;
    try { handle = (await creator(tokens)).username || undefined; } catch { handle = undefined; }
    return {
      tokens,
      profile: {
        externalId: user.open_id,
        name: String(user.display_name || handle || "TikTok account").slice(0, 100),
        handle,
        avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : undefined,
      },
    };
  },

  async refresh(env, tokens) {
    if (!tokens.refreshToken) throw new SocialError("AUTH_EXPIRED");
    const next = await token(env, { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    return { ...tokens, ...next, refreshToken: next.refreshToken || tokens.refreshToken, refreshExpiresAt: next.refreshExpiresAt ?? tokens.refreshExpiresAt };
  },

  async publish(env, ctx): Promise<PublishResult> {
    const c = await creator(ctx.tokens);
    const username = ctx.account.handle || c.username;
    const media = ctx.media;
    if (media.kind === "video") {
      if (c.maxDuration && media.duration > c.maxDuration) throw failure("tiktok", 200, ["MEDIA_REJECTED", false], "duration_over_creator_limit");
      const { chunkSize, count } = tiktokChunks(media.bytes);
      // https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
      const { data } = await init(ctx.tokens, "/post/publish/video/init/", c, (level) => ({
        post_info: {
          title: clip(ctx.text, 2200),
          privacy_level: level,
          disable_duet: c.noDuet,
          disable_comment: c.noComments,
          disable_stitch: c.noStitch,
          video_cover_timestamp_ms: 1000,
          brand_content_toggle: false,
          brand_organic_toggle: false,
          is_aigc: ctx.synthetic,
        },
        source_info: { source: "FILE_UPLOAD", video_size: media.bytes, chunk_size: chunkSize, total_chunk_count: count },
      }));
      const publishId = safeCode(data.publish_id);
      if (!publishId) throw failure("tiktok", 200, ["PROVIDER_ERROR", false], "no_publish_id");
      const uploadUrl = checkedUrl("tiktok", data.upload_url, ["tiktokapis.com"]);
      // Once the last chunk is in, TikTok publishes on its own: from here on the post is only ever polled.
      const ticket: Ticket = { stage: "status", publishId, kind: "video", username };
      await ctx.checkpoint(ticket);
      await upload(env, ctx, uploadUrl);
      return { state: "processing", ticket };
    }
    // Photo posts are fetched by TikTok from our media links (PULL_FROM_URL): the site's domain (or URL prefix) must
    // be verified in the TikTok developer portal, or TikTok answers url_ownership_unverified.
    await ctx.checkpoint({ stage: "init", kind: "photos", username });
    // https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
    const { data } = await init(ctx.tokens, "/post/publish/content/init/", c, (level) => ({
      post_info: {
        title: clip(ctx.title, 90),
        description: clip(ctx.text, 4000),
        disable_comment: c.noComments,
        privacy_level: level,
        auto_add_music: true,
        brand_content_toggle: false,
        brand_organic_toggle: false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        photo_cover_index: 0,
        photo_images: media.items.slice(0, 35).map((i) => i.url),
      },
      post_mode: "DIRECT_POST",
      media_type: "PHOTO",
    }));
    const publishId = safeCode(data.publish_id);
    if (!publishId) throw failure("tiktok", 200, ["PROVIDER_ERROR", false], "no_publish_id");
    return { state: "processing", ticket: { stage: "status", publishId, kind: "photos", username } };
  },

  async status(_env, ctx, ticket): Promise<PublishResult> {
    // A photo post whose start was interrupted: TikTok may or may not have it, and it has no ID to ask about.
    if (!ticket.publishId) return { state: "failed", code: "INTERRUPTED", retryable: false };
    // https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
    const { data, text } = await api(ctx.tokens, "/post/publish/status/fetch/", { publish_id: ticket.publishId });
    switch (data.status) {
      case "PUBLISH_COMPLETE": {
        // Public posts get their ID once TikTok's moderation is done; a private (SELF_ONLY) post never gets one.
        const id = postId(text);
        const user = ticket.username || ctx.account.handle;
        return {
          state: "published",
          externalId: id || ticket.publishId,
          url: id && user ? `https://www.tiktok.com/@${encodeURIComponent(user)}/${ticket.kind === "photos" ? "photo" : "video"}/${id}` : undefined,
        };
      }
      case "FAILED": {
        const reason = safeCode(data.fail_reason);
        const [code, retryable] = codes[reason] ?? ["PROVIDER_ERROR", false];
        console.warn("TikTok post failed", { publicationId: ctx.publicationId, code, detail: reason });
        return { state: "failed", code, retryable, detail: reason };
      }
      default:
        // PROCESSING_UPLOAD, PROCESSING_DOWNLOAD (and SEND_TO_USER_INBOX, which Direct Post does not use).
        return { state: "processing", ticket };
    }
  },
};
