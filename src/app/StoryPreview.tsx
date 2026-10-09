import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { CaptionDocument } from "../../shared/captions";
import { motionAt, motionFor } from "../../shared/layers";
import { FRAME } from "../../shared/render";
import { FPS, type StorySegment, type TransitionKind } from "../../shared/story";
import { drawCaptions, fitCanvas, loadCaptionFonts, onFrame, reducedMotion } from "./caption-canvas";
import type { StoryPlayer } from "./story-model";
import "./post.css";

// The narrated video's preview: every scene's picture on the voice's clock as the render places it (the same segments,
// shared/story.ts), stills moving as the renderer moves them, each transition approximated with CSS over the same frames
// as FFmpeg's xfade, and the subtitles drawn by the caption engine. With reduced motion, scenes simply cut.

/** A scene's picture: a made or chosen image or clip, or the description of an AI picture still to make. */
export type ScenePicture = { url: string; kind: "image" | "video"; loop?: boolean; poster?: string } | { pending: string };

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
type Look = { opacity: number; transform: string; clip: string; mask: string };
/**
 * How a picture looks `p` (0–1) through a transition, coming in or going out (xfade's look: fades blend, "fadeblack"
 * goes dark early, slides move both pictures, wipes and the circle reveal the new one, "zoomin" pushes into the old).
 */
function transitionLook(kind: TransitionKind, p: number, incoming: boolean, box: { w: number; h: number }): Partial<Look> {
  switch (kind) {
    case "fade": case "dissolve": return incoming ? { opacity: p } : {};
    case "fadeblack": return incoming ? { opacity: smooth(0.2, 1, p) } : { opacity: 1 - smooth(0, 0.2, p) };
    case "slideleft": return { transform: `translateX(${incoming ? (1 - p) * 100 : -p * 100}%)` };
    case "slideup": return { transform: `translateY(${incoming ? (1 - p) * 100 : -p * 100}%)` };
    case "wipeleft": return incoming ? { clip: `inset(0 0 0 ${((1 - p) * 100).toFixed(2)}%)` } : {};
    case "smoothleft": {
      if (!incoming) return {};
      const edge = (1 - p) * 120 - 10;
      return { mask: `linear-gradient(to right, transparent ${(edge - 10).toFixed(1)}%, #000 ${(edge + 10).toFixed(1)}%)` };
    }
    case "circleopen": {
      if (!incoming) return {};
      const r = p * Math.hypot(box.w, box.h) * 0.62;
      return { mask: `radial-gradient(circle at 50% 50%, #000 ${Math.max(0, r - 24).toFixed(0)}px, transparent ${(r + 24).toFixed(0)}px)` };
    }
    case "zoomin": return incoming ? { opacity: smooth(0.35, 1, p) } : { transform: `scale(${(1 + p * 1.6).toFixed(3)})` };
  }
}

export function StoryPreview({ segments, scenes, pictures, captions, player, audioUrl, label }: {
  segments: StorySegment[];
  /** Each scene's start and end on the clock (for reduced motion: plain cuts). */
  scenes: { start: number; end: number }[];
  pictures: ScenePicture[];
  captions: CaptionDocument | null;
  player: StoryPlayer;
  audioUrl: string | null;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), layers = useRef<(HTMLDivElement | null)[]>([]);
  const [still] = useState(reducedMotion);
  const { now, playing } = player;
  useEffect(() => { loadCaptionFonts(); }, []);
  useEffect(() => {
    return onFrame(() => {
      const t = now(), f = t * FPS;
      segments.forEach((seg, k) => {
        const el = layers.current[k];
        if (!el) return;
        const scene = scenes[seg.scene], last = k === segments.length - 1;
        const on = still ? t >= scene.start && (t < scene.end || last) : f >= seg.from && (f < seg.from + seg.frames || last);
        // Whether a layer is on is kept on the element: a new clock (the words arrived, an edge moved) starts a new
        // loop, and a layer shown by the old one must still be hidden.
        const video = el.querySelector("video"), was = el.dataset.on === "1";
        if (!on) {
          if (was || el.style.visibility !== "hidden") { el.dataset.on = ""; el.style.visibility = "hidden"; video?.pause(); }
          return;
        }
        const local = Math.max(0, (f - seg.from) / FPS);
        if (!was) {
          el.dataset.on = "1";
          el.style.visibility = "visible";
          if (video && video.readyState >= 1) video.currentTime = video.loop && video.duration ? local % video.duration : Math.min(local, video.duration || local);
        }
        // A clip plays along while the voice plays (and is put back on the clock when it drifts).
        if (video) {
          if (playing && video.paused) void video.play().catch(() => {});
          if (!playing && !video.paused) video.pause();
          if (!playing && video.readyState >= 1 && Math.abs(video.currentTime - local) > 0.2 && !video.loop) video.currentTime = Math.min(local, video.duration || local);
        }
        // Stills move slowly, each scene differently (renderer/server.py motion_filter).
        const picture = el.firstElementChild as HTMLElement | null;
        if (picture?.tagName === "IMG" && !still) {
          const m = motionAt(motionFor(seg.scene), (f - seg.from) / seg.frames);
          picture.style.transform = `translate(${-(m.zoom - 1) * m.x * 100}%, ${-(m.zoom - 1) * m.y * 100}%) scale(${m.zoom})`;
        }
        const look: Look = { opacity: 1, transform: "", clip: "", mask: "" };
        const box = { w: el.clientWidth, h: el.clientHeight };
        if (!still && seg.transition && f < seg.from + seg.transition.frames) Object.assign(look, transitionLook(seg.transition.kind, (f - seg.from) / seg.transition.frames, true, box));
        const next = segments[k + 1];
        if (!still && next?.transition && f >= next.from) Object.assign(look, transitionLook(next.transition.kind, (f - next.from) / next.transition.frames, false, box));
        el.style.zIndex = String(k + 1);
        el.style.opacity = String(look.opacity);
        el.style.transform = look.transform;
        el.style.clipPath = look.clip;
        el.style.maskImage = look.mask;
        el.style.setProperty("-webkit-mask-image", look.mask || "none");
      });
      const c = canvas.current;
      if (!c) return;
      const k = fitCanvas(c, FRAME.width, FRAME.height), ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      if (captions) drawCaptions(ctx, FRAME.width, FRAME.height, t, captions);
    });
  }, [segments, scenes, captions, now, playing, still]);
  return (
    <div className="phone-frame story-preview">
      {segments.map((seg, k) => {
        const pic = pictures[seg.scene];
        return (
          <div key={`${seg.scene}:${"url" in pic ? pic.url : "pending"}`} ref={(el) => { layers.current[k] = el; }} className="sp-layer">
            {"pending" in pic
              ? <div className="sp-pending"><span>Scene {seg.scene + 1} · AI picture</span><p>{pic.pending || "Describe this picture"}</p></div>
              : pic.kind === "video"
                ? <video src={pic.url} poster={pic.poster} muted playsInline loop={!!pic.loop} preload="auto" />
                : <img src={pic.url} alt="" />}
          </div>
        );
      })}
      <canvas ref={canvas} className="tp-canvas" role="img" aria-label={label} />
      {/* The voice is the clock; the browser plays it, the render mixes the same file. */}
      <audio ref={player.audio} src={audioUrl || undefined} preload="auto" onEnded={() => player.pause()} />
      <button type="button" className="sp-play" onClick={player.toggle} aria-label={playing ? "Pause the preview" : "Play the preview"}>
        {playing ? <Pause size={20} /> : <Play size={20} />}
      </button>
    </div>
  );
}
