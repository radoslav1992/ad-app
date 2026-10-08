import type { Env } from "../types";
import { now } from "../types";
import type { FailureCode, Platform, PublishContext, PublishResult, Ticket, Tokens } from "./types";
import { SocialError, failure, oauthFailure, safeCode } from "./errors";
import { bearer, checkedUrl, clip, form, json, readRange, send } from "./http";

// LinkedIn: Sign In with LinkedIn using OpenID Connect + "Share on LinkedIn" (w_member_social), posting to the
// member's own profile with the versioned Posts, Videos and Images APIs.
const AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
const API = "https://api.linkedin.com";
const SCOPES = ["openid", "profile", "w_member_social"] as const;
/**
 * The API version (YYYYMM) sent as LinkedIn-Version. LinkedIn supports each version for about a year
 * (https://learn.microsoft.com/linkedin/marketing/versioning): move it forward at least once a year.
 */
export const LINKEDIN_VERSION = "202607";

const URN = /^urn:li:(video|image):[\w-]{1,120}$/;
const POST_URN = /^urn:li:(share|ugcPost):\d{1,30}$/;

function linkedinCode(status: number, d: any): [FailureCode, boolean] | null {
  const code = safeCode(d?.code);
  if (status === 401 || code === "EXPIRED_ACCESS_TOKEN" || code === "REVOKED_ACCESS_TOKEN") return ["AUTH_EXPIRED", false];
  if (status === 426 || code === "VERSION_MISSING" || code === "NONEXISTENT_VERSION") return ["NOT_CONFIGURED", false];
  if (status === 422) return ["MEDIA_REJECTED", false];
  return null;
}

async function rest(tokens: Tokens, method: string, path: string, body?: unknown) {
  const r = await send("linkedin", `${API}${path}`, {
    method,
    headers: {
      ...bearer(tokens.accessToken),
      "LinkedIn-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const d = await json(r);
    throw failure("linkedin", r.status, linkedinCode(r.status, d), safeCode(d?.code || d?.serviceErrorCode));
  }
  return r;
}

async function token(env: Env, fields: Record<string, string>): Promise<Tokens> {
  // https://learn.microsoft.com/linkedin/shared/authentication/authorization-code-flow
  const r = await send("linkedin", TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ client_id: env.LINKEDIN_CLIENT_ID!, client_secret: env.LINKEDIN_CLIENT_SECRET!, ...fields }),
  });
  const d = await json(r);
  if (!r.ok || typeof d?.access_token !== "string") throw oauthFailure("linkedin", r.status, d?.error);
  const at = now();
  // Refresh tokens are only issued to some apps (https://learn.microsoft.com/linkedin/shared/authentication/programmatic-refresh-tokens);
  // without one the connection ends with the access token (60 days).
  return {
    accessToken: d.access_token,
    expiresAt: at + (Number(d.expires_in) || 60 * 86400),
    refreshToken: typeof d.refresh_token === "string" ? d.refresh_token : undefined,
    refreshExpiresAt: d.refresh_token_expires_in ? at + Number(d.refresh_token_expires_in) : undefined,
    scope: typeof d.scope === "string" ? d.scope : undefined,
  };
}

/** LinkedIn's "little text" format: reserved characters are escaped, hashtags use the hashtag template. */
const LITTLE = /[\\|{}@[\]()<>#*_~]/g;
const escapeLittle = (s: string) => s.replace(LITTLE, "\\$&");
export function commentary(caption: string, hashtags: string[]) {
  const tags = hashtags.map((h) => `{hashtag|\\#|${escapeLittle(h.replace(/^#/, ""))}}`).join(" ");
  const room = 3000 - (tags ? tags.length + 2 : 0);
  let body = "";
  for (const ch of caption) {
    const e = escapeLittle(ch);
    if (body.length + e.length > room) break;
    body += e;
  }
  return [body.trim(), tags].filter(Boolean).join("\n\n");
}

const owner = (ctx: PublishContext) => `urn:li:person:${ctx.account.externalId}`;

async function uploadVideo(env: Env, ctx: PublishContext): Promise<string> {
  if (ctx.media.kind !== "video") throw new SocialError("NOT_READY");
  const size = ctx.media.bytes;
  // https://learn.microsoft.com/linkedin/marketing/community-management/shares/videos-api#initialize-video-upload
  const init = await json(await rest(ctx.tokens, "POST", "/rest/videos?action=initializeUpload", {
    initializeUploadRequest: { owner: owner(ctx), fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false },
  }));
  const value = init?.value;
  const video = String(value?.video || "");
  const parts: { uploadUrl: string; firstByte: number; lastByte: number }[] = Array.isArray(value?.uploadInstructions) ? value.uploadInstructions : [];
  if (!URN.test(video) || !parts.length || parts.length > 1000) throw failure("linkedin", 200, ["PROVIDER_ERROR", false], "bad_upload_instructions");
  const etags: string[] = [];
  let expected = 0;
  for (const part of parts) {
    const first = Number(part.firstByte), last = Number(part.lastByte);
    if (first !== expected || last < first || last >= size) throw failure("linkedin", 200, ["PROVIDER_ERROR", false], "bad_upload_instructions");
    expected = last + 1;
    // https://learn.microsoft.com/linkedin/marketing/community-management/shares/videos-api#upload-the-video
    const r = await send("linkedin", checkedUrl("linkedin", part.uploadUrl, ["linkedin.com"]), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: await readRange(env, ctx.media.key, first, last - first + 1),
      timeout: 180_000,
    });
    await r.body?.cancel().catch(() => {});
    const etag = r.headers.get("etag");
    if (!r.ok || !etag) throw failure("linkedin", r.status, null, "upload_part");
    etags.push(etag);
  }
  if (expected !== size) throw failure("linkedin", 200, ["PROVIDER_ERROR", false], "bad_upload_instructions");
  // https://learn.microsoft.com/linkedin/marketing/community-management/shares/videos-api#finalize-video-upload
  await rest(ctx.tokens, "POST", "/rest/videos?action=finalizeUpload", {
    finalizeUploadRequest: { video, uploadToken: typeof value.uploadToken === "string" ? value.uploadToken : "", uploadedPartIds: etags },
  });
  return video;
}

async function uploadImage(env: Env, ctx: PublishContext, file: { key: string; bytes: number }): Promise<string> {
  // https://learn.microsoft.com/linkedin/marketing/community-management/shares/images-api#initialize-image-upload
  const init = await json(await rest(ctx.tokens, "POST", "/rest/images?action=initializeUpload", { initializeUploadRequest: { owner: owner(ctx) } }));
  const image = String(init?.value?.image || "");
  if (!URN.test(image)) throw failure("linkedin", 200, ["PROVIDER_ERROR", false], "bad_upload_instructions");
  const r = await send("linkedin", checkedUrl("linkedin", init.value.uploadUrl, ["linkedin.com"]), {
    method: "PUT",
    headers: { ...bearer(ctx.tokens.accessToken), "Content-Type": "application/octet-stream" },
    body: await readRange(env, file.key, 0, file.bytes),
    timeout: 120_000,
  });
  await r.body?.cancel().catch(() => {});
  if (!r.ok) throw failure("linkedin", r.status, null, "upload_image");
  return image;
}

/** AVAILABLE, PROCESSING, WAITING_UPLOAD or PROCESSING_FAILED. */
async function assetStatus(tokens: Tokens, urn: string) {
  const kind = urn.startsWith("urn:li:video:") ? "videos" : "images";
  // https://learn.microsoft.com/linkedin/marketing/community-management/shares/videos-api#get-a-video
  const d = await json(await rest(tokens, "GET", `/rest/${kind}/${encodeURIComponent(urn)}`));
  return String(d?.status || "");
}

async function createPost(ctx: PublishContext, ticket: Ticket, content: unknown): Promise<PublishResult> {
  // Creating the post is the irreversible call, and LinkedIn has no idempotency key: mark it first.
  await ctx.checkpoint({ ...ticket, stage: "post" });
  let r: Response;
  try {
    // https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api#create-a-post
    r = await rest(ctx.tokens, "POST", "/rest/posts", {
      author: owner(ctx),
      commentary: commentary(ctx.caption, ctx.hashtags),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content,
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
  } catch (e) {
    // Refused outright: nothing was posted, so the next check may try again.
    if (e instanceof SocialError && e.nothingPosted) await ctx.checkpoint(ticket);
    throw e;
  }
  await r.body?.cancel().catch(() => {});
  const urn = r.headers.get("x-restli-id") || "";
  if (!POST_URN.test(urn)) return { state: "published", externalId: "" };
  return { state: "published", externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}/` };
}

export const linkedin: Platform = {
  id: "linkedin",
  configured: (env) => !!(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET),
  scopes: SCOPES,
  refreshWindow: 24 * 3600,

  async authorizeUrl(env, { state, redirectUri }) {
    // https://learn.microsoft.com/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2 (no PKCE for
    // web apps: the code is exchanged with the client secret).
    const q = new URLSearchParams({ response_type: "code", client_id: env.LINKEDIN_CLIENT_ID!, redirect_uri: redirectUri, state, scope: SCOPES.join(" ") });
    return `${AUTHORIZE}?${q}`;
  },

  async exchange(env, { code, redirectUri }) {
    const tokens = await token(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
    if (tokens.scope && !tokens.scope.split(/[,\s]+/).includes("w_member_social")) throw new SocialError("PERMISSION");
    // https://learn.microsoft.com/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2#api-request-to-retreive-member-details
    const r = await send("linkedin", `${API}/v2/userinfo`, { headers: bearer(tokens.accessToken) });
    const me = await json(r);
    if (!r.ok || typeof me?.sub !== "string" || !/^[\w-]{1,100}$/.test(me.sub)) throw failure("linkedin", r.status, linkedinCode(r.status, me), "userinfo");
    return {
      tokens,
      profile: {
        externalId: me.sub,
        name: String(me.name || [me.given_name, me.family_name].filter(Boolean).join(" ") || "LinkedIn member").slice(0, 100),
        avatarUrl: typeof me.picture === "string" ? me.picture : undefined,
      },
    };
  },

  async refresh(env, tokens) {
    if (!tokens.refreshToken) throw new SocialError("AUTH_EXPIRED");
    const next = await token(env, { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
    return { ...tokens, ...next, refreshToken: next.refreshToken || tokens.refreshToken, refreshExpiresAt: next.refreshExpiresAt ?? tokens.refreshExpiresAt };
  },

  async publish(env, ctx): Promise<PublishResult> {
    // Uploads are not visible to anyone until a post uses them.
    if (ctx.media.kind === "video") return { state: "processing", ticket: { stage: "video", video: await uploadVideo(env, ctx) } };
    const images: string[] = [];
    for (const item of ctx.media.items.slice(0, 20)) images.push(await uploadImage(env, ctx, item));
    return { state: "processing", ticket: { stage: "images", images: images.join(",") } };
  },

  async status(_env, ctx, ticket): Promise<PublishResult> {
    if (ticket.stage === "video" && URN.test(ticket.video)) {
      const s = await assetStatus(ctx.tokens, ticket.video);
      if (s === "PROCESSING_FAILED") return { state: "failed", code: "MEDIA_REJECTED", retryable: false, detail: "processing_failed" };
      if (s !== "AVAILABLE") return { state: "processing", ticket };
      return createPost(ctx, ticket, { media: { id: ticket.video, title: clip(ctx.title, 100) } });
    }
    if (ticket.stage === "images") {
      const images = String(ticket.images || "").split(",").filter((u) => URN.test(u));
      if (!images.length) return { state: "failed", code: "INTERRUPTED", retryable: false };
      for (const image of images) {
        const s = await assetStatus(ctx.tokens, image);
        if (s === "PROCESSING_FAILED") return { state: "failed", code: "MEDIA_REJECTED", retryable: false, detail: "processing_failed" };
        if (s !== "AVAILABLE") return { state: "processing", ticket };
      }
      const content = images.length === 1
        ? { media: { id: images[0], altText: clip(ctx.title, 120) } }
        : { multiImage: { images: images.map((id) => ({ id, altText: clip(ctx.title, 120) })) } };
      return createPost(ctx, ticket, content);
    }
    // stage "post": the post may or may not exist, and LinkedIn cannot be asked without more permissions.
    return { state: "failed", code: "INTERRUPTED", retryable: false };
  },
};
