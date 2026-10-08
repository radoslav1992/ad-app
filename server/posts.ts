import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, DbUser, Env } from "./types";
import { mediaEnabled, now, uid } from "./types";
import { dbFailure, json, ownedPost, ownedWorkspace } from "./db";
import { rate } from "./security";
import { allowance, type Allowance } from "./billing";
import { autoSchedule } from "./publishing";
import { isVoice } from "./voices";
import {
  referencedAssets, referencedLibrary, specCredits, specHook, specSchema, talking, visualPart, type Spec,
} from "../shared/formats";
import type { AvatarKind } from "../shared/credits";

// Posts: made from a spec by a run (AI media, voice, avatar video, render), then reviewed in Blitz.
export const posts = new Hono<App>();

/** Library characters linked to a saved avatar cost the library rate; portraits animated directly, the custom one. */
export async function characterKind(env: Env, userId: string, spec: Spec): Promise<AvatarKind> {
  const t = talking(spec);
  if (!t) return "library";
  const c = await env.DB.prepare("SELECT look_id FROM characters WHERE id=? AND active=1 AND (user_id IS NULL OR user_id=?)")
    .bind(t.characterId, userId).first<{ look_id: string | null }>();
  if (!c) throw new HTTPException(400, { message: "Choose an AI creator for this post." });
  return c.look_id ? "library" : "custom";
}
/** Every file, library item, character and voice the spec uses exists and is the owner's (or shared). */
export async function checkReferences(env: Env, userId: string, spec: Spec) {
  const assets = referencedAssets(spec);
  if (assets.length) {
    const found = (await env.DB.prepare(`SELECT id FROM media_assets WHERE user_id=? AND status='ready' AND id IN (${assets.map(() => "?").join(",")})`)
      .bind(userId, ...assets).all<{ id: string }>()).results;
    if (found.length !== assets.length) throw new HTTPException(400, { message: "A file in this post is missing or still uploading. Choose it again." });
  }
  const items = referencedLibrary(spec);
  if (items.length) {
    const found = (await env.DB.prepare(`SELECT id FROM library_items WHERE active=1 AND id IN (${items.map(() => "?").join(",")})`)
      .bind(...items).all<{ id: string }>()).results;
    if (found.length !== items.length) throw new HTTPException(400, { message: "A clip or track in this post is no longer in the library. Choose another one." });
  }
  const t = talking(spec);
  if (t) {
    if (!isVoice(t.voiceId)) throw new HTTPException(400, { message: "Choose a voice." });
    await characterKind(env, userId, spec);
  }
}
/** Starts the run's background work; a failed start is retried by maintenance (the run stays queued). */
export async function dispatchRun(env: Env, runId: string) {
  try {
    await env.CONTENT!.create({ id: runId, params: { runId } });
  } catch (e) {
    console.error("Run dispatch failed; maintenance will retry", { runId, error: (e as Error)?.name });
  }
}
function requireMedia(env: Env) {
  if (!mediaEnabled(env) || !env.CONTENT) throw new HTTPException(503, { message: "Post rendering is being set up. Please try again soon." });
}
/** Refuses new posts after the free trial or without posts left in the plan. */
export function canCreate(a: Allowance, count = 1) {
  if (a.trialEnded) throw new HTTPException(402, { message: "Your free trial has ended. Upgrade to keep creating posts." });
  if (a.postsUsed + count > a.postsLimit)
    throw new HTTPException(402, { message: a.postsUsed >= a.postsLimit ? "You've used all the posts in your plan. Upgrade to keep creating." : `You have ${a.postsLimit - a.postsUsed} post(s) left in your plan.` });
}
/** Creates a post and its first run in one transaction (posts quota and credits are reserved by the triggers). */
export async function createPost(env: Env, user: DbUser, workspaceId: string, spec: Spec, a: Allowance, key: string, batchId: string | null = null) {
  requireMedia(env);
  const credits = specCredits(spec, await characterKind(env, user.id, spec));
  const postId = uid(), runId = uid(), t = now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO posts(id,user_id,workspace_id,window_id,batch_id,format,spec,hook,caption,title,render_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?)",
      ).bind(postId, user.id, workspaceId, a.window, batchId, spec.format, JSON.stringify(spec), specHook(spec).slice(0, 300), spec.caption, spec.title, t, t),
      env.DB.prepare(
        "INSERT INTO runs(id,user_id,post_id,window_id,idempotency_key,kind,initial,credits,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,'post',1,?,'queued',?,?,?)",
      ).bind(runId, user.id, postId, a.window, key, credits, JSON.stringify({ revision: 1 }), t, t),
    ]);
  } catch (e) {
    dbFailure(e);
  }
  await dispatchRun(env, runId);
  return { id: postId, runId, credits };
}
/** A new run for an existing post (after an edit, or to retry a failed render). */
async function rerun(env: Env, user: DbUser, post: any, spec: Spec, key: string) {
  requireMedia(env);
  const previous = await env.DB.prepare("SELECT post_id FROM runs WHERE user_id=? AND idempotency_key=?").bind(user.id, key).first<{ post_id: string }>();
  if (previous) return { credits: 0 };
  const a = await allowance(env, user);
  const credits = specCredits(spec, await characterKind(env, user.id, spec));
  const runId = uid(), t = now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO runs(id,user_id,post_id,window_id,idempotency_key,kind,initial,credits,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,'post',0,?,'queued',?,?,?)",
      ).bind(runId, user.id, post.id, a.window, key, credits, JSON.stringify({ revision: post.revision + 1 }), t, t),
      env.DB.prepare("UPDATE posts SET spec=?,hook=?,caption=?,title=?,render_status='queued',render_error=NULL,revision=revision+1,updated_at=? WHERE id=?")
        .bind(JSON.stringify(spec), specHook(spec).slice(0, 300), spec.caption, spec.title, t, post.id),
    ]);
  } catch (e) {
    dbFailure(e);
  }
  await dispatchRun(env, runId);
  return { credits };
}

/** What the app shows for a post (never internal run payloads). */
export function postView(p: any, detail = false) {
  const spec = json<any>(p.spec, {});
  return {
    id: p.id, workspaceId: p.workspace_id, format: p.format, status: p.status, renderStatus: p.render_status,
    renderError: p.render_error, phase: p.phase ?? null, hook: p.hook, caption: p.caption, title: p.title,
    hashtags: spec.hashtags || [], topic: spec.topic || "", why: spec.why || "", pattern: spec.pattern || null,
    duration: p.duration, videoAssetId: p.video_asset, coverAssetId: p.cover_asset, slides: json<string[]>(p.slides, []),
    revision: p.revision, createdAt: p.created_at, updatedAt: p.updated_at, reviewedAt: p.reviewed_at,
    ...(detail && { spec }),
  };
}
const views = {
  blitz: "p.status='pending' AND p.render_status='ready'",
  making: "p.render_status IN ('queued','running')",
  pending: "p.status='pending'",
  approved: "p.status='approved'",
  rejected: "p.status='rejected'",
  failed: "p.render_status='failed'",
  all: "1=1",
} as const;
posts.get("/", async (c) => {
  const user = c.get("user");
  const q = z.object({
    workspace: z.uuid(),
    view: z.enum(Object.keys(views) as [keyof typeof views]).default("all"),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    before: z.coerce.number().int().optional(),
  }).parse(c.req.query());
  await ownedWorkspace(c.env, user.id, q.workspace);
  const rows = (await c.env.DB.prepare(
    `SELECT p.*,(SELECT phase FROM runs r WHERE r.post_id=p.id AND r.status IN ('queued','running') LIMIT 1) AS phase FROM posts p
     WHERE p.workspace_id=? AND p.user_id=? AND ${views[q.view]} ${q.before ? "AND p.created_at<?" : ""} ORDER BY p.created_at ${q.view === "blitz" ? "ASC" : "DESC"} LIMIT ?`,
  ).bind(q.workspace, user.id, ...(q.before ? [q.before] : []), q.limit).all<any>()).results;
  const counts = await c.env.DB.prepare(
    `SELECT SUM(${views.blitz}) AS blitz, SUM(${views.making}) AS making, SUM(${views.approved}) AS approved, SUM(${views.failed}) AS failed, COUNT(*) AS total FROM posts p WHERE p.workspace_id=? AND p.user_id=?`,
  ).bind(q.workspace, user.id).first<any>();
  return c.json({ posts: rows.map((p) => postView(p)), counts: { blitz: counts?.blitz || 0, making: counts?.making || 0, approved: counts?.approved || 0, failed: counts?.failed || 0, total: counts?.total || 0 } });
});
const createSchema = z.object({ workspaceId: z.uuid(), spec: specSchema, idempotencyKey: z.uuid() });
posts.post("/", async (c) => {
  const user = c.get("user");
  await rate(c, "post-create", 120, 3600, user.id);
  const d = createSchema.parse(await c.req.json());
  await ownedWorkspace(c.env, user.id, d.workspaceId);
  const previous = await c.env.DB.prepare("SELECT post_id FROM runs WHERE user_id=? AND idempotency_key=?").bind(user.id, d.idempotencyKey).first<{ post_id: string }>();
  if (previous) return c.json({ id: previous.post_id });
  const spec = stripGenerated(d.spec);
  await checkReferences(c.env, user.id, spec);
  const a = await allowance(c.env, user);
  canCreate(a);
  return c.json(await createPost(c.env, user, d.workspaceId, spec, a, d.idempotencyKey), 201);
});
/** The browser never sets generated recordings; they only come from the server's own runs. */
function stripGenerated(spec: Spec): Spec {
  if ("generated" in spec) { const { generated: _g, ...rest } = spec; return rest as Spec; }
  return spec;
}
posts.get("/:id", async (c) => {
  const p = await ownedPost(c.env, c.get("user").id, c.req.param("id"));
  const run = await c.env.DB.prepare("SELECT phase,status,credits,error FROM runs WHERE post_id=? ORDER BY created_at DESC LIMIT 1").bind(p.id).first<any>();
  return c.json({ post: { ...postView({ ...p, phase: run?.status === "queued" || run?.status === "running" ? run.phase : null }, true) } });
});
posts.put("/:id", async (c) => {
  const user = c.get("user");
  await rate(c, "post-edit", 200, 3600, user.id);
  const p = await ownedPost(c.env, user.id, c.req.param("id"));
  const d = z.object({ spec: specSchema, idempotencyKey: z.uuid() }).parse(await c.req.json());
  if (d.spec.format !== p.format) throw new HTTPException(400, { message: "A post keeps its format. Create a new post instead." });
  const stored = json<Spec>(p.spec, d.spec);
  // The paid recording stays with the post while its words, character and voice do not change.
  const spec = { ...stripGenerated(d.spec), ...("generated" in stored && stored.generated ? { generated: stored.generated } : {}) } as Spec;
  await checkReferences(c.env, user.id, spec);
  if (visualPart(spec) === visualPart(stored) && p.render_status === "ready") {
    await c.env.DB.prepare("UPDATE posts SET spec=?,caption=?,title=?,updated_at=? WHERE id=?").bind(JSON.stringify(spec), spec.caption, spec.title, now(), p.id).run();
    return c.json({ post: postView({ ...p, spec: JSON.stringify(spec), caption: spec.caption, title: spec.title }, true), rendering: false });
  }
  if (["queued", "running"].includes(p.render_status)) throw new HTTPException(409, { message: "This post is still being made. Edit it when it's ready." });
  const { credits } = await rerun(c.env, user, p, spec, d.idempotencyKey);
  return c.json({ post: postView(await ownedPost(c.env, user.id, p.id), true), rendering: true, credits });
});
posts.post("/:id/render", async (c) => {
  const user = c.get("user");
  const p = await ownedPost(c.env, user.id, c.req.param("id"));
  const { idempotencyKey } = z.object({ idempotencyKey: z.uuid() }).parse(await c.req.json());
  if (["queued", "running"].includes(p.render_status)) throw new HTTPException(409, { message: "This post is already being made." });
  const { credits } = await rerun(c.env, user, p, json<Spec>(p.spec, {} as Spec), idempotencyKey);
  return c.json({ ok: true, credits });
});
posts.post("/:id/review", async (c) => {
  const user = c.get("user");
  const p = await ownedPost(c.env, user.id, c.req.param("id"));
  const { decision } = z.object({ decision: z.enum(["approve", "reject", "undo"]) }).parse(await c.req.json());
  if (decision !== "undo" && p.render_status !== "ready") throw new HTTPException(409, { message: "This post isn't ready yet." });
  if (decision === "undo") {
    const live = await c.env.DB.prepare("SELECT 1 FROM publications WHERE post_id=? AND status IN ('publishing','published')").bind(p.id).first();
    if (live) throw new HTTPException(409, { message: "This post is already being published." });
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE publications SET status='canceled',updated_at=? WHERE post_id=? AND status='scheduled'").bind(now(), p.id),
      c.env.DB.prepare("UPDATE posts SET status='pending',reviewed_at=NULL,updated_at=? WHERE id=?").bind(now(), p.id),
    ]);
    return c.json({ ok: true, status: "pending", scheduled: 0 });
  }
  const status = decision === "approve" ? "approved" : "rejected";
  await c.env.DB.prepare("UPDATE posts SET status=?,reviewed_at=?,updated_at=? WHERE id=?").bind(status, now(), now(), p.id).run();
  let scheduled = 0;
  if (status === "approved") {
    try { scheduled = await autoSchedule(c.env, user.id, p.id); }
    catch (e) { console.error("Auto-schedule failed", { postId: p.id, error: (e as Error)?.name }); }
  }
  return c.json({ ok: true, status, scheduled });
});
posts.delete("/:id", async (c) => {
  const p = await ownedPost(c.env, c.get("user").id, c.req.param("id"));
  try {
    await c.env.DB.prepare("DELETE FROM posts WHERE id=?").bind(p.id).run();
  } catch (e) {
    dbFailure(e);
  }
  return c.json({ ok: true });
});
