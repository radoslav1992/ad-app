import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App } from "../types";
import { MB, now, uid, DAY } from "../types";
import { isAdmin } from "../auth";
import { imageInfo, imageFits, extOf, storeStream } from "../storage";
import { heygenLook } from "../providers/heygen";
import { fetchOutput } from "../providers/http";
import { libraryKinds, libraryView } from "../library";

// Administration: the shared library (music, clips, green screens), library AI creators, contact messages, health.
export const admin = new Hono<App>();
admin.use("*", async (c, next) => {
  if (!isAdmin(c.env, c.get("user"))) throw new HTTPException(404, { message: "Not found." });
  await next();
});
admin.get("/overview", async (c) => {
  const since = now() - DAY;
  const one = async (sql: string, ...args: unknown[]) => (await c.env.DB.prepare(sql).bind(...args).first<{ n: number }>())?.n || 0;
  return c.json({
    users: await one("SELECT COUNT(*) AS n FROM users"),
    newUsers: await one("SELECT COUNT(*) AS n FROM users WHERE created_at>?", since),
    paying: await one("SELECT COUNT(DISTINCT user_id) AS n FROM subscriptions WHERE status='active'"),
    posts: await one("SELECT COUNT(*) AS n FROM posts WHERE created_at>?", since),
    failedRuns: await one("SELECT COUNT(*) AS n FROM runs WHERE status='failed' AND created_at>?", since),
    activeRuns: await one("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')"),
    published: await one("SELECT COUNT(*) AS n FROM publications WHERE status='published' AND published_at>?", since),
    failedPublications: await one("SELECT COUNT(*) AS n FROM publications WHERE status='failed' AND updated_at>?", since),
    config: {
      media: c.env.MEDIA_ENABLED === "true", fal: !!c.env.FAL_KEY, elevenlabs: !!c.env.ELEVENLABS_API_KEY, heygen: !!c.env.HEYGEN_API_KEY,
      stripe: !!c.env.STRIPE_SECRET_KEY, billing: c.env.BILLING_ENABLED === "true", tokens: !!c.env.TOKEN_ENCRYPTION_KEY,
      tiktok: !!c.env.TIKTOK_CLIENT_KEY, instagram: !!c.env.INSTAGRAM_APP_ID, youtube: !!c.env.GOOGLE_CLIENT_ID, linkedin: !!c.env.LINKEDIN_CLIENT_ID,
    },
  });
});
admin.get("/messages", async (c) =>
  c.json({ messages: (await c.env.DB.prepare("SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 100").all()).results }));

// Library: metadata first, then the file in one request (≤ 50 MB), measured in the admin's browser.
admin.get("/library", async (c) =>
  c.json({ items: (await c.env.DB.prepare("SELECT * FROM library_items ORDER BY created_at DESC LIMIT 1000").all<any>()).results.map((r) => ({ ...libraryView(r), active: !!r.active, rawTags: r.tags })) }));
const libraryMimes: Record<(typeof libraryKinds)[number], string[]> = {
  music: ["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/wav", "audio/x-wav"],
  clip: ["video/mp4", "video/quicktime", "video/webm"],
  greenscreen: ["video/mp4", "video/quicktime", "video/webm"],
};
admin.put("/library/file", async (c) => {
  const q = z.object({
    kind: z.enum(libraryKinds), name: z.string().trim().min(1).max(120), tags: z.string().trim().max(300).default(""),
    duration: z.coerce.number().min(0.5).max(600), width: z.coerce.number().int().min(0).max(4096).default(0), height: z.coerce.number().int().min(0).max(4096).default(0),
  }).parse(c.req.query());
  const mime = (c.req.header("Content-Type") || "").split(";")[0].toLowerCase();
  if (!libraryMimes[q.kind].includes(mime)) throw new HTTPException(415, { message: q.kind === "music" ? "Upload an MP3, M4A, OGG or WAV track." : "Upload an MP4, MOV or WebM video." });
  const id = uid(), key = `library/${id}/file.${extOf(mime)}`;
  const bytes = await storeStream(c.env, key, new Response(c.req.raw.body, { headers: { "Content-Length": c.req.header("Content-Length") || "" } }), 50 * MB, mime);
  await c.env.DB.prepare("INSERT INTO library_items(id,kind,name,tags,object_key,mime,bytes,duration,width,height,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, q.kind, q.name, q.tags, key, mime, bytes, q.duration, q.width, q.height, now()).run();
  return c.json({ id }, 201);
});
/** A poster image for a clip (a frame the admin's browser captured). */
admin.put("/library/:id/thumb", async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const info = imageInfo(bytes);
  if (!info || bytes.length > 2 * MB) throw new HTTPException(400, { message: "The thumbnail must be a JPG, PNG or WebP under 2 MB." });
  const key = `library/${c.req.param("id")}/thumb.${extOf(info.mime)}`;
  const r = await c.env.DB.prepare("UPDATE library_items SET thumb_key=? WHERE id=?").bind(key, c.req.param("id")).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "Not found." });
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: info.mime } });
  return c.json({ ok: true });
});
admin.patch("/library/:id", async (c) => {
  const d = z.object({ name: z.string().trim().min(1).max(120).optional(), tags: z.string().trim().max(300).optional(), active: z.boolean().optional() }).parse(await c.req.json());
  await c.env.DB.prepare("UPDATE library_items SET name=COALESCE(?,name),tags=COALESCE(?,tags),active=COALESCE(?,active) WHERE id=?")
    .bind(d.name ?? null, d.tags ?? null, d.active === undefined ? null : d.active ? 1 : 0, c.req.param("id")).run();
  return c.json({ ok: true });
});
admin.delete("/library/:id", async (c) => {
  // Posts that used it keep their rendered video; only new renders need another item.
  await c.env.DB.prepare("DELETE FROM library_items WHERE id=?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// Library AI creators: a portrait (uploaded, or imported from a HeyGen avatar look, which also links the look).
admin.get("/characters", async (c) =>
  c.json({ characters: (await c.env.DB.prepare("SELECT id,name,description,gender,look_id,engines,active,updated_at FROM characters WHERE user_id IS NULL ORDER BY created_at DESC").all<any>()).results }));
admin.put("/characters/file", async (c) => {
  const q = z.object({ name: z.string().trim().min(1).max(40), description: z.string().trim().max(300).default(""), gender: z.enum(["female", "male", ""]).default("") }).parse(c.req.query());
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const info = imageInfo(bytes);
  if (!info || !imageFits(info) || bytes.length > 10 * MB) throw new HTTPException(400, { message: "Upload a JPG, PNG or WebP portrait under 10 MB and 4096 pixels." });
  const id = uid(), key = `library/${id}/portrait.${extOf(info.mime)}`;
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: info.mime } });
  await c.env.DB.prepare("INSERT INTO characters(id,name,description,gender,image_key,mime,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, q.name, q.description, q.gender, key, info.mime, now(), now()).run();
  return c.json({ id }, 201);
});
admin.post("/characters/import", async (c) => {
  const d = z.object({ lookId: z.string().trim().min(1).max(160), name: z.string().trim().max(40).optional(), description: z.string().trim().max(300).default(""), gender: z.enum(["female", "male", ""]).default("") }).parse(await c.req.json());
  const look = await heygenLook(c.env, d.lookId);
  if (!look.engines.includes("avatar_iii")) throw new HTTPException(400, { message: "This avatar can't be used for talking videos through the API (no Avatar III engine)." });
  if (!look.preview) throw new HTTPException(400, { message: "This avatar has no preview image to use as its portrait." });
  const id = uid(), key = `library/${id}/portrait.jpg`;
  const bytes = await storeStream(c.env, key, await fetchOutput(look.preview, AbortSignal.timeout(30000)), 10 * MB, "image/jpeg");
  const head = await c.env.MEDIA.get(key, { range: { offset: 0, length: 65536 } });
  const info = head ? imageInfo(new Uint8Array(await head.arrayBuffer())) : null;
  if (!info) { await c.env.MEDIA.delete(key); throw new HTTPException(400, { message: "The avatar's preview isn't a readable image." }); }
  await c.env.DB.prepare("INSERT INTO characters(id,name,description,gender,image_key,mime,look_id,engines,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(id, d.name || look.name || "Creator", d.description, d.gender, key, info.mime, look.id, JSON.stringify(look.engines), now(), now()).run();
  return c.json({ id, bytes }, 201);
});
admin.patch("/characters/:id", async (c) => {
  const d = z.object({
    name: z.string().trim().min(1).max(40).optional(), description: z.string().trim().max(300).optional(), gender: z.enum(["female", "male", ""]).optional(),
    active: z.boolean().optional(), lookId: z.string().trim().max(160).nullable().optional(),
  }).parse(await c.req.json());
  let engines: string | null = null;
  if (d.lookId) {
    const look = await heygenLook(c.env, d.lookId);
    if (!look.engines.includes("avatar_iii")) throw new HTTPException(400, { message: "This avatar has no Avatar III engine." });
    engines = JSON.stringify(look.engines);
  }
  await c.env.DB.prepare(
    "UPDATE characters SET name=COALESCE(?,name),description=COALESCE(?,description),gender=COALESCE(?,gender),active=COALESCE(?,active),look_id=CASE WHEN ? THEN ? ELSE look_id END,engines=COALESCE(?,engines),updated_at=? WHERE id=? AND user_id IS NULL",
  ).bind(d.name ?? null, d.description ?? null, d.gender ?? null, d.active === undefined ? null : d.active ? 1 : 0, d.lookId !== undefined ? 1 : 0, d.lookId || null, engines, now(), c.req.param("id")).run();
  return c.json({ ok: true });
});
admin.delete("/characters/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM characters WHERE id=? AND user_id IS NULL").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
