import { now } from "../types";
import type { FailureCode, Platform, PostStats, PublishContext, PublishResult, Tokens } from "./types";
import { SocialError, failure, oauthFailure, safeCode } from "./errors";
import { bearer, count, form, json, send } from "./http";

// Instagram API with Instagram Login (professional accounts), on graph.instagram.com.
const AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const TOKEN = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";
const VERSION = "v23.0";
// manage_insights reads views and shares (likes and comments come with basic); connections made before it was asked
// for lack it and are asked to reconnect.
const INSIGHTS_SCOPE = "instagram_business_manage_insights";
const SCOPES = ["instagram_business_basic", "instagram_business_content_publish", INSIGHTS_SCOPE] as const;
const DAY = 86400;

/** Meta error codes (and subcodes) and what they mean for us. */
function metaCode(status: number, error: any): [FailureCode, boolean] | null {
  const code = Number(error?.code), sub = Number(error?.error_subcode);
  if (code === 190) return ["AUTH_EXPIRED", false];
  if (code === 10 || (code >= 200 && code < 300)) return ["PERMISSION", false];
  if (sub === 2207042) return ["RATE_LIMITED", true]; // the 24-hour publishing limit
  if (sub === 2207051) return ["ACCOUNT_LIMITED", false]; // blocked as spam / restricted
  if ([4, 9, 17, 32, 613].includes(code)) return ["RATE_LIMITED", true];
  if (code === 1 || code === 2) return ["PROVIDER_ERROR", true];
  if (code === 9004 || sub === 2207052) return ["MEDIA_REJECTED", true]; // could not fetch our media link
  if (code === 352 || (code >= 36000 && code <= 36010) || (sub >= 2207000 && sub < 2208000)) return ["MEDIA_REJECTED", false];
  return status >= 400 && status < 500 && status !== 429 ? ["PROVIDER_ERROR", false] : null;
}

async function graph(tokens: Tokens, path: string, init: { method?: string; body?: Record<string, string>; query?: Record<string, string> } = {}) {
  const q = init.query ? `?${new URLSearchParams(init.query)}` : "";
  const r = await send("instagram", `${GRAPH}/${VERSION}${path}${q}`, {
    method: init.method || "GET",
    headers: { ...bearer(tokens.accessToken), ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: init.body ? form(init.body) : undefined,
  });
  const d = await json(r);
  if (!r.ok || d?.error) {
    const e = d?.error;
    throw failure("instagram", r.status, metaCode(r.status, e), `${safeCode(e?.code)}${e?.error_subcode ? "." + safeCode(e.error_subcode) : ""}`);
  }
  return d ?? {};
}

const id = (v: unknown) => (typeof v === "string" || typeof v === "number") && /^\d{1,30}$/.test(String(v)) ? String(v) : "";

/** A long-lived token (60 days) for a short-lived one, or a refreshed long-lived token. */
async function longLived(url: string): Promise<Tokens> {
  const r = await send("instagram", url);
  const d = await json(r);
  if (!r.ok || typeof d?.access_token !== "string") {
    const e = d?.error;
    throw failure("instagram", r.status, typeof e === "object" ? metaCode(r.status, e) : null, safeCode(e?.code ?? e));
  }
  return { accessToken: d.access_token, expiresAt: now() + (Number(d.expires_in) || 60 * DAY) };
}

/** A media insights answer (metric=views,shares) as counts; a metric Instagram didn't return stays null. */
export function instagramInsights(body: any): { views: number | null; shares: number | null } {
  const out: { views: number | null; shares: number | null } = { views: null, shares: null };
  for (const m of Array.isArray(body?.data) ? body.data : []) {
    const value = count(m?.values?.[0]?.value ?? m?.total_value?.value);
    if (m?.name === "views") out.views = value;
    if (m?.name === "shares") out.shares = value;
  }
  return out;
}

async function container(tokens: Tokens, igId: string, fields: Record<string, string>) {
  // https://developers.facebook.com/docs/instagram-platform/content-publishing
  const d = await graph(tokens, `/${igId}/media`, { method: "POST", body: fields });
  const c = id(d.id);
  if (!c) throw failure("instagram", 200, ["PROVIDER_ERROR", false], "no_container");
  return c;
}

async function permalink(tokens: Tokens, mediaId: string) {
  try {
    const d = await graph(tokens, `/${mediaId}`, { query: { fields: "permalink" } });
    const url = new URL(String(d.permalink));
    return url.protocol === "https:" && (url.hostname === "instagram.com" || url.hostname.endsWith(".instagram.com")) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

async function publishContainer(ctx: PublishContext, creation: string): Promise<PublishResult> {
  // https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish
  // A container can only ever be published once, so asking again after an interruption cannot post twice.
  const d = await graph(ctx.tokens, `/${ctx.account.externalId}/media_publish`, { method: "POST", body: { creation_id: creation } });
  const mediaId = id(d.id);
  if (!mediaId) throw failure("instagram", 200, ["PROVIDER_ERROR", false], "no_media_id");
  return { state: "published", externalId: mediaId, url: await permalink(ctx.tokens, mediaId) };
}

export const instagram: Platform = {
  id: "instagram",
  configured: (env) => !!(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET),
  scopes: SCOPES,
  // Long-lived tokens last 60 days and are refreshed in their last 10 (they must be at least a day old).
  refreshWindow: 10 * DAY,

  async authorizeUrl(env, { state, redirectUri }) {
    // https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
    // (no PKCE: the code is exchanged with the app secret).
    const q = new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID!,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(","),
      state,
      // Lets people pick another Instagram account than the one signed in on this browser.
      force_reauth: "true",
    });
    return `${AUTHORIZE}?${q}`;
  },

  async exchange(env, { code, redirectUri }) {
    // https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login#step-2--exchange-the-code-for-a-token
    const r = await send("instagram", TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        client_id: env.INSTAGRAM_APP_ID!,
        client_secret: env.INSTAGRAM_APP_SECRET!,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: code.replace(/#_$/, ""),
      }),
    });
    const d = await json(r);
    const short = Array.isArray(d?.data) ? d.data[0] : d;
    if (!r.ok || typeof short?.access_token !== "string")
      throw oauthFailure("instagram", r.status, d?.error_type === "OAuthException" ? "invalid_grant" : d?.error_type ?? d?.error?.type);
    const granted = Array.isArray(short.permissions) ? short.permissions : String(short.permissions || "").split(",");
    if (short.permissions && !granted.map((p: unknown) => String(p).trim()).includes("instagram_business_content_publish"))
      throw new SocialError("PERMISSION");
    // https://developers.facebook.com/docs/instagram-platform/reference/access_token
    const q = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: env.INSTAGRAM_APP_SECRET!, access_token: short.access_token });
    const tokens = await longLived(`${GRAPH}/access_token?${q}`);
    // Kept to know later whether stats may be read (the long-lived token answer doesn't list them).
    if (short.permissions) tokens.scope = granted.map((p: unknown) => String(p).trim()).filter(Boolean).join(",");
    // https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started
    // `user_id` is the professional account ID used for publishing (and in webhooks); `id` is app-scoped.
    const me = await graph(tokens, "/me", { query: { fields: "user_id,username,name,profile_picture_url" } });
    const igId = id(me.user_id);
    if (!igId) throw failure("instagram", 200, ["PROVIDER_ERROR", false], "no_user_id");
    const username = typeof me.username === "string" ? me.username.slice(0, 100) : undefined;
    return {
      tokens,
      profile: {
        externalId: igId,
        name: String(me.name || username || "Instagram account").slice(0, 100),
        handle: username,
        avatarUrl: typeof me.profile_picture_url === "string" ? me.profile_picture_url : undefined,
      },
    };
  },

  async refresh(_env, tokens) {
    if (tokens.expiresAt && tokens.expiresAt <= now()) throw new SocialError("AUTH_EXPIRED");
    // https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token
    const q = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: tokens.accessToken });
    return { ...tokens, ...(await longLived(`${GRAPH}/refresh_access_token?${q}`)) };
  },

  async publish(_env, ctx): Promise<PublishResult> {
    const igId = ctx.account.externalId;
    const caption = ctx.text;
    let creation: string;
    if (ctx.media.kind === "video") {
      // Reels: 3 s – 15 min, fetched by Instagram from our media link.
      creation = await container(ctx.tokens, igId, { media_type: "REELS", video_url: ctx.media.url, caption, share_to_feed: "true" });
    } else {
      const items = ctx.media.items.slice(0, 10);
      if (items.length === 1) creation = await container(ctx.tokens, igId, { image_url: items[0].url, caption });
      else {
        const children: string[] = [];
        for (const item of items) children.push(await container(ctx.tokens, igId, { image_url: item.url, is_carousel_item: "true" }));
        creation = await container(ctx.tokens, igId, { media_type: "CAROUSEL", children: children.join(","), caption });
      }
    }
    // Nothing is public until media_publish; containers that are never published expire after a day.
    return { state: "processing", ticket: { stage: "container", container: creation } };
  },

  async stats(_env, tokens, ids) {
    const out = new Map<string, PostStats>();
    const insights = !tokens.scope || tokens.scope.split(/[,\s]+/).includes(INSIGHTS_SCOPE);
    for (const mediaId of [...new Set(ids.map(id).filter(Boolean))]) {
      let media: any;
      try {
        // https://developers.facebook.com/docs/instagram-platform/reference/instagram-media
        media = await graph(tokens, `/${mediaId}`, { query: { fields: "like_count,comments_count" } });
      } catch (e) {
        // Error 100: the media was deleted (or isn't this account's). Anything else concerns the whole account.
        if (e instanceof SocialError && /^100(\.|$)/.test(e.detail)) continue;
        throw e;
      }
      const s: PostStats = { views: null, likes: count(media.like_count), comments: count(media.comments_count), shares: null };
      if (!insights) s.limited = true;
      else {
        try {
          // https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
          Object.assign(s, instagramInsights(await graph(tokens, `/${mediaId}/insights`, { query: { metric: "views,shares" } })));
        } catch (e) {
          if (!(e instanceof SocialError) || e.code === "AUTH_EXPIRED" || e.retryable) throw e;
          // A permission error: the connection predates the insights scope. Any other refusal is a metric this kind of
          // media lacks; likes and comments still count.
          if (e.code === "PERMISSION") s.limited = true;
        }
      }
      out.set(mediaId, s);
    }
    return out;
  },

  async status(_env, ctx, ticket): Promise<PublishResult> {
    const creation = id(ticket.container);
    if (!creation) return { state: "failed", code: "INTERRUPTED", retryable: false };
    // https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container
    const d = await graph(ctx.tokens, `/${creation}`, { query: { fields: "status_code" } });
    switch (d.status_code) {
      case "FINISHED":
        await ctx.checkpoint({ stage: "publish", container: creation });
        return publishContainer(ctx, creation);
      case "PUBLISHED": {
        // Published by an earlier, interrupted attempt: the newest post of the account is that one.
        const recent = await graph(ctx.tokens, `/${ctx.account.externalId}/media`, { query: { fields: "id,permalink", limit: "1" } });
        const latest = Array.isArray(recent.data) ? recent.data[0] : null;
        return { state: "published", externalId: id(latest?.id) || creation, url: latest?.id ? await permalink(ctx.tokens, id(latest.id)) : undefined };
      }
      case "ERROR":
      case "EXPIRED":
        console.warn("Instagram container failed", { publicationId: ctx.publicationId, code: d.status_code });
        return { state: "failed", code: "MEDIA_REJECTED", retryable: false, detail: String(d.status_code).toLowerCase() };
      default:
        return { state: "processing", ticket };
    }
  },
};
