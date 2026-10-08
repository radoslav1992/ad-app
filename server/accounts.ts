import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env } from "./types";
import { now, uid, MINUTE } from "./types";
import { dbFailure, ownedWorkspace } from "./db";
import { allowance } from "./billing";
import { rate, sha, token } from "./security";
import { siteUrl } from "./config";
import { encryptionReady, seal } from "./crypto";
import { planById } from "../shared/plans";
import { isPlatform, platformIds, platforms, type PlatformId } from "../shared/social";
import { socialPlatforms, SocialError } from "./social";
import { codeVerifier } from "./social/http";
import { connectionExpiry } from "./social/credentials";

// Connecting social accounts with OAuth (one per network and workspace), listing and disconnecting them.
// Tokens are sealed with TOKEN_ENCRYPTION_KEY and never leave the server.

export const accounts = new Hono<App>();
const STATE_TTL = 10 * MINUTE;

const ready = (env: Env, platform: PlatformId) => encryptionReady(env) && socialPlatforms[platform].configured(env);
const redirectUri = (env: Env, request: Request, platform: PlatformId) => `${siteUrl(env, request)}/api/accounts/callback/${platform}`;

/** The account limit of the user's plan, and how many accounts they have connected in all their workspaces. */
async function limits(env: Env, user: App["Variables"]["user"]) {
  const plan = planById((await allowance(env, user)).plan);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM social_accounts WHERE user_id=?").bind(user.id).first<{ n: number }>();
  return { max: plan.accounts as number, used: Number(row?.n) || 0 };
}

accounts.get("/", async (c) => {
  const user = c.get("user");
  const ws = await ownedWorkspace(c.env, user.id, c.req.query("workspace") || "");
  const t = now();
  const rows = await c.env.DB.prepare(
    "SELECT id,platform,name,handle,avatar_url,status,expires_at,created_at FROM social_accounts WHERE workspace_id=? AND user_id=? ORDER BY created_at",
  ).bind(ws.id, user.id).all<any>();
  return c.json({
    accounts: rows.results.map((a) => ({
      id: a.id,
      platform: a.platform,
      name: a.name,
      handle: a.handle,
      avatarUrl: a.avatar_url,
      // A connection that ended is shown as expired even before maintenance or a publish notices.
      status: a.status === "active" && a.expires_at && a.expires_at < t ? "expired" : a.status,
      createdAt: a.created_at,
    })),
    platforms: platformIds.map((id) => ({ id, name: platforms[id].name, configured: ready(c.env, id) })),
    limit: await limits(c.env, user),
  });
});

accounts.post("/connect", async (c) => {
  const user = c.get("user");
  const d = z.object({ workspaceId: z.string().min(1).max(64), platform: z.enum(platformIds) }).parse(await c.req.json());
  const ws = await ownedWorkspace(c.env, user.id, d.workspaceId);
  const { max, used } = await limits(c.env, user);
  if (max <= 0) throw new HTTPException(402, { message: "Connecting social accounts needs a paid plan." });
  if (used >= max) {
    // At the limit, an account that needs reconnecting can still be renewed (the callback allows no new ones).
    const renewable = await c.env.DB.prepare("SELECT 1 FROM social_accounts WHERE user_id=? AND workspace_id=? AND platform=? AND (status!='active' OR expires_at<?)")
      .bind(user.id, ws.id, d.platform, now()).first();
    if (!renewable) throw new HTTPException(402, { message: `Your plan includes ${max} social accounts. Disconnect one or upgrade to connect more.` });
  }
  if (!ready(c.env, d.platform))
    throw new HTTPException(503, { message: encryptionReady(c.env) ? `Connecting ${platforms[d.platform].name} is not available yet.` : "Social publishing is not set up yet." });
  await rate(c, "social-connect", 30, 3600, user.id);
  const state = token(), verifier = codeVerifier();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(now()),
    c.env.DB.prepare("INSERT INTO oauth_states(state_hash,user_id,workspace_id,platform,verifier,expires_at) VALUES (?,?,?,?,?,?)")
      .bind(await sha(state), user.id, ws.id, d.platform, verifier, now() + STATE_TTL),
  ]);
  const url = await socialPlatforms[d.platform].authorizeUrl(c.env, { state, redirectUri: redirectUri(c.env, c.req.raw, d.platform), codeVerifier: verifier });
  return c.json({ url });
});

/** Where the browser lands after the network's consent screen; only short codes go into the URL. */
function back(workspaceId: string | null, outcome: Record<string, string>) {
  const q = new URLSearchParams({ ...(workspaceId ? { workspace: workspaceId } : {}), ...outcome });
  return `/app/accounts?${q}`;
}
function errorCode(e: unknown) {
  if (!(e instanceof SocialError)) return "failed";
  if (e.code === "PERMISSION") return "permissions";
  if (e.code === "NO_CHANNEL") return "no_channel";
  if (e.code === "NOT_CONFIGURED") return "unavailable";
  if (e.code === "AUTH_EXPIRED") return "expired";
  return "failed";
}

// A top-level navigation from the network (GET; the Lax session cookie is sent). The state is single-use, short-lived
// and bound to the user who started the connection.
accounts.get("/callback/:platform", async (c) => {
  const user = c.get("user");
  const platform = c.req.param("platform");
  const state = c.req.query("state") || "";
  if (!isPlatform(platform)) return c.redirect(back(null, { error: "failed" }), 302);
  const row = /^[0-9a-f]{64}$/.test(state)
    ? await c.env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=? RETURNING *").bind(await sha(state)).first<any>()
    : null;
  if (!row || row.user_id !== user.id || row.platform !== platform || row.expires_at < now())
    return c.redirect(back(row?.user_id === user.id ? row.workspace_id : null, { error: "expired" }), 302);
  const workspaceId: string = row.workspace_id;
  // Declined on the consent screen (or the network reported another problem).
  if (c.req.query("error") || !c.req.query("code")) return c.redirect(back(workspaceId, { error: "denied" }), 302);
  try {
    await ownedWorkspace(c.env, user.id, workspaceId);
    if (!ready(c.env, platform)) return c.redirect(back(workspaceId, { error: "unavailable" }), 302);
    const { tokens, profile } = await socialPlatforms[platform].exchange(c.env, {
      code: c.req.query("code")!,
      redirectUri: redirectUri(c.env, c.req.raw, platform),
      codeVerifier: row.verifier,
    });
    const existing = await c.env.DB.prepare("SELECT id FROM social_accounts WHERE workspace_id=? AND platform=? AND external_id=?")
      .bind(workspaceId, platform, profile.externalId).first();
    if (!existing) {
      const { max, used } = await limits(c.env, user);
      if (used >= max) return c.redirect(back(workspaceId, { error: "limit" }), 302);
    }
    const t = now();
    const text = (s: string | undefined, max: number) => (s ? s.replace(/[\p{Cc}]/gu, "").trim().slice(0, max) || null : null);
    const avatar = profile.avatarUrl && /^https:\/\//.test(profile.avatarUrl) && profile.avatarUrl.length <= 2000 ? profile.avatarUrl : null;
    await c.env.DB.prepare(
      `INSERT INTO social_accounts(id,user_id,workspace_id,platform,external_id,name,handle,avatar_url,credentials,expires_at,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?)
       ON CONFLICT(workspace_id,platform,external_id) DO UPDATE SET name=excluded.name,handle=excluded.handle,avatar_url=excluded.avatar_url,
         credentials=excluded.credentials,expires_at=excluded.expires_at,status='active',updated_at=excluded.updated_at
       WHERE social_accounts.user_id=excluded.user_id`,
    ).bind(
      uid(), user.id, workspaceId, platform, profile.externalId.slice(0, 200), text(profile.name, 100) || platforms[platform].name,
      text(profile.handle, 100), avatar, await seal(c.env, tokens), connectionExpiry(platform, tokens), t, t,
    ).run();
    return c.redirect(back(workspaceId, { connected: platform }), 302);
  } catch (e) {
    if (e instanceof HTTPException && e.status === 404) return c.redirect(back(null, { error: "failed" }), 302);
    console.warn("Social account connection failed", { platform, code: e instanceof SocialError ? e.code : e instanceof Error ? e.name : "Error" });
    return c.redirect(back(workspaceId, { error: errorCode(e) }), 302);
  }
});

accounts.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const account = await c.env.DB.prepare("SELECT id,workspace_id FROM social_accounts WHERE id=? AND user_id=?").bind(id, user.id).first<{ id: string; workspace_id: string }>();
  if (!account) throw new HTTPException(404, { message: "Social account not found." });
  // Posts still scheduled to it are cancelled; published history stays (its account becomes "disconnected").
  // The account_busy trigger refuses while a post is being published to it.
  const w = await c.env.DB.prepare("SELECT settings FROM workspaces WHERE id=?").bind(account.workspace_id).first<{ settings: string }>();
  const settings = JSON.parse(w?.settings || "{}");
  if (Array.isArray(settings?.schedule?.accounts)) settings.schedule.accounts = settings.schedule.accounts.filter((x: unknown) => x !== id);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE publications SET status='canceled',updated_at=? WHERE account_id=? AND status='scheduled'").bind(Math.floor(Date.now() / 1000), id),
      c.env.DB.prepare("DELETE FROM social_accounts WHERE id=? AND user_id=?").bind(id, user.id),
      c.env.DB.prepare("UPDATE workspaces SET settings=? WHERE id=?").bind(JSON.stringify(settings), account.workspace_id),
    ]);
  } catch (e) {
    dbFailure(e);
  }
  return c.json({ ok: true });
});
