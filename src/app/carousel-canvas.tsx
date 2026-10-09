import { useEffect, useMemo, useRef, useState } from "react";
import { fileUrl } from "../lib";
import { drawItems, fitCanvas, loadCaptionFonts } from "./caption-canvas";
import { carouselSlide, type CarouselInput, type CarouselSlideLayout } from "../../shared/carousel";

// One carousel slide drawn on a canvas from the shared layout (shared/carousel.ts) in the order the renderer composes
// it: the page colour, the picture cover-cropped into its (rounded) box, the words and shapes, then the logo fitted in
// its box. The render (renderer op "stills") draws the same boxes and items, so this is what the post will look like.

const images = new Map<string, HTMLImageElement>();
/** A picture by URL once it has loaded (kept for the page's life, so slides and theme tiles share it). */
export function useImage(url: string | null) {
  const [, setLoaded] = useState(0);
  const el = url ? images.get(url) : undefined;
  useEffect(() => {
    if (!url) return;
    let img = images.get(url);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.src = url;
      images.set(url, img);
    }
    if (img.complete) return;
    const done = () => setLoaded((n) => n + 1);
    img.addEventListener("load", done);
    img.addEventListener("error", done);
    return () => { img!.removeEventListener("load", done); img!.removeEventListener("error", done); };
  }, [url]);
  return el && el.complete && el.naturalWidth ? el : null;
}

const whole = (b: { x: number; y: number; w: number; h: number }) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) });
/** Paints a laid-out slide; `pending`: the slide's AI picture is still to be made (a placeholder shows where). */
export function paintSlide(ctx: CanvasRenderingContext2D, l: CarouselSlideLayout, picture: HTMLImageElement | null, logo: HTMLImageElement | null, pending: boolean) {
  ctx.fillStyle = l.background;
  ctx.fillRect(0, 0, l.width, l.height);
  if (l.picture) {
    const { x, y, w, h } = whole(l.picture), r = Math.round(l.picture.radius);
    ctx.save();
    ctx.beginPath();
    if (r > 0 && ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
    ctx.clip();
    if (picture) {
      // Cover-cropped and centred, as FFmpeg's scale (increase) + crop.
      const scale = Math.max(w / picture.naturalWidth, h / picture.naturalHeight), sw = w / scale, sh = h / scale;
      ctx.drawImage(picture, (picture.naturalWidth - sw) / 2, (picture.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
    } else {
      const g = ctx.createLinearGradient(x, y, x + w, y + h);
      g.addColorStop(0, pending ? "#4b3a8c" : "#d7dae0");
      g.addColorStop(1, pending ? "#1e2433" : "#eceef1");
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      if (pending) {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.font = `600 ${Math.round(l.width * 0.034)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText("AI picture, made when you save", x + w / 2, y + Math.min(h / 2, l.width * 0.3));
      }
    }
    ctx.restore();
  }
  drawItems(ctx, l.items, 0);
  if (l.logo && logo) {
    // Fitted inside its box and centred, as FFmpeg's scale (decrease) + overlay.
    const { x, y, w, h } = whole(l.logo), scale = Math.min(w / logo.naturalWidth, h / logo.naturalHeight);
    const dw = Math.round(logo.naturalWidth * scale), dh = Math.round(logo.naturalHeight * scale);
    ctx.drawImage(logo, x + Math.floor((w - dw) / 2), y + Math.floor((h - dh) / 2), dw, dh);
  }
}

/** What a slide says, for screen readers (the canvas itself is a picture). */
export function slideText(spec: CarouselInput, index: number) {
  const s = spec.slides[index];
  return [`Slide ${index + 1} of ${spec.slides.length}`, s.label, s.title, s.body].filter(Boolean).join(". ");
}

/** One slide on a canvas, redrawn when the slide, its pictures, the fonts or the canvas size change. */
export function SlideCanvas({ spec, index, className = "cr-canvas" }: { spec: CarouselInput; index: number; className?: string }) {
  const slide = spec.slides[index];
  const image = slide?.image as { assetId?: string; prompt?: string } | undefined;
  const picture = useImage(image?.assetId ? fileUrl(image.assetId) : null);
  const logo = useImage(spec.brand.logoId ? fileUrl(spec.brand.logoId) : null);
  const layout = useMemo(() => (slide ? carouselSlide(spec, index, { picture: !!image, logo: logo ? logo.naturalWidth / logo.naturalHeight : null }) : null), [spec, index, slide, image, logo]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    loadCaptionFonts();
    let live = true;
    void document.fonts?.ready.then(() => { if (live) setTick((n) => n + 1); });
    const c = canvas.current;
    const observer = typeof ResizeObserver !== "undefined" && c ? new ResizeObserver(() => setTick((n) => n + 1)) : null;
    if (c) observer?.observe(c);
    return () => { live = false; observer?.disconnect(); };
  }, []);
  useEffect(() => {
    const c = canvas.current, ctx = c?.getContext("2d");
    if (!c || !ctx || !layout) return;
    const k = fitCanvas(c, layout.width, layout.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    paintSlide(ctx, layout, picture, logo, !!image?.prompt && !image.assetId);
  }, [layout, picture, logo, image, tick]);
  if (!layout) return null;
  return <canvas ref={canvas} className={className} role="img" aria-label={slideText(spec, index)} style={{ aspectRatio: `${layout.width} / ${layout.height}` }} />;
}
