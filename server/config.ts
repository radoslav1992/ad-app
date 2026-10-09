import type { Env } from "./types";

// Code defaults for optional settings. Dashboard variables always win, and survive deploys (keep_vars).
export function withDefaults(env: Env): Env {
  return {
    ...env,
    EMAIL_FROM: env.EMAIL_FROM?.trim() || env.CONTACT_EMAIL,
  };
}
export const siteUrl = (env: Env, request?: Request) =>
  (env.SITE_URL?.replace(/\/$/, "") || (request ? new URL(request.url).origin : ""));

/** Where a request on another of the Worker's hosts (www, the .app domain) should go: the same path on SITE_URL.
 *  workers.dev and local hosts are left alone, so the Worker stays reachable before its domain is set up. */
export function canonicalUrl(env: Env, url: URL): string | null {
  let site: URL;
  try { site = new URL(siteUrl(env)); } catch { return null; }
  const host = url.hostname;
  if (host === site.hostname || host.endsWith(".workers.dev") || host === "localhost" || host === "127.0.0.1") return null;
  return site.origin + url.pathname + url.search;
}
