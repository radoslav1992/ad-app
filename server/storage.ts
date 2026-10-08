import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";
import { MB } from "./types";

/** Pixel size and type declared in a PNG, JPEG or WebP header, or null. Header-only: nothing is decoded. */
export function imageInfo(b: Uint8Array): { width: number; height: number; mime: "image/png" | "image/jpeg" | "image/webp" } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 24 && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71)
    return { width: v.getUint32(16), height: v.getUint32(20), mime: "image/png" };
  if (b.length >= 30 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === "VP8X") return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)), mime: "image/webp" };
    if (chunk === "VP8 ") return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff, mime: "image/webp" };
    if (chunk === "VP8L") {
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, mime: "image/webp" };
    }
    return null;
  }
  if (b[0] !== 255 || b[1] !== 216) return null;
  // JPEG: walk the segments to the first start-of-frame marker (C0–CF except DHT C4, JPG C8 and DAC CC).
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 255) return null;
    const marker = b[i + 1];
    if (marker === 255) { i++; continue; }
    if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) { i += 2; continue; }
    if (marker === 218 || marker === 217) return null;
    const length = (b[i + 2] << 8) | b[i + 3];
    if (length < 2) return null;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker))
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], mime: "image/jpeg" };
    i += 2 + length;
  }
  return null;
}
/** The largest picture the renderer accepts (it would otherwise decode to gigabytes from a tiny file). */
export const MAX_IMAGE_SIDE = 4096;
export const imageFits = (s: { width: number; height: number } | null) =>
  !!s && s.width > 0 && s.height > 0 && s.width <= MAX_IMAGE_SIDE && s.height <= MAX_IMAGE_SIDE;

/** Streams a download into storage in parts (bounded memory); refuses more than `limit` bytes. */
export async function storeStream(e: Env, key: string, response: Response, limit: number, mime: string) {
  if (!response.ok || !response.body) throw new Error("MEDIA_DOWNLOAD");
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body.cancel();
    throw new Error("MEDIA_SIZE");
  }
  const upload = await e.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
  const parts: R2UploadedPart[] = [];
  const reader = response.body.getReader();
  let buffer = new Uint8Array(5 * MB), offset = 0, total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error("MEDIA_SIZE");
      let at = 0;
      while (at < value.length) {
        const n = Math.min(buffer.length - offset, value.length - at);
        buffer.set(value.subarray(at, at + n), offset);
        offset += n;
        at += n;
        if (offset === buffer.length) {
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          buffer = new Uint8Array(5 * MB);
          offset = 0;
        }
      }
    }
    if (total < 24) throw new Error("MEDIA_EMPTY");
    if (offset) parts.push(await upload.uploadPart(parts.length + 1, buffer.slice(0, offset)));
    await upload.complete(parts);
    return total;
  } catch (err) {
    await reader.cancel().catch(() => {});
    await upload.abort();
    throw err;
  }
}
/** Serves a stored object with Range support (players seek, networks fetch in parts). */
export async function serveObject(e: Env, key: string, range?: string | null, cache = "private, max-age=3600") {
  const obj = await e.MEDIA.get(key, range ? { range: new Headers({ Range: range }) } : undefined);
  if (!obj) throw new HTTPException(404, { message: "This file is no longer available." });
  const headers = new Headers({
    "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": cache,
  });
  if (obj.range && "offset" in obj.range && "length" in obj.range) {
    const r = obj.range as { offset: number; length: number };
    headers.set("Content-Range", `bytes ${r.offset}-${r.offset + r.length - 1}/${obj.size}`);
    headers.set("Content-Length", String(r.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
}
/** The first bytes of a stored object (headers of images and videos). */
export async function head(e: Env, key: string, length = 64 * 1024) {
  const o = await e.MEDIA.get(key, { range: { offset: 0, length } });
  return o ? new Uint8Array(await o.arrayBuffer()) : null;
}
/** Key of a user's media file. Everything a user owns lives under media/{user}/ (one prefix to delete). */
export const mediaKey = (userId: string, id: string, ext: string) => `media/${userId}/${id}.${ext}`;
export const extOf = (mime: string) =>
  ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/aac": "aac", "audio/ogg": "ogg" } as Record<string, string>)[mime] || "bin";

/** A clip's length from its MP4 `mvhd` box (moov read from storage), or null. */
export function mvhdDuration(moov: Uint8Array): number | null {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  for (let at = 0; at + 8 <= moov.length;) {
    const size = view.getUint32(at), type = String.fromCharCode(...moov.subarray(at + 4, at + 8));
    if (type === "mvhd") {
      const v = moov[at + 8];
      const scale = view.getUint32(at + (v === 1 ? 28 : 20));
      const units = v === 1 ? Number(view.getBigUint64(at + 32)) : view.getUint32(at + 24);
      return scale > 0 && units > 0 ? Math.round((units / scale) * 100) / 100 : null;
    }
    if (size < 8) return null;
    at += size;
  }
  return null;
}
/** The length of a stored MP4: its top-level boxes are walked by ranged reads to the (small) moov box. */
export async function storedDuration(e: Env, key: string, size: number): Promise<number | null> {
  for (let offset = 0, n = 0; offset + 8 <= size && n < 32; n++) {
    const head = await e.MEDIA.get(key, { range: { offset, length: 16 } });
    if (!head) return null;
    const b = new Uint8Array(await head.arrayBuffer()), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let length = view.getUint32(0), header = 8;
    if (length === 1) { length = Number(view.getBigUint64(8)); header = 16; } else if (length === 0) length = size - offset;
    if (String.fromCharCode(...b.subarray(4, 8)) === "moov") {
      const body = await e.MEDIA.get(key, { range: { offset: offset + header, length: Math.min(length - header, 8 * MB) } });
      return body ? mvhdDuration(new Uint8Array(await body.arrayBuffer())) : null;
    }
    if (length < header) return null;
    offset += length;
  }
  return null;
}
