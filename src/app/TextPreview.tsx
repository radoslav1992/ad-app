import { useEffect, useMemo, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import type { CaptionDocument } from "../../shared/captions";
import { overlayItems, type TextLook } from "../../shared/overlay";
import { FRAME } from "../../shared/render";
import { drawCaptions, drawItems, fitCanvas, loadCaptionFonts, onFrame, reducedMotion } from "./caption-canvas";
import "./post.css";

// The editor's preview of a post: its picture, the on-screen text and the spoken captions, drawn from the same items
// and keyframes the renderer burns in (shared/overlay.ts, shared/caption-scene.ts), with the same fonts.

/** A text block on the preview's clock (its entrance starts at `start`). */
export type TextBlock = { text: string; look: TextLook; start: number; end: number };
export type PreviewBackground = { url: string; kind: "image" | "video"; start?: number } | { color: string } | null;

/**
 * A 9:16 preview that loops `seconds` of a post. Its clock is a timer, or the background video itself (`videoClock`:
 * a talking creator, a demo with speech), so captions stay in sync with what is heard. A video background starts at
 * `start` and restarts with the loop. With reduced motion the text is shown without its entrance.
 */
export function TextPreview({ blocks, background, seconds, captions, videoClock = false, sound = false, replay = "" }: {
  blocks: TextBlock[]; background?: PreviewBackground; seconds: number;
  /** Spoken captions, words on the preview's clock. */
  captions?: CaptionDocument | null;
  videoClock?: boolean;
  /** Offer the background video's sound (muted until asked). */
  sound?: boolean;
  /** A change restarts the loop (e.g. a new entrance animation, to show it). */
  replay?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [still] = useState(reducedMotion);
  // The loop's start: kept while the words change (typing does not restart it), reset by `replay`.
  const begun = useRef(0);
  useEffect(() => { begun.current = performance.now(); }, [replay]);
  const key = JSON.stringify(blocks);
  // Items are laid out once per change of the words or look, not per frame.
  const items = useMemo(() => blocks.map((b) => ({ ...b, items: overlayItems(b.text, b.look, FRAME.width, FRAME.height, still ? undefined : { start: b.start, end: b.end }) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for the blocks' content
    [key, still]);
  const videoUrl = background && "url" in background && background.kind === "video" ? background.url : null;
  const start = background && "url" in background ? background.start || 0 : 0;
  useEffect(() => { loadCaptionFonts(); }, []);
  useEffect(() => {
    let last = 0;
    return onFrame((now) => {
      const c = canvas.current;
      if (!c) return;
      const v = video.current;
      let t: number;
      // The video is the clock once it can play (until then, or if it cannot, a timer stands in).
      if (videoClock && v && v.readyState >= 2) {
        // The demo's used part (or the whole recording) loops.
        if (v.readyState >= 1 && (v.currentTime >= start + seconds || v.currentTime < start - 0.5)) v.currentTime = start;
        t = Math.max(0, v.currentTime - start);
      } else {
        t = still ? Math.min(seconds - 0.05, 0.85) : ((now - begun.current) / 1000) % Math.max(0.5, seconds);
        // A looping clip behind the text restarts with the post's loop, as it does in the render.
        if (v && t < last && v.readyState >= 1) v.currentTime = start;
      }
      last = t;
      const k = fitCanvas(c, FRAME.width, FRAME.height), ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      for (const b of items) if (still || (t >= b.start && t < b.end)) drawItems(ctx, b.items, t);
      if (captions) drawCaptions(ctx, FRAME.width, FRAME.height, t, captions);
    });
  }, [items, captions, seconds, videoClock, start, still, videoUrl]);
  // A new start (the demo slider) moves the video there at once.
  useEffect(() => {
    const v = video.current;
    if (v && v.readyState >= 1) v.currentTime = start;
  }, [videoUrl, start]);
  return (
    <div className="phone-frame text-preview">
      {background && "url" in background && (background.kind === "video"
        ? <video ref={video} key={background.url} src={background.url} muted={muted} loop playsInline autoPlay preload="auto"
          onLoadedMetadata={(e) => { if (start) e.currentTarget.currentTime = start; }} />
        : <img src={background.url} alt="" />)}
      {background && "color" in background && <div className="tp-color" style={{ background: background.color }} />}
      <canvas ref={canvas} className="tp-canvas" role="img" aria-label={blocks.map((b) => b.text).filter(Boolean).join(" · ") || "Post preview"} />
      {sound && videoUrl && (
        <button type="button" className="mute" onClick={() => setMuted(!muted)} aria-label={muted ? "Turn the sound on" : "Mute"} aria-pressed={!muted}>
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      )}
    </div>
  );
}
