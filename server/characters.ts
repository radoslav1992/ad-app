import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, DbUser, Env } from "./types";
import { mediaEnabled, now, uid } from "./types";
import { dbFailure, json } from "./db";
import { rate } from "./security";
import { allowance } from "./billing";
import { serveObject, extOf } from "./storage";
import { dispatchRun } from "./posts";
import { IMAGE_CREDITS } from "../shared/credits";

// AI creators ("characters") for AI UGC: the library administrators set up, and people's own — generated from a
// description (one AI image) or made from their own photo. Plus AI Studio's stand-alone AI images.
export const characters = new Hono<App>();
/** The kind of consent people give for a photo of a real person. */
export const PHOTO_CONSENT = "photo-consent-2026-10-08";

export function characterView(c: any, userId: string) {
  return {
    id: c.id, name: c.name, description: c.description, gender: c.gender, own: c.user_id === userId,
    premium: !c.look_id, image: `/api/characters/${c.id}/image?v=${c.updated_at}`,
  };
}
characters.get("/", async (c) => {
  const user = c.get("user");
  const rows = (await c.env.DB.prepare("SELECT * FROM characters WHERE active=1 AND (user_id IS NULL OR user_id=?) ORDER BY user_id IS NULL, created_at DESC LIMIT 200")
    .bind(user.id).all<any>()).results;
  const runs = (await c.env.DB.prepare("SELECT id,payload,status,error,created_at FROM runs WHERE user_id=? AND kind='character' AND created_at>? ORDER BY created_at DESC LIMIT 10")
    .bind(user.id, now() - 86400).all<any>()).results;
  return c.json({
    characters: rows.map((r) => characterView(r, user.id)),
    making: runs.filter((r) => r.status === "queued" || r.status === "running").map((r) => ({ id: r.id, name: json<any>(r.payload, {}).name })),
  });
});
characters.get("/:id/image", async (c) => {
  const ch = await c.env.DB.prepare("SELECT image_key,user_id FROM characters WHERE id=?").bind(c.req.param("id")).first<any>();
  if (!ch || (ch.user_id && ch.user_id !== c.get("user").id)) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, ch.image_key, null, "private, max-age=86400");
});
const characterInput = {
  name: z.string().trim().min(1).max(40),
  gender: z.enum(["female", "male", ""]).default(""),
};
/** A new AI creator from a description: one AI portrait (charged like an AI image). */
characters.post("/generate", async (c) => {
  const user = c.get("user");
  await rate(c, "character", 30, 3600, user.id);
  const d = z.object({ ...characterInput, description: z.string().trim().min(10).max(300), idempotencyKey: z.uuid() }).parse(await c.req.json());
  return c.json(await startRun(c.env, user, "character", IMAGE_CREDITS, d.idempotencyKey, { name: d.name, gender: d.gender, description: d.description, characterId: uid() }), 202);
});
/** A new AI creator from the owner's own photo (an uploaded image), with consent to animate the person in it. */
characters.post("/photo", async (c) => {
  const user = c.get("user");
  await rate(c, "character", 30, 3600, user.id);
  const d = z.object({ ...characterInput, description: z.string().trim().max(300).default(""), assetId: z.uuid(), consent: z.literal(true) }).parse(await c.req.json());
  const a = await c.env.DB.prepare("SELECT object_key,mime,width,height FROM media_assets WHERE id=? AND user_id=? AND status='ready' AND mime LIKE 'image/%'").bind(d.assetId, user.id).first<any>();
  if (!a) throw new HTTPException(400, { message: "Choose a photo from your library." });
  if (Math.min(a.width, a.height) < 400) throw new HTTPException(400, { message: "Use a sharper photo (at least 400 pixels on each side)." });
  const count = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM characters WHERE user_id=?").bind(user.id).first<{ n: number }>())?.n || 0;
  if (count >= 50) throw new HTTPException(400, { message: "You can have up to 50 creators. Delete one first." });
  // The character keeps its own copy, so deleting the upload does not break it.
  const id = uid(), key = `media/${user.id}/character-${id}.${extOf(a.mime)}`;
  const source = await c.env.MEDIA.get(a.object_key);
  if (!source) throw new HTTPException(400, { message: "Choose the photo again." });
  await c.env.MEDIA.put(key, source.body, { httpMetadata: { contentType: a.mime } });
  await c.env.DB.prepare("INSERT INTO characters(id,user_id,name,description,gender,image_key,mime,consent,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, user.id, d.name, d.description, d.gender, key, a.mime, PHOTO_CONSENT, now(), now()).run();
  return c.json({ id }, 201);
});
characters.patch("/:id", async (c) => {
  const user = c.get("user");
  const d = z.object({ name: z.string().trim().min(1).max(40).optional(), description: z.string().trim().max(300).optional() }).parse(await c.req.json());
  const r = await c.env.DB.prepare("UPDATE characters SET name=COALESCE(?,name),description=COALESCE(?,description),updated_at=? WHERE id=? AND user_id=?")
    .bind(d.name ?? null, d.description ?? null, now(), c.req.param("id"), user.id).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "Creator not found." });
  return c.json({ ok: true });
});
characters.delete("/:id", async (c) => {
  const user = c.get("user");
  const busy = await c.env.DB.prepare("SELECT 1 FROM runs r JOIN posts p ON p.id=r.post_id WHERE r.user_id=? AND r.status IN ('queued','running') AND p.spec LIKE ? LIMIT 1")
    .bind(user.id, `%${c.req.param("id")}%`).first();
  if (busy) throw new HTTPException(409, { message: "A post with this creator is being made. Try again when it's ready." });
  const r = await c.env.DB.prepare("DELETE FROM characters WHERE id=? AND user_id=?").bind(c.req.param("id"), user.id).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "Creator not found." });
  return c.json({ ok: true });
});

/** A stand-alone run (AI Studio): credits are reserved by the run's trigger and refunded if it fails. */
export async function startRun(env: Env, user: DbUser, kind: "image" | "character", credits: number, key: string, payload: Record<string, unknown>) {
  if (!mediaEnabled(env) || !env.CONTENT || !env.FAL_KEY) throw new HTTPException(503, { message: "AI images are being set up. Please try again soon." });
  if (!user.verified) throw new HTTPException(403, { message: "Confirm your email to use AI credits." });
  const previous = await env.DB.prepare("SELECT id FROM runs WHERE user_id=? AND idempotency_key=?").bind(user.id, key).first<{ id: string }>();
  if (previous) return { runId: previous.id };
  const a = await allowance(env, user);
  if (a.trialEnded) throw new HTTPException(402, { message: "Your free trial has ended. Upgrade to keep creating." });
  const id = uid();
  try {
    await env.DB.prepare("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,credits,status,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,'queued',?,?,?)")
      .bind(id, user.id, a.window, key, kind, credits, JSON.stringify(payload), now(), now()).run();
  } catch (e) {
    dbFailure(e);
  }
  await dispatchRun(env, id);
  return { runId: id };
}

/** AI Studio: stand-alone AI images (for slides and backgrounds) and the status of recent AI work. */
export const studio = new Hono<App>();
studio.post("/image", async (c) => {
  const user = c.get("user");
  await rate(c, "studio-image", 60, 3600, user.id);
  const d = z.object({ prompt: z.string().trim().min(3).max(400), workspaceId: z.uuid().optional(), idempotencyKey: z.uuid() }).parse(await c.req.json());
  if (d.workspaceId && !(await c.env.DB.prepare("SELECT 1 FROM workspaces WHERE id=? AND user_id=?").bind(d.workspaceId, user.id).first()))
    throw new HTTPException(404, { message: "Workspace not found." });
  return c.json(await startRun(c.env, user, "image", IMAGE_CREDITS, d.idempotencyKey, { prompt: d.prompt, workspaceId: d.workspaceId || null }), 202);
});
studio.get("/runs", async (c) => {
  const user = c.get("user");
  const rows = (await c.env.DB.prepare("SELECT id,kind,status,phase,credits,error,payload,created_at FROM runs WHERE user_id=? AND kind IN ('image','character') ORDER BY created_at DESC LIMIT 30")
    .bind(user.id).all<any>()).results;
  return c.json({
    runs: rows.map((r) => {
      const p = json<any>(r.payload, {});
      return { id: r.id, kind: r.kind, status: r.status, credits: r.credits, failed: r.status === "failed", label: r.kind === "image" ? p.prompt : p.name, createdAt: r.created_at };
    }),
  });
});
