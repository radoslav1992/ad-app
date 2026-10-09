import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, Env } from "./types";
import { MB, mediaEnabled, now, uid } from "./types";
import { dbFailure, json } from "./db";
import { rate, safeEqual, token } from "./security";
import { extOf, head, imageFits, imageInfo, mediaKey, serveObject } from "./storage";
import { claimSpeech, listening, mayHaveSpeech, mayTranscribe, speechView, storedTranscript } from "./speech";
import { allowance } from "./billing";
import { dispatchRun } from "./posts";
import { planById } from "../shared/plans";
import { creditsLabel, speechCredits } from "../shared/credits";
import { SPEECH_MAX_SECONDS } from "../shared/speech";

// The media library: uploads (images, videos, audio) in authenticated 8 MiB parts, website images and everything
// generated for posts. Videos and audio are checked by the renderer (length, size, sound) before they can be used,
// then their speech is transcribed for subtitles (server/speech.ts): for free up to 10 minutes, on request (paid)
// for the long videos of paid plans (up to 2 hours, for clips).
export const media = new Hono<App>();
export const PART_SIZE = 8 * MB;
const accepted: Record<string, { kind: "image" | "video" | "audio"; max: number }> = {
  "image/jpeg": { kind: "image", max: 20 * MB },
  "image/png": { kind: "image", max: 20 * MB },
  "image/webp": { kind: "image", max: 20 * MB },
  // Videos: up to the plan's `videoMb` (shared/plans.ts).
  "video/mp4": { kind: "video", max: 500 * MB },
  "video/quicktime": { kind: "video", max: 500 * MB },
  "video/webm": { kind: "video", max: 500 * MB },
  "audio/mpeg": { kind: "audio", max: 50 * MB },
  "audio/wav": { kind: "audio", max: 50 * MB },
  "audio/x-wav": { kind: "audio", max: 50 * MB },
  "audio/mp4": { kind: "audio", max: 50 * MB },
  "audio/x-m4a": { kind: "audio", max: 50 * MB },
  "audio/aac": { kind: "audio", max: 50 * MB },
  "audio/ogg": { kind: "audio", max: 50 * MB },
};
export function assetView(a: any) {
  const meta = json<any>(a.meta, {});
  return {
    id: a.id, kind: a.kind, name: a.name, mime: a.mime, bytes: a.bytes, duration: a.duration, width: a.width, height: a.height,
    status: a.status, workspaceId: a.workspace_id, hasAudio: meta.hasAudio ?? null, error: a.status === "failed" ? meta.error || "This file can't be used." : null,
    createdAt: a.created_at, url: `/api/media/${a.id}/file`,
    // Speech found in an upload: "found", "none", "pending", "failed", or null when it was never looked for.
    ...speechView(a),
  };
}
async function ownedAsset(env: Env, userId: string, id: string) {
  const a = await env.DB.prepare("SELECT * FROM media_assets WHERE id=? AND user_id=?").bind(id, userId).first<any>();
  if (!a) throw new HTTPException(404, { message: "File not found." });
  return a;
}

media.get("/", async (c) => {
  const user = c.get("user");
  const q = z.object({
    workspace: z.uuid().optional(),
    type: z.enum(["image", "video", "audio"]).optional(),
    source: z.enum(["library", "generated", "all"]).default("library"),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }).parse(c.req.query());
  const where = ["user_id=?"], args: unknown[] = [user.id];
  // Lists never carry transcripts (a long video's can be a megabyte): only one file's view does (GET /:id).
  if (q.workspace) { where.push("(workspace_id=? OR workspace_id IS NULL)"); args.push(q.workspace); }
  if (q.type) { where.push("mime LIKE ?"); args.push(`${q.type}/%`); }
  // The library is what people can reuse: uploads, website images and stand-alone AI images; generated post files
  // (renders, voices, avatar videos) belong to their posts.
  if (q.source === "library") where.push("post_id IS NULL AND kind IN ('upload','brand','ai_image','ai_clip','portrait')");
  if (q.source === "generated") where.push("post_id IS NOT NULL");
  where.push("status<>'uploading'");
  const rows = (await c.env.DB.prepare(
    `SELECT id,kind,name,mime,bytes,duration,width,height,status,workspace_id,created_at,json_remove(meta,'$.transcript') AS meta FROM media_assets WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
  ).bind(...args, q.limit).all<any>()).results;
  const usage = await c.env.DB.prepare("SELECT COALESCE(SUM(bytes),0) AS used,(SELECT max_bytes FROM media_limits WHERE user_id=?) AS max FROM media_assets WHERE user_id=?")
    .bind(user.id, user.id).first<{ used: number; max: number | null }>();
  return c.json({ assets: rows.map(assetView), storage: { used: usage?.used || 0, max: usage?.max || 0 } });
});
media.post("/uploads", async (c) => {
  const user = c.get("user");
  await rate(c, "upload", 200, 3600, user.id);
  const d = z.object({
    name: z.string().trim().min(1).max(160),
    mime: z.string().max(80),
    bytes: z.number().int().min(24),
    workspaceId: z.uuid().optional(),
  }).parse(await c.req.json());
  const type = accepted[d.mime.toLowerCase()];
  if (!type) throw new HTTPException(415, { message: "Upload a JPG, PNG or WebP image, an MP4, MOV or WebM video, or an MP3, WAV, M4A or OGG track." });
  // Long videos (podcasts, webinars, calls: clips are cut from them) on paid plans.
  const plan = type.kind === "video" ? planById((await allowance(c.env, user)).plan) : null;
  const max = plan ? plan.videoMb * MB : type.max;
  if (d.bytes > max)
    throw new HTTPException(413, { message: `${type.kind === "image" ? "Images" : type.kind === "video" ? "Videos" : "Tracks"} can be up to ${max / MB} MB${plan?.id === "free" ? " on the free trial; paid plans take videos up to 2 hours" : ""}.` });
  if (d.workspaceId && !(await c.env.DB.prepare("SELECT 1 FROM workspaces WHERE id=? AND user_id=?").bind(d.workspaceId, user.id).first()))
    throw new HTTPException(404, { message: "Workspace not found." });
  const id = uid(), key = mediaKey(user.id, id, extOf(d.mime.toLowerCase()));
  // The full size is reserved now, so many parallel uploads cannot overfill the storage.
  try {
    await c.env.DB.prepare(
      "INSERT INTO media_assets(id,user_id,workspace_id,kind,name,object_key,mime,bytes,status,meta,created_at,updated_at) VALUES (?,?,?,'upload',?,?,?,?,'uploading',?,?,?)",
    ).bind(id, user.id, d.workspaceId || null, d.name, key, d.mime.toLowerCase(), d.bytes, JSON.stringify({ token: token(), maxSeconds: (plan?.videoMinutes || 10) * 60 }), now(), now()).run();
  } catch (e) {
    dbFailure(e);
  }
  const upload = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: d.mime.toLowerCase() } });
  await c.env.DB.prepare("UPDATE media_assets SET upload_id=? WHERE id=?").bind(upload.uploadId, id).run();
  return c.json({ id, partSize: PART_SIZE, parts: Math.ceil(d.bytes / PART_SIZE) }, 201);
});
media.put("/uploads/:id/parts/:part", async (c) => {
  const user = c.get("user");
  const a = await ownedAsset(c.env, user.id, c.req.param("id"));
  if (a.status !== "uploading" || !a.upload_id) throw new HTTPException(409, { message: "This upload has finished or expired. Start it again." });
  const part = Number(c.req.param("part")), parts = Math.ceil(a.bytes / PART_SIZE);
  if (!Number.isInteger(part) || part < 1 || part > parts) throw new HTTPException(400, { message: "Invalid upload part." });
  const body = new Uint8Array(await c.req.arrayBuffer());
  const expected = part < parts ? PART_SIZE : a.bytes - PART_SIZE * (parts - 1);
  if (body.length !== expected) throw new HTTPException(400, { message: "The upload part has the wrong size. Try the upload again." });
  const uploaded = await c.env.MEDIA.resumeMultipartUpload(a.object_key, a.upload_id).uploadPart(part, body);
  await c.env.DB.prepare("INSERT INTO media_parts(asset_id,part,etag,bytes) VALUES (?,?,?,?) ON CONFLICT(asset_id,part) DO UPDATE SET etag=excluded.etag,bytes=excluded.bytes")
    .bind(a.id, part, uploaded.etag, body.length).run();
  return c.json({ ok: true });
});
media.post("/uploads/:id/complete", async (c) => {
  const user = c.get("user");
  const a = await ownedAsset(c.env, user.id, c.req.param("id"));
  if (a.status !== "uploading") return c.json({ asset: assetView(a) });
  const parts = (await c.env.DB.prepare("SELECT part,etag,bytes FROM media_parts WHERE asset_id=? ORDER BY part").bind(a.id).all<any>()).results;
  const expected = Math.ceil(a.bytes / PART_SIZE);
  if (parts.length !== expected || parts.reduce((n, p) => n + p.bytes, 0) !== a.bytes)
    throw new HTTPException(409, { message: "Some parts of the upload are missing. Try the upload again." });
  await c.env.MEDIA.resumeMultipartUpload(a.object_key, a.upload_id).complete(parts.map((p) => ({ partNumber: p.part, etag: p.etag })));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM media_parts WHERE asset_id=?").bind(a.id),
    c.env.DB.prepare("UPDATE media_assets SET status='checking',upload_id=NULL,updated_at=? WHERE id=?").bind(now(), a.id),
  ]);
  if (a.mime.startsWith("image/")) {
    // Images are checked from their header here: type, size and pixel dimensions.
    const info = imageInfo((await head(c.env, a.object_key)) || new Uint8Array());
    if (!info || !imageFits(info) || info.mime !== (a.mime === "image/jpg" ? "image/jpeg" : a.mime)) {
      await failAsset(c.env, a.id, info && !imageFits(info) ? "Images can be up to 4096 × 4096 pixels." : "This isn't a readable JPG, PNG or WebP image.");
    } else {
      await c.env.DB.prepare("UPDATE media_assets SET status='ready',width=?,height=?,updated_at=? WHERE id=?").bind(info.width, info.height, now(), a.id).run();
    }
  } else if (c.env.CONTENT) {
    try {
      await c.env.CONTENT.create({ id: `inspect-${a.id}`, params: { inspectId: a.id } });
    } catch {
      await failAsset(c.env, a.id, "The file couldn't be checked. Try uploading it again.");
    }
  } else {
    await failAsset(c.env, a.id, "Video and audio uploads are being set up. Please try again soon.");
  }
  return c.json({ asset: assetView(await ownedAsset(c.env, user.id, a.id)) });
});
/** Marks an upload unusable; its storage reservation is released (the file itself is deleted by maintenance). */
export async function failAsset(env: Env, id: string, error: string) {
  const a = await env.DB.prepare("SELECT meta FROM media_assets WHERE id=?").bind(id).first<{ meta: string }>();
  await env.DB.prepare("UPDATE media_assets SET status='failed',bytes=0,meta=?,updated_at=? WHERE id=?")
    .bind(JSON.stringify({ ...json<any>(a?.meta, {}), error, token: undefined }), now(), id).run();
}
media.get("/:id", async (c) => {
  const a = await ownedAsset(c.env, c.get("user").id, c.req.param("id"));
  // One file also brings its transcript (word timings for the subtitle preview); lists do not. A clip of a long video
  // asks only for the words of its moment (?from=&to=, seconds).
  const q = z.object({ from: z.coerce.number().min(0).optional(), to: z.coerce.number().min(0).optional() }).parse(c.req.query());
  const moments = json<any>(a.meta, {}).moments?.list;
  return c.json({ asset: {
    ...assetView(a), transcript: speechView(a).speech === "found" ? storedTranscript(a.meta, q.from, q.to) : null,
    // The moments last found in it for clips (server/shorts.ts).
    moments: Array.isArray(moments) ? moments : [],
  } });
});
/** "Find speech": transcribes an older upload (or one that failed before), free but limited per hour and day. */
media.post("/:id/speech", async (c) => {
  const user = c.get("user");
  const a = await ownedAsset(c.env, user.id, c.req.param("id"));
  const meta = json<any>(a.meta, {}), status = speechView(a).speech;
  if (status === "found" || status === "pending") return c.json({ asset: assetView(a) });
  if (a.status !== "ready" || !mayHaveSpeech(a, meta.hasAudio))
    throw new HTTPException(400, { message: meta.hasAudio === false ? "This file has no sound." : mayTranscribe(a, meta.hasAudio) ? "This video is longer than 10 minutes: transcribe it for credits instead." : "Speech can be found in your own videos and tracks up to 10 minutes long." });
  if (status === "none") throw new HTTPException(409, { message: "We listened to this file already and heard no speech." });
  if (!c.env.CONTENT || !c.env.MEDIA_RENDERER) throw new HTTPException(503, { message: "Finding speech isn't available right now. Please try again later." });
  await rate(c, "speech", 10, 3600, user.id);
  const next = await claimSpeech(c.env, user.id, meta, a.duration);
  if (!next) throw new HTTPException(429, { message: "You've used today's free speech finding (20 files or 30 minutes of video). Try again tomorrow." });
  await c.env.DB.prepare("UPDATE media_assets SET meta=?,updated_at=? WHERE id=?").bind(JSON.stringify(next), now(), a.id).run();
  try {
    await c.env.CONTENT.create({ id: `speech-${a.id}-${now()}`, params: { inspectId: a.id } });
  } catch {
    await c.env.DB.prepare("UPDATE media_assets SET meta=? WHERE id=?").bind(JSON.stringify({ ...meta, speech: { status: "failed", at: now() } }), a.id).run();
    throw new HTTPException(503, { message: "Finding speech isn't available right now. Please try again later." });
  }
  return c.json({ asset: assetView(await ownedAsset(c.env, user.id, a.id)) }, 202);
});
/**
 * Speech to text of a long video (for clips), on request: speechCredits(duration) AI credits, the price the person was
 * shown (`credits`; a different one is refused). A run of kind "speech" reserves them; a failed one is refunded.
 */
media.post("/:id/transcribe", async (c) => {
  const user = c.get("user");
  if (!user.verified) throw new HTTPException(403, { message: "Confirm your email to use AI credits." });
  const d = z.object({ idempotencyKey: z.uuid(), credits: z.number().int().min(0) }).parse(await c.req.json());
  const a = await ownedAsset(c.env, user.id, c.req.param("id"));
  const meta = json<any>(a.meta, {}), status = speechView(a).speech;
  const previous = await c.env.DB.prepare("SELECT 1 FROM runs WHERE user_id=? AND idempotency_key=?").bind(user.id, d.idempotencyKey).first();
  if (previous || status === "found" || status === "pending") return c.json({ asset: assetView(a) });
  if (a.status !== "ready" || !mayTranscribe(a, meta.hasAudio))
    throw new HTTPException(400, { message: meta.hasAudio === false ? "This file has no sound." : a.duration <= SPEECH_MAX_SECONDS ? "Speech in files up to 10 minutes is found for free: use Find speech." : "Choose one of your own videos up to 2 hours long." });
  if (status === "none") throw new HTTPException(409, { message: "We listened to this file already and heard no speech." });
  if (!mediaEnabled(c.env) || !c.env.CONTENT || !c.env.ELEVENLABS_API_KEY?.trim()) throw new HTTPException(503, { message: "Speech to text isn't available right now. Please try again later." });
  await rate(c, "transcribe", 20, 3600, user.id);
  const credits = speechCredits(a.duration);
  if (d.credits !== credits) throw new HTTPException(409, { message: `Transcribing this video costs ${creditsLabel(credits)}. Check the price and try again.` });
  const w = await allowance(c.env, user);
  if (w.trialEnded) throw new HTTPException(402, { message: "Your free trial has ended. Upgrade to keep creating." });
  const runId = uid(), t = now();
  try {
    await c.env.DB.batch([
      // The credits are reserved by the insert (trigger run_credit_reserve); one active transcription per file (index).
      c.env.DB.prepare("INSERT INTO runs(id,user_id,post_id,window_id,idempotency_key,kind,initial,credits,status,payload,created_at,updated_at) VALUES (?,?,NULL,?,?,'speech',0,?,'queued',?,?,?)")
        .bind(runId, user.id, w.window, d.idempotencyKey, credits, JSON.stringify({ assetId: a.id }), t, t),
      c.env.DB.prepare("UPDATE media_assets SET meta=?,updated_at=? WHERE id=?").bind(JSON.stringify(listening(meta, { run: runId })), t, a.id),
    ]);
  } catch (e) {
    // The same request twice, or a transcription of this file already started: nothing more is charged.
    if (String((e as Error)?.message || e).includes("UNIQUE")) return c.json({ asset: assetView(await ownedAsset(c.env, user.id, a.id)) });
    dbFailure(e);
  }
  await dispatchRun(c.env, runId);
  return c.json({ asset: assetView(await ownedAsset(c.env, user.id, a.id)), credits }, 202);
});
media.get("/:id/file", async (c) => {
  const a = await ownedAsset(c.env, c.get("user").id, c.req.param("id"));
  if (a.status === "uploading" || a.status === "failed") throw new HTTPException(404, { message: "This file isn't available." });
  const response = await serveObject(c.env, a.object_key, c.req.header("Range"));
  if (c.req.query("download") === "1")
    response.headers.set("Content-Disposition", `attachment; filename="${a.name.replace(/[^\w.\- ]+/g, "_").slice(0, 80) || "file"}.${extOf(a.mime)}"`);
  return response;
});
media.patch("/:id", async (c) => {
  const a = await ownedAsset(c.env, c.get("user").id, c.req.param("id"));
  const d = z.object({ name: z.string().trim().min(1).max(160) }).parse(await c.req.json());
  await c.env.DB.prepare("UPDATE media_assets SET name=?,updated_at=? WHERE id=?").bind(d.name, now(), a.id).run();
  return c.json({ ok: true });
});
media.delete("/:id", async (c) => {
  const user = c.get("user");
  const a = await ownedAsset(c.env, user.id, c.req.param("id"));
  if (a.post_id) throw new HTTPException(409, { message: "This file belongs to a post. Delete the post instead." });
  // A file a post is being made from right now stays until that run finishes.
  const busy = await c.env.DB.prepare("SELECT 1 FROM runs r JOIN posts p ON p.id=r.post_id WHERE r.user_id=? AND r.status IN ('queued','running') AND p.spec LIKE ? LIMIT 1")
    .bind(user.id, `%${a.id}%`).first();
  if (busy) throw new HTTPException(409, { message: "A post is being made with this file. Try again when it's ready." });
  if (a.upload_id) await c.env.MEDIA.resumeMultipartUpload(a.object_key, a.upload_id).abort().catch(() => {});
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE workspaces SET logo_asset=NULL WHERE logo_asset=? AND user_id=?").bind(a.id, user.id),
    c.env.DB.prepare("DELETE FROM media_assets WHERE id=?").bind(a.id),
  ]);
  return c.json({ ok: true });
});

/**
 * The renderer reads an upload it is checking through a capability link (token in the URL, while checking), and
 * ElevenLabs Scribe a ready one whose speech it transcribes (its own token, while that is pending, 3 hours at most).
 */
export const uploadInputs = new Hono<{ Bindings: Env }>();
uploadInputs.get("/:id", async (c) => {
  const a = await c.env.DB.prepare("SELECT object_key,meta,status FROM media_assets WHERE id=?").bind(c.req.param("id")).first<any>();
  const meta = json<any>(a?.meta, {}), given = c.req.query("token") || "";
  const checking = a?.status === "checking" && typeof meta.token === "string" && safeEqual(meta.token, given);
  const listening = a?.status === "ready" && typeof meta.listen?.token === "string" && meta.listen.until > now() && safeEqual(meta.listen.token, given);
  if (!a || !(checking || listening)) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, a.object_key, c.req.header("Range"), "no-store");
});
