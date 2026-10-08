import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env } from "../types";
import { MB, now, uid, DAY } from "../types";
import { isAdmin } from "../auth";
import { imageInfo, imageFits, extOf, storeStream } from "../storage";
import { heygenLook } from "../providers/heygen";
import { fetchOutput, ProviderError } from "../providers/http";
import { libraryKinds, libraryView } from "../library";
import { creatorFilters, pageCursor } from "../characters";
import { describeError } from "../error-report";
import { BULK_LOOKS, LOOK_ID, parseLookIds, type LookImport } from "../../shared/creators";

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
const ADMIN_COLUMNS = "id,name,description,gender,look_id,engines,active,created_at,updated_at";
const genderInput = z.enum(["female", "male", ""]);
/** The library at any size: search, filters and keyset pages, newest first. The first page counts every match. */
admin.get("/characters", async (c) => {
  const d = z.object({
    q: z.string().trim().max(80).default(""), gender: z.enum(["", "female", "male", "none"]).default(""),
    status: z.enum(["all", "active", "off"]).default("all"), kind: z.enum(["all", "look", "portrait"]).default("all"),
    cursor: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
  }).parse(c.req.query());
  const f = creatorFilters(d.q, d.gender);
  const where = ["user_id IS NULL", ...f.where], args = [...f.args];
  if (d.status !== "all") where.push(d.status === "active" ? "active=1" : "active=0");
  if (d.kind !== "all") where.push(d.kind === "look" ? "look_id IS NOT NULL" : "look_id IS NULL");
  // Every library row is in the same group; the cursor format is shared with the people's list.
  const after = pageCursor.where(d.cursor, "1");
  const rows = (await c.env.DB.prepare(`SELECT ${ADMIN_COLUMNS} FROM characters WHERE ${[...where, ...(after ? [after.sql] : [])].join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...args, ...(after?.args || []), d.limit + 1).all<any>()).results;
  const more = rows.length > d.limit, page = rows.slice(0, d.limit), last = page[page.length - 1];
  const total = d.cursor ? undefined : (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM characters WHERE ${where.join(" AND ")}`).bind(...args).first<{ n: number }>())?.n || 0;
  return c.json({ characters: page, next: more && last ? pageCursor.of({ group: 1, created_at: last.created_at, id: last.id }) : null, ...(total !== undefined && { total }) });
});
admin.put("/characters/file", async (c) => {
  const q = z.object({ name: z.string().trim().min(1).max(40), description: z.string().trim().max(300).default(""), gender: genderInput.default("") }).parse(c.req.query());
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const info = imageInfo(bytes);
  if (!info || !imageFits(info) || bytes.length > 10 * MB) throw new HTTPException(400, { message: "Upload a JPG, PNG or WebP portrait under 10 MB and 4096 pixels." });
  const id = uid(), key = `library/${id}/portrait.${extOf(info.mime)}`;
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: info.mime } });
  await c.env.DB.prepare("INSERT INTO characters(id,name,description,gender,image_key,mime,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, q.name, q.description, q.gender, key, info.mime, now(), now()).run();
  return c.json({ id }, 201);
});

/** Why a look wasn't imported, in plain words; `retry` when trying again later may work. Provider text is never shown. */
function lookFailure(e: unknown): { error: string; retry: boolean } {
  if (e instanceof HTTPException) return { error: e.message, retry: false };
  const code = e instanceof ProviderError ? e.code : e instanceof Error && e.name === "TimeoutError" ? "TIMEOUT" : e instanceof Error ? e.message : "";
  const known: Record<string, [string, boolean]> = {
    AVATAR_NOT_FOUND: ["HeyGen has no look with this ID that this account can use.", false],
    AVATAR_UNAVAILABLE: ["HeyGen refused the request. Check the API key and the HeyGen plan.", true],
    AVATAR_BUSY: ["HeyGen is limiting requests. Try again in a minute.", true],
    TIMEOUT: ["HeyGen didn't answer in time.", true],
    PROVIDER_URL: ["The look's preview is stored somewhere we don't download from.", false],
    PROVIDER_DOWNLOAD: ["The look's preview image couldn't be downloaded.", true],
    MEDIA_DOWNLOAD: ["The look's preview image couldn't be downloaded.", true],
    MEDIA_SIZE: ["The look's preview image is larger than 10 MB.", false],
    MEDIA_EMPTY: ["The look's preview image is empty.", false],
  };
  if (known[code]) return { error: known[code][0], retry: known[code][1] };
  // Anything else unexpected (not a provider answer) is logged like any other failure, without its details.
  if (!(e instanceof ProviderError)) console.error("Look import failed", describeError(e));
  return { error: "HeyGen couldn't be reached or gave an unexpected answer.", retry: true };
}
/** Checks a look with HeyGen (Avatar III, a preview) and adds it to the library with the preview as its portrait. */
async function importLook(env: Env, lookId: string, d: { name?: string; description: string; gender: string }) {
  const look = await heygenLook(env, lookId);
  if (!look.engines.includes("avatar_iii")) throw new HTTPException(400, { message: "This look can't be used for talking videos through the API (no Avatar III engine)." });
  if (!look.preview) throw new HTTPException(400, { message: "This look has no preview image to use as its portrait." });
  const id = uid(), key = `library/${id}/portrait.jpg`, name = (d.name || look.name || "Creator").trim().slice(0, 40) || "Creator";
  try {
    await storeStream(env, key, await fetchOutput(look.preview, AbortSignal.timeout(30000)), 10 * MB, "image/jpeg");
    const head = await env.MEDIA.get(key, { range: { offset: 0, length: 65536 } });
    const info = head ? imageInfo(new Uint8Array(await head.arrayBuffer())) : null;
    if (!info) throw new HTTPException(400, { message: "The look's preview isn't a readable image." });
    await env.DB.prepare("INSERT INTO characters(id,name,description,gender,image_key,mime,look_id,engines,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(id, name, d.description, d.gender, key, info.mime, look.id, JSON.stringify(look.engines), now(), now()).run();
  } catch (e) {
    // Nothing points at the copy yet (a partial upload is aborted by storeStream itself).
    await env.MEDIA.delete(key).catch(() => {});
    // Another import of the same look won the race (unique index on library looks).
    if (e instanceof Error && /UNIQUE constraint failed: characters\.look_id/.test(e.message)) throw new HTTPException(409, { message: "This look is already in the library." });
    throw e;
  }
  return { id, name };
}
/** The library creator already linked to each of these looks. */
async function linkedLooks(env: Env, lookIds: string[]) {
  const rows = (await env.DB.prepare("SELECT id,name,look_id,active FROM characters WHERE user_id IS NULL AND look_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(lookIds)).all<{ id: string; name: string; look_id: string; active: number }>()).results;
  return new Map(rows.map((r) => [r.look_id, r]));
}
admin.post("/characters/import", async (c) => {
  const d = z.object({ lookId: z.string().trim().min(1).max(160), name: z.string().trim().max(40).optional(), description: z.string().trim().max(300).default(""), gender: genderInput.default("") }).parse(await c.req.json());
  const existing = (await linkedLooks(c.env, [d.lookId])).get(d.lookId);
  if (existing) throw new HTTPException(409, { message: `This look is already in the library as ${existing.name}.` });
  try {
    return c.json(await importLook(c.env, d.lookId, d), 201);
  } catch (e) {
    const f = lookFailure(e);
    throw new HTTPException(f.retry ? 502 : 400, { message: f.error });
  }
});
/**
 * Many looks at once (pasted IDs): each is checked like a single import, a few at a time. Looks already in the
 * library are skipped, and one bad ID never fails the others: every ID gets its own result.
 */
admin.post("/characters/import/bulk", async (c) => {
  const d = z.object({
    lookIds: z.union([z.string().max(20000), z.array(z.string().max(200)).max(BULK_LOOKS)]),
    gender: genderInput.default(""),
  }).parse(await c.req.json());
  const { ids } = parseLookIds(Array.isArray(d.lookIds) ? d.lookIds.join("\n") : d.lookIds);
  if (!ids.length) throw new HTTPException(400, { message: "Paste at least one look ID." });
  if (ids.length > BULK_LOOKS) throw new HTTPException(400, { message: `Import up to ${BULK_LOOKS} looks at a time.` });
  if (!c.env.HEYGEN_API_KEY?.trim()) throw new HTTPException(503, { message: "HeyGen isn't set up yet (HEYGEN_API_KEY)." });
  const valid = ids.filter((id) => LOOK_ID.test(id));
  const linked = valid.length ? await linkedLooks(c.env, valid) : new Map();
  const results = await mapLimit(ids, 4, async (lookId): Promise<LookImport> => {
    if (!LOOK_ID.test(lookId)) return { lookId, status: "unusable", error: "This isn't a HeyGen look ID (letters, digits, - and _ only)." };
    const found = linked.get(lookId);
    if (found) return { lookId, status: "exists", id: found.id, name: found.name, ...(!found.active && { error: "In the library but switched off." }) };
    try {
      return { lookId, status: "imported", ...(await importLook(c.env, lookId, { description: "", gender: d.gender })) };
    } catch (e) {
      const f = lookFailure(e);
      return { lookId, status: f.retry ? "failed" : "unusable", error: f.error };
    }
  });
  const count = (s: LookImport["status"]) => results.filter((r) => r.status === s).length;
  return c.json({ results, imported: count("imported"), exists: count("exists"), unusable: count("unusable"), failed: count("failed") });
});
/** Runs `fn` over `items` with at most `limit` in flight, keeping the order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}
/** Switch many creators on or off, or set their gender, in one go (the IDs an admin selected). */
admin.post("/characters/bulk", async (c) => {
  const d = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500), active: z.boolean().optional(), gender: genderInput.optional() })
    .refine((x) => x.active !== undefined || x.gender !== undefined, { message: "Choose what to change." }).parse(await c.req.json());
  const r = await c.env.DB.prepare("UPDATE characters SET active=COALESCE(?,active),gender=COALESCE(?,gender),updated_at=? WHERE user_id IS NULL AND id IN (SELECT value FROM json_each(?))")
    .bind(d.active === undefined ? null : d.active ? 1 : 0, d.gender ?? null, now(), JSON.stringify([...new Set(d.ids)])).run();
  return c.json({ updated: r.meta.changes });
});
admin.patch("/characters/:id", async (c) => {
  const d = z.object({
    name: z.string().trim().min(1).max(40).optional(), description: z.string().trim().max(300).optional(), gender: genderInput.optional(),
    active: z.boolean().optional(), lookId: z.string().trim().max(160).nullable().optional(),
  }).parse(await c.req.json());
  const id = c.req.param("id");
  let engines: string | null = null;
  if (d.lookId) {
    const other = (await linkedLooks(c.env, [d.lookId])).get(d.lookId);
    if (other && other.id !== id) throw new HTTPException(409, { message: `This look is already linked to ${other.name}.` });
    try {
      const look = await heygenLook(c.env, d.lookId);
      if (!look.engines.includes("avatar_iii")) throw new HTTPException(400, { message: "This look has no Avatar III engine." });
      engines = JSON.stringify(look.engines);
    } catch (e) {
      const f = lookFailure(e);
      throw new HTTPException(f.retry ? 502 : 400, { message: f.error });
    }
  } else if (d.lookId !== undefined) engines = "[]"; // Unlinked: a premium creator again.
  const r = await c.env.DB.prepare(
    "UPDATE characters SET name=COALESCE(?,name),description=COALESCE(?,description),gender=COALESCE(?,gender),active=COALESCE(?,active),look_id=CASE WHEN ? THEN ? ELSE look_id END,engines=COALESCE(?,engines),updated_at=? WHERE id=? AND user_id IS NULL",
  ).bind(d.name ?? null, d.description ?? null, d.gender ?? null, d.active === undefined ? null : d.active ? 1 : 0, d.lookId !== undefined ? 1 : 0, d.lookId || null, engines, now(), id).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "Creator not found." });
  return c.json({ character: await c.env.DB.prepare(`SELECT ${ADMIN_COLUMNS} FROM characters WHERE id=?`).bind(id).first() });
});
admin.delete("/characters/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM characters WHERE id=? AND user_id IS NULL").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
