import { Container } from "@cloudflare/containers";
import type { Env } from "./types";
import type { RenderPayload, RenderStatus } from "../shared/render";
import { PRODUCT } from "../shared/brand";

/** The private FFmpeg container (renderer/server.py). It only downloads capability links from this site. */
export class MediaRenderer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "1m";
  envVars = {
    SOURCE_ORIGIN: this.env.SITE_URL ? new URL(this.env.SITE_URL).origin : "",
    PRODUCT_NAME: PRODUCT.name,
  };
}

// Three renderer containers, each running one job at a time (busy: 429). A job starts on the one its ID hashes to
// and moves to a free one when that one is busy; the caller records the slot that accepted it, so status checks,
// the download and a stop reach the same container.
export const RENDERERS = 3;
export const hashSlot = (id: string) => (parseInt(id.replace(/[^0-9a-f]/gi, "").slice(0, 8), 16) || 0) % RENDERERS;
const container = (e: Env, slot: number) => e.MEDIA_RENDERER!.get(e.MEDIA_RENDERER!.idFromName(`render-${slot}`));

/**
 * Hands a job to a container: the recorded one, else the hash slot, else the next free one. A container answers 200
 * for a job it already has and 429 only when it does not have it, so trying the next one never starts a job twice.
 * Returns the slot that holds the job, or null when all are busy (try again later).
 */
export async function submitRender(e: Env, payload: RenderPayload, recorded: number | null, record: (slot: number) => Promise<void>) {
  if (!e.MEDIA_RENDERER) throw new Error("RENDERER_UNAVAILABLE");
  const first = recorded ?? hashSlot(payload.id);
  for (let n = 0; n < RENDERERS; n++) {
    const slot = (first + n) % RENDERERS;
    await record(slot);
    const r = await container(e, slot).fetch("http://renderer/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (r.status === 429) continue;
    if (!r.ok) throw new Error("RENDERER_UNAVAILABLE");
    return slot;
  }
  await record(first);
  return null;
}
export async function renderStatus(e: Env, slot: number, id: string): Promise<RenderStatus> {
  const r = await container(e, slot).fetch(`http://renderer/jobs/${id}`);
  if (r.status === 404) return { status: "failed", error: "MEDIA_LOST" };
  if (!r.ok) throw new Error("RENDERER_UNAVAILABLE");
  return r.json() as Promise<RenderStatus>;
}
export async function renderFile(e: Env, slot: number, id: string, n: number) {
  const r = await container(e, slot).fetch(`http://renderer/jobs/${id}/file/${n}`);
  if (!r.ok) throw new Error("RENDERER_UNAVAILABLE");
  return r;
}
/** Best effort: forgets a finished job or stops one still running (frees the slot at once). */
export async function releaseRender(e: Env, slot: number, id: string) {
  if (!e.MEDIA_RENDERER) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      container(e, slot).fetch(`http://renderer/jobs/${id}`, { method: "DELETE" }),
      new Promise((resolve) => { timer = setTimeout(resolve, 10000); }),
    ]);
  } catch { /* The container may be asleep or gone; then nothing runs. */ } finally {
    clearTimeout(timer);
  }
}
/** What people read when rendering fails, by the renderer's reason. */
export const renderFailures: Record<string, string> = {
  MEDIA_TOO_LARGE: "An image or video in this post is too large (over 4096 × 4096 pixels). Use a smaller file.",
  MEDIA_NO_AUDIO: "A video in this post has no sound where sound is needed.",
  MEDIA_TOO_LONG: "This post would be longer than 3 minutes. Shorten it.",
  MEDIA_INPUT: "A file in this post couldn't be loaded (it may have been deleted). Choose it again.",
  MEDIA_TIMEOUT: "Making this post took too long. Try again, or use shorter clips.",
  MEDIA_FORMAT: "A file in this post can't be read. Use MP4, MOV or WebM videos and JPG or PNG images.",
  MEDIA_LOST: "The video service restarted while making this post. Try again.",
  RENDERER_UNAVAILABLE: "The video service didn't answer. Try again in a few minutes.",
};
