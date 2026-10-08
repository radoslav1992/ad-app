import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App } from "./types";
import { serveObject } from "./storage";

// The shared library (music, short clips, green-screen clips) people pick from; administrators fill it.
export const library = new Hono<App>();
export const libraryKinds = ["music", "clip", "greenscreen"] as const;
export function libraryView(r: any) {
  return {
    id: r.id, kind: r.kind, name: r.name, tags: String(r.tags || "").split(",").map((t) => t.trim()).filter((t) => t && !t.startsWith("chroma:")),
    duration: r.duration, width: r.width, height: r.height, url: `/api/library/${r.id}/file`, thumb: r.thumb_key ? `/api/library/${r.id}/thumb` : null,
  };
}
library.get("/", async (c) => {
  const q = z.object({ kind: z.enum(libraryKinds).optional(), tag: z.string().max(40).optional() }).parse(c.req.query());
  const rows = (await c.env.DB.prepare(`SELECT * FROM library_items WHERE active=1 ${q.kind ? "AND kind=?" : ""} ORDER BY created_at DESC LIMIT 500`)
    .bind(...(q.kind ? [q.kind] : [])).all<any>()).results;
  const items = rows.map(libraryView).filter((i) => !q.tag || i.tags.some((t) => t.toLowerCase() === q.tag!.toLowerCase()));
  const tags = [...new Set(items.flatMap((i) => i.tags))].sort();
  return c.json({ items, tags });
});
library.get("/:id/file", async (c) => {
  const r = await c.env.DB.prepare("SELECT object_key FROM library_items WHERE id=? AND active=1").bind(c.req.param("id")).first<{ object_key: string }>();
  if (!r) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, r.object_key, c.req.header("Range"), "private, max-age=86400");
});
library.get("/:id/thumb", async (c) => {
  const r = await c.env.DB.prepare("SELECT thumb_key FROM library_items WHERE id=? AND active=1").bind(c.req.param("id")).first<{ thumb_key: string | null }>();
  if (!r?.thumb_key) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, r.thumb_key, null, "private, max-age=86400");
});
