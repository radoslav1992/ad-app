import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Volume2, VolumeX, AlertTriangle } from "lucide-react";
import { fileUrl, type Post } from "../lib";
import { layoutOverlay, type TextLook } from "../../shared/overlay";
import { FRAME } from "../../shared/render";
import "./post.css";

// A post as people see it on their phone: the rendered video (or the slides of a slideshow), or its progress.

export const phaseLabels: Record<string, string> = {
  images: "Making AI images…", clip: "Making an AI clip…", voice: "Recording the voice…", creator: "Animating your creator…",
  rendering: "Putting it together…", saving: "Almost done…",
};
export function PostPlayer({ post, muted = true, onMute, active = true, showSlides = true }: { post: Post; muted?: boolean; onMute?: (m: boolean) => void; active?: boolean; showSlides?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [slide, setSlide] = useState(0);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (active) void v.play().catch(() => {});
    else v.pause();
  }, [active, post.videoAssetId]);
  if (post.renderStatus !== "ready")
    return (
      <div className="phone-frame placeholder">
        {post.renderStatus === "failed" ? (
          <div className="stack center" style={{ alignItems: "center", padding: 20 }}>
            <AlertTriangle size={28} />
            <p>{post.renderError || "This post couldn't be made."}</p>
          </div>
        ) : (
          <div className="stack center" style={{ alignItems: "center" }}>
            <span className="spinner big" />
            <p>{phaseLabels[post.phase || ""] || "Writing and rendering…"}</p>
          </div>
        )}
      </div>
    );
  const slides = showSlides && post.format === "slideshow" ? post.slides : [];
  if (slides.length)
    return (
      <div className="phone-frame">
        <img src={fileUrl(slides[slide])} alt={`Slide ${slide + 1} of ${slides.length}`} />
        {slide > 0 && <button className="slide-arrow left" onClick={() => setSlide(slide - 1)} aria-label="Previous slide"><ChevronLeft size={20} /></button>}
        {slide < slides.length - 1 && <button className="slide-arrow right" onClick={() => setSlide(slide + 1)} aria-label="Next slide"><ChevronRight size={20} /></button>}
        <div className="slide-dots" aria-hidden="true">{slides.map((_, i) => <span key={i} className={i === slide ? "on" : ""} />)}</div>
      </div>
    );
  return (
    <div className="phone-frame">
      <video ref={video} key={post.videoAssetId} src={fileUrl(post.videoAssetId)} poster={post.coverAssetId ? fileUrl(post.coverAssetId) : undefined}
        muted={muted} loop playsInline autoPlay={active} preload="metadata" />
      {onMute && (
        <button className="mute" onClick={() => onMute(!muted)} aria-label={muted ? "Turn the sound on" : "Mute"}>
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      )}
    </div>
  );
}

/**
 * The on-screen text over a picture, laid out with the renderer's own measurements (shared/overlay.ts) and drawn
 * in the same font, so what people edit is what gets rendered.
 */
export function TextPreview({ text, look, background, extra }: {
  text: string; look: TextLook; background?: { url: string; kind: "image" | "video" } | { color: string } | null;
  /** A second text at another position (a demo caption). */
  extra?: { text: string; look: TextLook } | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / FRAME.width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const draw = (value: string, l: TextLook, key: string) => {
    const layout = layoutOverlay(value, l, FRAME.width, FRAME.height);
    const stroke = (l.stroke * FRAME.width) / 1080;
    return layout.lines.map((line, i) => {
      const base: CSSProperties = { top: line.y, fontSize: layout.size, lineHeight: `${layout.size * 1.36}px`, fontWeight: l.weight === "bold" ? 700 : 400 };
      return (
        <div key={`${key}-${i}`}>
          {l.background && <div className="tp-box" style={{ top: line.y, width: line.width + layout.size * 0.7, height: layout.size * 1.34, borderRadius: layout.size * 0.28, background: l.background }} />}
          <div className="tp-line" style={{ ...base, color: l.color, WebkitTextStroke: stroke > 0 ? `${stroke * 2}px ${l.strokeColor}` : undefined }}>{line.text}</div>
        </div>
      );
    });
  };
  return (
    <div className="phone-frame text-preview" ref={box}>
      {background && "url" in background && (background.kind === "video"
        ? <video src={background.url} muted loop playsInline autoPlay />
        : <img src={background.url} alt="" />)}
      <div className="tp-stage" style={{ width: FRAME.width, height: FRAME.height, transform: `scale(${scale})`, background: background && "color" in background ? background.color : undefined }} aria-label={text}>
        {draw(text, look, "a")}
        {extra?.text && draw(extra.text, extra.look, "b")}
      </div>
    </div>
  );
}
