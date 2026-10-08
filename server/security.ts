import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { Env, ContextVars } from "./types";
import { now } from "./types";
import { PRODUCT } from "../shared/brand";
export const sha = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const hex = (a: Uint8Array) =>
  Array.from(a)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
/** HMAC-SHA256 (hex): a keyed hash that cannot be recomputed from a guessed input without the secret. */
export async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}
export const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export async function hashPassword(
  password: string,
  salt = hex(crypto.getRandomValues(new Uint8Array(16))),
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256,
  );
  return `pbkdf2:100000:${salt}:${hex(new Uint8Array(bits))}`;
}
export async function checkPassword(password: string, stored: string) {
  const parts = stored.split(":");
  if (parts.length !== 4) return false;
  const actual = await hashPassword(password, parts[2]);
  return safeEqual(actual, stored);
}
export function safeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
type Ctx = Context<{ Bindings: Env; Variables: ContextVars }>;
export const clientIp = (c: Ctx) => c.req.header("CF-Connecting-IP") || "local";
export const tooMany = () =>
  new HTTPException(429, {
    message: "Too many attempts. Please try again later.",
  });
async function bucketKey(scope: string, identity: string, seconds: number) {
  const bucket = Math.floor(now() / seconds);
  return {
    key: await sha(scope + ":" + identity + ":" + bucket),
    expires: (bucket + 1) * seconds,
  };
}
/** Counts one hit and throws 429 once the bucket exceeds `max`. */
export async function rate(
  c: Ctx,
  scope: string,
  max = 20,
  seconds = 3600,
  identity?: string,
) {
  if ((await hit(c.env, scope, seconds, identity || clientIp(c))) > max)
    throw tooMany();
}
/** Adds a hit without enforcing a limit, for counters that only record failures. */
export async function hit(
  env: Env,
  scope: string,
  seconds: number,
  identity: string,
) {
  const { key, expires } = await bucketKey(scope, identity, seconds);
  const r = await env.DB.prepare(
    "INSERT INTO rate_limits(key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits",
  )
    .bind(key, expires)
    .first<{ hits: number }>();
  return r?.hits || 0;
}
/** Throws 429 if a recorded counter already reached `max`, without adding a hit. */
export async function limited(
  env: Env,
  scope: string,
  max: number,
  seconds: number,
  identity: string,
) {
  const { key } = await bucketKey(scope, identity, seconds);
  const r = await env.DB.prepare("SELECT hits FROM rate_limits WHERE key=?")
    .bind(key)
    .first<{ hits: number }>();
  return (r?.hits || 0) >= max;
}
/** Runs work after the response when the runtime allows it, otherwise inline. */
export async function defer(c: Ctx, work: Promise<unknown>) {
  let ctx: { waitUntil?: (p: Promise<unknown>) => void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(work);
  else await work;
}
export async function sendMail(
  env: Env,
  to: string,
  subject: string,
  text: string,
) {
  if (!env.EMAIL || !env.EMAIL_FROM)
    throw new HTTPException(503, {
      message: "Email is temporarily unavailable.",
    });
  // Accept the previous display-name format in existing Dashboard variables.
  const sender = env.EMAIL_FROM.trim();
  const named = sender.match(/^([^<>]*)<([^<>]+)>$/);
  try {
    await env.EMAIL.send({
      from: {
        email: named ? named[2].trim() : sender,
        name: named?.[1].trim() || PRODUCT.name,
      },
      to,
      subject,
      text,
    });
  } catch (cause) {
    throw new HTTPException(503, {
      message: "The email could not be sent. Please try again in a moment.",
      cause,
    });
  }
}
/** Whether a Turnstile token passed Cloudflare's check for this site (needs TURNSTILE_SECRET_KEY). */
export async function verifyTurnstile(env: Env, token: unknown, ip: string | undefined) {
  if (!env.TURNSTILE_SECRET_KEY || typeof token !== "string" || !token) return false;
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip || "" }),
  });
  const result = (await r.json()) as { success: boolean; hostname?: string };
  return !!result.success && (!env.SITE_URL || result.hostname === new URL(env.SITE_URL).hostname);
}
export function origin(env: Env, request: Request) {
  return env.SITE_URL?.replace(/\/$/, "") || new URL(request.url).origin;
}
