import type { Env } from "../types";
import { now } from "../types";
import type { FailureCode, Platform, PublishContext, PublishResult, Tokens } from "./types";
import { SocialError, failure, oauthFailure, safeCode } from "./errors";
import { bearer, challenge, checkedUrl, clip, form, json, readRange, send } from "./http";

// YouTube: Google OAuth 2 (web server flow with PKCE) and the YouTube Data API v3 resumable upload.
const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const SCOPES = [UPLOAD_SCOPE, "https://www.googleapis.com/auth/youtube.readonly"] as const;
/** Upload chunk: a multiple of 256 KiB, as the resumable protocol requires; bounded memory and resumable. */
export const YOUTUBE_CHUNK = 16 * 1024 * 1024;

const reasons: Record<string, [FailureCode, boolean]> = {
  authError: ["AUTH_EXPIRED", false],
  insufficientPermissions: ["PERMISSION", false],
  forbidden: ["PERMISSION", false],
  youtubeSignupRequired: ["NO_CHANNEL", false],
  quotaExceeded: ["RATE_LIMITED", true],
  rateLimitExceeded: ["RATE_LIMITED", true],
  userRateLimitExceeded: ["RATE_LIMITED", true],
  uploadLimitExceeded: ["ACCOUNT_LIMITED", true],
  invalidTitle: ["MEDIA_REJECTED", false],
  invalidDescription: ["MEDIA_REJECTED", false],
  invalidCategoryId: ["MEDIA_REJECTED", false],
  invalidVideoMetadata: ["MEDIA_REJECTED", false],
  mediaBodyRequired: ["MEDIA_REJECTED", false],
  backendError: ["PROVIDER_ERROR", true],
  internalError: ["PROVIDER_ERROR", true],
};
async function googleFailure(r: Response) {
  const d = await json(r);
  const reason = safeCode(d?.error?.errors?.[0]?.reason);
  return failure("youtube", r.status, reasons[reason] ?? null, reason);
}

async function token(env: Env, fields: Record<string, string>): Promise<Tokens> {
  // https://developers.google.com/identity/protocols/oauth2/web-server#exchange-authorization-code
  const r = await send("youtube", TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...fields }),
  });
  const d = await json(r);
  if (!r.ok || typeof d?.access_token !== "string") throw oauthFailure("youtube", r.status, d?.error);
  const at = now();
  return {
    accessToken: d.access_token,
    refreshToken: typeof d.refresh_token === "string" ? d.refresh_token : undefined,
    expiresAt: at + (Number(d.expires_in) || 3600),
    // Only set for apps in testing (7 days) or time-limited consent; production refresh tokens do not expire.
    refreshExpiresAt: d.refresh_token_expires_in ? at + Number(d.refresh_token_expires_in) : undefined,
    scope: typeof d.scope === "string" ? d.scope : undefined,
  };
}

/** YouTube refuses "<" and ">" in titles and descriptions; descriptions are limited to 5,000 bytes. */
const plain = (s: string) => s.replace(/[<>]/g, "");
function clipBytes(s: string, max: number) {
  const encoder = new TextEncoder();
  let size = 0, out = "";
  for (const ch of s) {
    size += encoder.encode(ch).length;
    if (size > max) break;
    out += ch;
  }
  return out;
}

function result(ctx: PublishContext, video: any): PublishResult {
  const id = typeof video?.id === "string" && /^[\w-]{6,20}$/.test(video.id) ? video.id : "";
  const upload = video?.status?.uploadStatus;
  if (upload === "rejected" || upload === "failed") {
    const detail = safeCode(video?.status?.rejectionReason || video?.status?.failureReason);
    console.warn("YouTube upload refused", { publicationId: ctx.publicationId, detail });
    return { state: "failed", code: "MEDIA_REJECTED", retryable: false, detail };
  }
  if (!id) throw failure("youtube", 200, ["PROVIDER_ERROR", false], "no_video_id");
  return { state: "published", externalId: id, url: `https://youtube.com/shorts/${id}` };
}

/** Where to continue after a 308: the byte after the last one Google has ("Range: bytes=0-N"), or 0. */
const nextByte = (range: string | null) => {
  const m = /bytes=0-(\d+)/.exec(range || "");
  return m ? Number(m[1]) + 1 : 0;
};

/** Sends the file from `offset` on, in 256 KiB-aligned chunks, to an upload session. */
async function uploadFrom(env: Env, ctx: PublishContext, session: string, offset: number): Promise<PublishResult> {
  if (ctx.media.kind !== "video") throw new SocialError("NOT_READY");
  const { key, bytes: size } = ctx.media;
  for (let start = offset, rounds = 0; rounds < Math.ceil(size / YOUTUBE_CHUNK) * 3 + 3; rounds++) {
    const end = Math.min(start + YOUTUBE_CHUNK, size) - 1;
    // https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol#Upload_Chunks
    const r = await send("youtube", session, {
      method: "PUT",
      headers: { ...bearer(ctx.tokens.accessToken), "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${size}` },
      body: await readRange(env, key, start, end - start + 1),
      timeout: 300_000,
      resumable: true,
    });
    if (r.status === 200 || r.status === 201) return result(ctx, await json(r));
    if (r.status !== 308) throw await googleFailure(r);
    await r.body?.cancel().catch(() => {});
    start = nextByte(r.headers.get("Range"));
  }
  throw failure("youtube", 308, ["PROVIDER_ERROR", true], "upload_incomplete");
}

export const youtube: Platform = {
  id: "youtube",
  configured: (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  scopes: SCOPES,
  refreshWindow: 15 * 60,

  async authorizeUrl(env, { state, redirectUri, codeVerifier }) {
    // https://developers.google.com/identity/protocols/oauth2/web-server#creatingclient
    const q = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: await challenge(codeVerifier),
      code_challenge_method: "S256",
    });
    return `${AUTHORIZE}?${q}`;
  },

  async exchange(env, { code, redirectUri, codeVerifier }) {
    const tokens = await token(env, { code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: codeVerifier });
    // Granular consent lets people untick a scope: without upload there is nothing to connect.
    if (!(tokens.scope || "").split(" ").includes(UPLOAD_SCOPE)) throw new SocialError("PERMISSION");
    if (!tokens.refreshToken) throw failure("youtube", 200, ["PROVIDER_ERROR", false], "no_refresh_token");
    // https://developers.google.com/youtube/v3/docs/channels/list
    const r = await send("youtube", `${API}/channels?part=snippet&mine=true`, { headers: bearer(tokens.accessToken) });
    if (!r.ok) throw await googleFailure(r);
    const channel = (await json(r))?.items?.[0];
    if (typeof channel?.id !== "string") throw new SocialError("NO_CHANNEL");
    const s = channel.snippet || {};
    return {
      tokens,
      profile: {
        externalId: channel.id,
        name: String(s.title || "YouTube channel").slice(0, 100),
        handle: typeof s.customUrl === "string" ? s.customUrl.replace(/^@/, "").slice(0, 100) : undefined,
        avatarUrl: typeof s.thumbnails?.default?.url === "string" ? s.thumbnails.default.url : undefined,
      },
    };
  },

  async refresh(env, tokens) {
    if (!tokens.refreshToken) throw new SocialError("AUTH_EXPIRED");
    // https://developers.google.com/identity/protocols/oauth2/web-server#offline
    const next = await token(env, { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    return { ...tokens, ...next, refreshToken: next.refreshToken || tokens.refreshToken, refreshExpiresAt: next.refreshExpiresAt ?? tokens.refreshExpiresAt };
  },

  async publish(env, ctx): Promise<PublishResult> {
    // Shorts are vertical videos up to 3 minutes; slideshows go as their video (YouTube has no photo posts).
    if (ctx.media.kind !== "video") throw new SocialError("NOT_READY");
    const title = clip(plain(ctx.title).trim(), 100) || "Short";
    const description = clipBytes(plain(ctx.text), 5000 - 8) + " #Shorts";
    // https://developers.google.com/youtube/v3/docs/videos/insert and
    // https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
    const r = await send("youtube", `${UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: {
        ...bearer(ctx.tokens.accessToken),
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(ctx.media.bytes),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify({
        snippet: { title, description: description.trim(), categoryId: "22" },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false, containsSyntheticMedia: ctx.synthetic },
      }),
    });
    if (!r.ok) throw await googleFailure(r);
    await r.body?.cancel().catch(() => {});
    const session = checkedUrl("youtube", r.headers.get("Location"), ["googleapis.com"]);
    // One session makes at most one video: an interrupted upload is resumed through it, never started again.
    await ctx.checkpoint({ stage: "upload", session });
    return uploadFrom(env, ctx, session, 0);
  },

  async status(env, ctx, ticket): Promise<PublishResult> {
    if (ctx.media.kind !== "video" || !ticket.session) return { state: "failed", code: "INTERRUPTED", retryable: false };
    const session = checkedUrl("youtube", ticket.session, ["googleapis.com"]);
    // https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol#Check_Upload_Status
    const r = await send("youtube", session, {
      method: "PUT",
      headers: { ...bearer(ctx.tokens.accessToken), "Content-Range": `bytes */${ctx.media.bytes}` },
      body: "",
      resumable: true,
    });
    if (r.status === 200 || r.status === 201) return result(ctx, await json(r));
    if (r.status === 308) {
      await r.body?.cancel().catch(() => {});
      return uploadFrom(env, ctx, session, nextByte(r.headers.get("Range")));
    }
    // The session expired before the upload finished: no video was created.
    if (r.status === 404 || r.status === 410) return { state: "failed", code: "PROVIDER_ERROR", retryable: true, detail: "upload_session_expired" };
    throw await googleFailure(r);
  },
};
