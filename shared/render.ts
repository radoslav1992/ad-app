import type { Motion } from "./layers";

// The contract between the Worker and the private renderer container (renderer/server.py). The Worker turns a post
// into one of these payloads (server/render-plan.ts); the renderer downloads every input from short-lived
// capability URLs on this site, runs FFmpeg/libass and keeps the results until the Worker downloads them.
//
// HTTP (container port 8080, reachable only through the Durable Object binding):
//   POST   /jobs              body: RenderPayload → 202 {status:"running"} | 200 {status} (already known) | 429 busy
//   GET    /jobs/:id          → {status:"running"|"completed"|"failed", duration?, error?, files?, meta?}
//   GET    /jobs/:id/file/:n  → the n-th output file (video/mp4 or image/jpeg)
//   DELETE /jobs/:id          → forgets the job (stops it if running)

/** Every frame is 9:16 portrait at 1080 × 1920, the size all short-form networks show full-screen. */
export const FRAME = { width: 1080, height: 1920 } as const;

export type ComposeSegment = {
  /** Index into `urls` (not used by "color"). */
  input?: number;
  kind: "image" | "video" | "color";
  /** "color" only: the solid background, #rrggbb. */
  color?: string;
  /** Seconds this segment lasts in the output (0.5–120). A video shorter than that holds its last frame. */
  duration: number;
  /** Video only: where in the source the segment starts (seconds). */
  trim?: number;
  /** Image only: slow zoom or pan over the still. */
  motion?: Motion | null;
  /** "cover" (default) fills the frame and crops; "contain" shows the whole picture on a blurred copy of itself. */
  fit?: "cover" | "contain";
  /** Video only: volume of its own sound (0–1). Absent or 0: silent. */
  audio?: number;
};
export type ComposePayload = {
  id: string;
  operation: "compose";
  urls: string[];
  width: number;
  height: number;
  /** 1–20 segments joined with hard cuts. */
  segments: ComposeSegment[];
  /** A separate speech track placed at `start` seconds on the output clock. */
  voice?: { input: number; start: number; volume: number } | null;
  /** Background music: loops if shorter than the video, fades in/out, lowered under speech during `duck` ranges. */
  music?: { input: number; volume: number; duck: [number, number][] } | null;
  /** A green-screen clip keyed over the segments (below the text), shown from `start` to `end` (looped if shorter). */
  overlay?: {
    input: number; start: number; end: number; chroma: string; similarity: number; blend: number;
    /** Width as a share of the frame; x/y anchor the overlay inside the frame (y 1 = sits on the bottom edge). */
    width: number; x: number; y: number;
    audio?: number;
  } | null;
  /** Burned over the whole output (captions, on-screen text, watermark), in the frame's pixels. */
  ass: string;
  /** Also write a JPEG cover (output file 1) from this second of the finished video. */
  coverAt?: number | null;
  /** Mark the files as AI-generated (MP4 metadata + XMP). */
  synthetic: boolean;
};
export type StillsPayload = {
  id: string;
  operation: "stills";
  urls: string[];
  width: number;
  height: number;
  /** 1–10 slides: the image (or a solid colour) cover-cropped to the frame, then its ASS burned in → file i (JPEG). */
  slides: { input?: number; color?: string; ass: string }[];
  synthetic: boolean;
};
/** Reads an uploaded file: video/audio length, picture size, whether it has sound. */
export type InspectPayload = { id: string; operation: "inspect"; url: string };
export type RenderPayload = ComposePayload | StillsPayload | InspectPayload;

export type RenderStatus = {
  status: "running" | "completed" | "failed";
  /** compose: length of the video; inspect: length of the media (0 for images). */
  duration?: number;
  /** A short code (MEDIA_*), never a raw message. */
  error?: string;
  /** How many output files GET /jobs/:id/file/:n serves. */
  files?: number;
  /** inspect: what the file is. */
  meta?: { kind: "video" | "audio" | "image"; width: number; height: number; hasAudio: boolean };
};
