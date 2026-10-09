import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, Volume2, VolumeX, AlertTriangle } from "lucide-react";
import { fileUrl, type Post } from "../lib";
import "./post.css";

// A post as people see it on their phone: the rendered video (or the slides of a slideshow or a carousel), or its
// progress. The editor's live preview (text, captions and their animation) is TextPreview.tsx. Slides move with
// buttons, never by dragging: Blitz cards are dragged to approve or skip.

export const phaseLabels: Record<string, string> = {
  images: "Making AI images…", clip: "Making an AI clip…", voice: "Recording the voice…", creator: "Animating your creator…",
  tracking: "Finding the speaker…", rendering: "Putting it together…", saving: "Almost done…",
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
  const carousel = post.format === "carousel";
  const slides = (showSlides && post.format === "slideshow") || carousel ? post.slides : [];
  const at = Math.min(slide, slides.length - 1);
  // A carousel's slides keep their shape (4:5 or 1:1); its buttons sit beside the dots, off the words.
  if (slides.length && carousel)
    return (
      <div className="phone-frame carousel" style={{ "--slide": post.aspect === "1:1" ? "1 / 1" : "4 / 5" } as CSSProperties}
        role="group" aria-roledescription="carousel" aria-label={`Carousel, slide ${at + 1} of ${slides.length}`}>
        <img src={fileUrl(slides[at])} alt={`Slide ${at + 1} of ${slides.length}`} />
        <div className="carousel-nav">
          <button type="button" className="slide-arrow" disabled={at === 0} onClick={() => setSlide(at - 1)} aria-label="Previous slide"><ChevronLeft size={18} /></button>
          <div className="slide-dots" aria-hidden="true">{slides.map((_, i) => <span key={i} className={i === at ? "on" : ""} />)}</div>
          <button type="button" className="slide-arrow" disabled={at === slides.length - 1} onClick={() => setSlide(at + 1)} aria-label="Next slide"><ChevronRight size={18} /></button>
        </div>
      </div>
    );
  if (slides.length)
    return (
      <div className="phone-frame">
        <img src={fileUrl(slides[at])} alt={`Slide ${at + 1} of ${slides.length}`} />
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
