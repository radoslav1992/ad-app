import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { App, Env, DbUser } from "./types";
import { now } from "./types";
import { sha } from "./security";
import { describeError } from "./error-report";
import { withDefaults } from "./config";
import { auth, SESSION_COOKIE } from "./auth";
import { billing, webhook } from "./billing";
import { billingFailure } from "./billing-errors";
import { pages } from "./pages";
import { publicRoutes } from "./routes/public";
import { settings } from "./routes/settings";
import { admin } from "./routes/admin";
import { workspaces } from "./workspaces";
import { posts } from "./posts";
import { media, uploadInputs } from "./media";
import { renderInputs } from "./content-workflow";
import { characters, studio } from "./characters";
import { library } from "./library";
import { accounts } from "./accounts";
import { publishing, publishMedia } from "./publishing";
import { maintenance } from "./maintenance";
export { ContentGeneration } from "./content-workflow";
export { WorkspaceScan } from "./scan-workflow";
export { Publication } from "./publish-workflow";
export { MediaRenderer } from "./renderer";

const app = new Hono<App>();
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  if (new URL(c.req.url).protocol === "https:") c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // Media files set their own private caching; every other API answer is never cached.
  if (c.req.path.startsWith("/api/") && !c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});
// Upload parts are 8 MiB; everything else is small JSON.
const PART_PATH = /^\/api\/media\/uploads\/[^/]+\/parts\/\d+$/;
const ADMIN_UPLOAD = /^\/api\/admin\/(library|characters)(\/[^/]+)?\/(file|thumb)$/;
app.use("/api/*", async (c, next) => {
  const max = PART_PATH.test(c.req.path) ? 8 * 1024 * 1024 + 1024 : ADMIN_UPLOAD.test(c.req.path) ? 60 * 1024 * 1024 : 1024 * 1024;
  return bodyLimit({ maxSize: max, onError: (c) => c.json({ error: "The file or request is too large." }, 413) })(c, next);
});
// Every state change must come from this site's pages (CSRF), except the signed Stripe webhook.
app.use("/api/*", async (c, next) => {
  if (!["GET", "HEAD"].includes(c.req.method) && c.req.path !== "/api/billing/webhook") {
    const supplied = c.req.header("Origin");
    const allowed = new URL(c.env.SITE_URL || c.req.url).origin;
    if (supplied !== allowed) throw new HTTPException(403, { message: "Invalid request origin." });
  }
  await next();
});
app.post("/api/billing/webhook", async (c) => c.json(await webhook(c.req.raw, c.env)));
// For uptime monitors: is the Worker up and can it reach D1?
app.get("/api/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false }, 503);
  }
});
app.route("/", publicRoutes);
// Capability links (token in the URL) for the renderer, AI providers and social networks: no session.
app.route("/api/render-inputs", renderInputs);
app.route("/api/upload-inputs", uploadInputs);
app.route("/api/publish-media", publishMedia);
app.use("/api/*", async (c, next) => {
  const t = getCookie(c, SESSION_COOKIE);
  if (t) {
    const hash = await sha(t);
    const u = await c.env.DB.prepare("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?")
      .bind(hash, now())
      .first<DbUser>();
    if (u) {
      c.set("user", u);
      c.set("session", hash);
    }
  }
  await next();
});
app.route("/api/auth", auth);
app.use("/api/*", async (c, next) => {
  // A social network sends the browser back here: without a session (it expired meanwhile), go to sign-in.
  if (!c.get("user") && c.req.method === "GET" && c.req.path.startsWith("/api/accounts/callback/"))
    return c.redirect("/login?next=" + encodeURIComponent("/app/accounts"), 302);
  if (!c.get("user")) throw new HTTPException(401, { message: "Please sign in." });
  await next();
});
app.route("/api/billing", billing);
app.route("/api/workspaces", workspaces);
app.route("/api/posts", posts);
app.route("/api/media", media);
app.route("/api/characters", characters);
app.route("/api/studio", studio);
app.route("/api/library", library);
app.route("/api/accounts", accounts);
app.route("/api", publishing);
app.route("/api/settings", settings);
app.route("/api/admin", admin);
app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));
app.route("/", pages);
app.onError((e, c) => {
  if (e instanceof HTTPException) return c.json({ error: e.message }, e.status);
  // Malformed JSON bodies are client errors, not outages.
  if (e instanceof SyntaxError && c.req.method !== "GET" && c.req.path.startsWith("/api/")) return c.json({ error: "Invalid request." }, 400);
  if (e instanceof z.ZodError) {
    console.warn("Request validation failed", { path: c.req.path, fields: e.issues.slice(0, 10).map((x) => x.path.join(".") || "(body)") });
    const first = e.issues[0];
    // Messages written for people (in the schemas) are shown; generic ones become a plain request to check the form.
    const custom = first && first.code === "custom" ? first.message : null;
    return c.json({ error: custom || "Please check the form and try again.", fields: e.issues.slice(0, 10).map((x) => x.path.join(".")) }, 400);
  }
  if (c.req.path.startsWith("/api/billing/")) return c.json(billingFailure(e), 503);
  const report = describeError(e);
  console.error("Request failed", { path: c.req.path, method: c.req.method, ...report });
  return c.json({ error: `Something went wrong on our side. Please try again. If it keeps happening, contact support with reference ${report.reference}.`, reference: report.reference }, 503);
});
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, withDefaults(env), ctx),
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(maintenance(withDefaults(env), event.scheduledTime)),
};
