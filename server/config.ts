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
