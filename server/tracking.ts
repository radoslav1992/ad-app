import { Hono, type Context } from "hono";
import { z } from "zod";
import type { App, Env } from "./types";
import { DAY, HOUR, MINUTE, now, uid } from "./types";
import { clientIp, defer, hit, sha } from "./security";
import { siteUrl } from "./config";
import { normalizeWebsite, publicUrl } from "./scan";
import { PRODUCT } from "../shared/brand";
import type { PlatformId } from "../shared/social";
import { ATTRIBUTION_DAYS, captionLinkPlatforms, dayOf } from "../shared/analytics";

// Tracked links and sale reporting for a workspace's own website. Public and cross-origin, so it is mounted before
// the session and Origin checks (server/index.ts). Nothing about visitors is stored: clicks are counts per link and
// day, a sale is its amount, currency and a hash of its order ID. Rate limits use the short-lived hashed counters of
// security.ts.

export const tracking = new Hono<App>();

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
/** Random letters and digits (no look-alikes); a link code is 8 (57^8 ≈ 10^14), a site key 24. */
const randomCode = (length: number) => Array.from(crypto.getRandomValues(new Uint8Array(length)), (b) => ALPHABET[b % ALPHABET.length]).join("");
const LINK_CODE = /^[A-Za-z0-9]{8}$/;
const SITE_KEY = /^[A-Za-z0-9]{24}$/;
/** What the site script accepts from a landing URL and sends back (a little looser than the codes we issue). */
const CODE_PARAM = /^[A-Za-z0-9]{6,16}$/;

export type SiteRow = { workspace_id: string; site_key: string; target_url: string | null; links_enabled: number; tested_at: number | null };

/** The workspace's tracking settings, created (with a new site key) the first time they are asked for. */
export async function analyticsSite(env: Env, workspaceId: string): Promise<SiteRow> {
  const t = now();
  await env.DB.prepare("INSERT OR IGNORE INTO analytics_sites(workspace_id,site_key,created_at,updated_at) VALUES (?,?,?,?)")
    .bind(workspaceId, randomCode(24), t, t).run();
  const site = await env.DB.prepare("SELECT * FROM analytics_sites WHERE workspace_id=?").bind(workspaceId).first<SiteRow>();
  if (!site) throw new Error("Analytics settings could not be created");
  return site;
}

/** The code of the workspace's tracked link for a post on a network (`postId` '' is the network's link in bio). */
export async function trackedLink(env: Env, workspaceId: string, platform: PlatformId, postId = ""): Promise<string> {
  const find = () => env.DB.prepare("SELECT code FROM tracked_links WHERE workspace_id=? AND platform=? AND post_id=?")
    .bind(workspaceId, platform, postId).first<{ code: string }>();
  for (let i = 0; i < 3; i++) {
    const found = await find();
    if (found) return found.code;
    // Two callers at once settle on whichever saved first; a code that is already taken is simply drawn again.
    await env.DB.prepare("INSERT OR IGNORE INTO tracked_links(code,workspace_id,post_id,platform,created_at) VALUES (?,?,?,?,?)")
      .bind(randomCode(8), workspaceId, postId, platform, now()).run();
  }
  const found = await find();
  if (!found) throw new Error("Tracked link could not be created");
  return found.code;
}

/** Whether a URL is on this site (a link leading back here could loop). */
function ownSite(env: Env, url: URL) {
  try {
    const host = new URL(siteUrl(env)).hostname;
    return url.hostname === host || url.hostname.endsWith(`.${host}`);
  } catch {
    return false;
  }
}
/** A target URL people typed, checked: a public http(s) page that isn't this site; null when it isn't one. */
export function checkedTarget(env: Env, value: string): string | null {
  const href = normalizeWebsite(value);
  const url = href ? publicUrl(href) : null;
  return url && !ownSite(env, url) ? url.href : null;
}
/**
 * Where a workspace's tracked links lead: its target URL, else its website. Only ever these stored, checked addresses
 * (never anything from the request), so a link can't be turned into an open redirect.
 */
export function linkTarget(env: Env, site: { target_url: string | null } | null, website: string | null): string | null {
  for (const value of [site?.target_url, website]) {
    const url = value ? publicUrl(value) : null;
    if (url && !ownSite(env, url)) return url.href;
  }
  return null;
}
/** The landing URL: the target with UTM tags and `hs` (the code the site script remembers for sales). */
export function destination(target: string, platform: string, code: string, postId: string) {
  const url = new URL(target);
  url.searchParams.set("utm_source", platform);
  url.searchParams.set("utm_medium", "social");
  url.searchParams.set("utm_campaign", PRODUCT.name.toLowerCase());
  url.searchParams.set("utm_content", postId || "bio");
  url.searchParams.set("hs", code);
  return url.href;
}

/** The tracked link for a post's caption on a network that makes caption links clickable, when the workspace wants it. */
export async function captionLink(env: Env, post: { id: string; workspace_id: string }, platform: PlatformId): Promise<string | null> {
  if (!(captionLinkPlatforms as readonly string[]).includes(platform)) return null;
  const base = siteUrl(env);
  const row = await env.DB.prepare("SELECT s.target_url,s.links_enabled,w.website FROM analytics_sites s JOIN workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=?")
    .bind(post.workspace_id).first<{ target_url: string | null; links_enabled: number; website: string | null }>();
  if (!base || !row?.links_enabled || !linkTarget(env, row, row.website)) return null;
  return `${base}/go/${await trackedLink(env, post.workspace_id, platform, post.id)}`;
}

/* ----------------------------------------------------------------------------------------------- the short links */

// Crawlers and link previews (the networks fetch every link they show), scripts and headless browsers.
const BOT = /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|facebot|embedly|iframely|whatsapp|telegram|skype|discord|slack|pinterest|vkshare|google-|lighthouse|headless|python|curl|wget|httpclient|okhttp|go-http|node-fetch|axios|java\//i;
/** Whether a request is a person following the link (not a HEAD, prefetch, preview or bot). */
export function isClick(request: Request) {
  if (request.method !== "GET") return false;
  const h = request.headers;
  const purpose = [h.get("Sec-Purpose"), h.get("Purpose"), h.get("X-Purpose"), h.get("X-Moz")].join(" ");
  if (/prefetch|prerender|preview/i.test(purpose)) return false;
  const ua = h.get("User-Agent") || "";
  return ua.length > 0 && !BOT.test(ua);
}
async function countClick(env: Env, code: string, ip: string) {
  // The same address following the same link again within 10 minutes counts once, and one address counts at most 120
  // clicks an hour (shared mobile addresses are common, so this stays generous).
  if ((await hit(env, "go-link", 10 * MINUTE, `${ip}|${code}`)) > 1) return;
  if ((await hit(env, "go-ip", HOUR, ip)) > 120) return;
  await env.DB.prepare("INSERT INTO link_clicks(code,day,clicks) VALUES (?,?,1) ON CONFLICT(code,day) DO UPDATE SET clicks=clicks+1")
    .bind(code, dayOf(now())).run();
}

const NO_INDEX = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
tracking.get("/go/:code", async (c) => {
  const code = c.req.param("code");
  const row = LINK_CODE.test(code)
    ? await c.env.DB.prepare(
      "SELECT l.platform,l.post_id,s.target_url,w.website FROM tracked_links l JOIN workspaces w ON w.id=l.workspace_id LEFT JOIN analytics_sites s ON s.workspace_id=l.workspace_id WHERE l.code=?",
    ).bind(code).first<{ platform: string; post_id: string; target_url: string | null; website: string | null }>()
    : null;
  const target = row ? linkTarget(c.env, row, row.website) : null;
  if (!row || !target) return c.text("This link isn't active.", 404, NO_INDEX);
  // Counted after the answer: the visitor never waits for it, and a failed count never breaks the link.
  if (isClick(c.req.raw)) await defer(c, countClick(c.env, code, clientIp(c)).catch((e) => console.warn("Click not counted", { error: (e as Error)?.name })));
  for (const [name, value] of Object.entries(NO_INDEX)) c.header(name, value);
  return c.redirect(destination(target, row.platform, code, row.post_id), 302);
});

/* -------------------------------------------------------------------------------------------- the site script */

/**
 * The script customers add to their site. It keeps the `hs` code of the last tracked link someone arrived from in that
 * site's own localStorage for 30 days (no cookies, nothing sent on page views) and exposes
 * hookstreak('conversion', { value, currency, orderId }), hookstreak('code') and hookstreak('test').
 */
export const SITE_SCRIPT = `/* ${PRODUCT.name}: counts sales from your posts. No cookies; only the last tracked link (30 days) is kept, in this site's localStorage. */
(function (w) {
  var s = document.currentScript, K = "hookstreak", TTL = ${ATTRIBUTION_DAYS * DAY * 1000};
  var site = s && s.getAttribute("data-site"), base = s && s.src ? new URL(s.src).origin : "";
  function read() { try { var v = JSON.parse(localStorage.getItem(K) || "null"); return v && v.c && Date.now() - v.t < TTL ? v : null; } catch (e) { return null; } }
  try { var c = new URLSearchParams(location.search).get("hs"); if (c && ${CODE_PARAM}.test(c)) localStorage.setItem(K, JSON.stringify({ c: c, t: Date.now() })); } catch (e) {}
  function send(body) {
    if (!site || !base || !w.fetch) return Promise.resolve(false);
    return fetch(base + "/api/t/" + encodeURIComponent(site), { method: "POST", body: JSON.stringify(body), keepalive: true, credentials: "omit", headers: { "Content-Type": "text/plain" } })
      .then(function (r) { return r.ok; }, function () { return false; });
  }
  function hookstreak(command, data) {
    var v = read();
    if (command === "code") return v ? v.c : null;
    if (command === "test") return send({ type: "test" });
    if (command === "conversion") {
      data = data || {};
      return send({ type: "conversion", code: v ? v.c : null, clickedAt: v ? Math.floor(v.t / 1000) : null, value: data.value, currency: data.currency, orderId: data.orderId });
    }
  }
  var queued = (w.hookstreak && w.hookstreak.q) || [];
  w.hookstreak = hookstreak;
  for (var i = 0; i < queued.length; i++) hookstreak.apply(null, queued[i]);
})(window);
`;
/** The two lines customers paste into their site's <head>. */
export const siteSnippet = (base: string, siteKey: string) =>
  `<script>window.hookstreak=window.hookstreak||function(){(hookstreak.q=hookstreak.q||[]).push(arguments)};</script>\n<script async src="${base}/t.js" data-site="${siteKey}"></script>`;

/** Any site may load the script and report to the endpoint; no credentials are ever involved. */
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;
tracking.get("/t.js", (c) => c.body(SITE_SCRIPT, 200, {
  "Content-Type": "text/javascript; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
}));

/* -------------------------------------------------------------------------------------------- reporting a sale */

const MAX_VALUE = 1_000_000;
/** What the developer adding the script reads when a field is wrong. */
const FIELD_ERRORS: Record<string, string> = {
  type: 'type must be "conversion" or "test".',
  value: `value must be a number from 0 to ${MAX_VALUE}.`,
  currency: "currency must be a 3-letter code such as USD.",
  orderId: "orderId must be text or a number, up to 100 characters.",
};
const reportSchema = z.object({
  type: z.enum(["conversion", "test"]).default("conversion"),
  // A damaged code or click time only means the sale isn't credited to a post.
  code: z.string().regex(CODE_PARAM).nullish().catch(null),
  clickedAt: z.number().int().positive().nullish().catch(null),
  value: z.union([z.number(), z.string().trim().regex(/^\d{1,9}(\.\d{1,4})?$/).transform(Number)]).nullish()
    .refine((v) => v == null || (Number.isFinite(v) && v >= 0 && v <= MAX_VALUE), { message: FIELD_ERRORS.value }),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((s) => s.toUpperCase()).nullish(),
  orderId: z.union([z.string().trim().min(1).max(100), z.number().int().nonnegative().transform(String)]).nullish(),
}).refine((d) => !d.value || !!d.currency, { message: "Send a currency (such as USD) with the value." });

tracking.options("/api/t/:key", () => new Response(null, { status: 204, headers: CORS }));
tracking.post("/api/t/:key", async (c) => {
  const answer = (body: Record<string, unknown>, status: 200 | 400 | 404 | 413 | 429 = 200) => c.json(body, status, CORS);
  const key = c.req.param("key");
  const site = SITE_KEY.test(key)
    ? await c.env.DB.prepare("SELECT workspace_id FROM analytics_sites WHERE site_key=?").bind(key).first<{ workspace_id: string }>()
    : null;
  if (!site) return answer({ error: "Unknown site key." }, 404);
  if (Number(c.req.header("Content-Length") || 0) > 2048) return answer({ error: "The report is too large." }, 413);
  // Per sending address (a shop's server reports every order from one) and per site, so one noisy page or script
  // can't flood a workspace's numbers.
  if ((await hit(c.env, "t-ip", HOUR, clientIp(c))) > 300 || (await hit(c.env, "t-site", DAY, key)) > 10_000)
    return answer({ error: "Too many reports. Try again later." }, 429);
  const text = await c.req.text();
  if (text.length > 2048) return answer({ error: "The report is too large." }, 413);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return answer({ error: "Send the report as JSON." }, 400); }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? "");
    return answer({ error: issue?.code === "custom" ? issue.message : FIELD_ERRORS[field] || "Send the report as a JSON object." }, 400);
  }
  const d = parsed.data, t = now();
  if (d.type === "test") {
    await c.env.DB.prepare("UPDATE analytics_sites SET tested_at=? WHERE site_key=?").bind(t, key).run();
    return answer({ ok: true });
  }
  return answer({ ok: true, ...(await recordConversion(c, site.workspace_id, d, t)) });
});

async function recordConversion(c: Context<App>, workspaceId: string, d: z.infer<typeof reportSchema>, t: number) {
  // The last tracked click, if it was within 30 days (as the script or the caller's server says) and that link really
  // was clicked in that time.
  const recent = d.clickedAt == null || (d.clickedAt <= t + 5 * MINUTE && t - d.clickedAt <= ATTRIBUTION_DAYS * DAY);
  const link = d.code && recent
    ? await c.env.DB.prepare(
      "SELECT code,post_id,platform FROM tracked_links l WHERE code=? AND workspace_id=? AND EXISTS(SELECT 1 FROM link_clicks k WHERE k.code=l.code AND k.day>=?)",
    ).bind(d.code, workspaceId, dayOf(t) - ATTRIBUTION_DAYS).first<{ code: string; post_id: string; platform: string }>()
    : null;
  const value = d.value ? Math.round(d.value * 100) : 0;
  const saved = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO conversions(id,workspace_id,code,post_id,platform,order_hash,amount,currency,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).bind(
    uid(), workspaceId, link?.code ?? null, link?.post_id || null, link?.platform ?? null,
    d.orderId ? await sha(`${workspaceId}:${d.orderId}`) : null, value, d.currency ?? null, t,
  ).run();
  return { attributed: !!link, duplicate: !saved.meta.changes };
}
