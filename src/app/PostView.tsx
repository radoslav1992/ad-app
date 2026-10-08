import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Volume2, VolumeX, AlertTriangle } from "lucide-react";
import { fileUrl, type Post } from "../lib";
import "./post.css";

// A post as people see it on their phone: the rendered video (or the slides of a slideshow), or its progress. The
// editor's live preview (text, captions and their animation) is TextPreview.tsx.

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
