import type { CaptionDocument } from "../../shared/captions";
import { animState, captionTimeline, type CaptionInterval, type CaptionItem, type CaptionText } from "../../shared/caption-scene";
import { BASELINE, CAPTION_FAMILIES } from "../../shared/caption-fonts";

// Draws caption items (shared/caption-scene.ts: spoken captions; shared/overlay.ts: on-screen text) on a canvas with
// the renderer's fonts (public/fonts, the files libass burns in) and the same keyframes, so the editor's preview moves
// like the finished video. Ported from rech-bg's caption renderer.

let fontsRequested = false;
/** The caption fonts; drawing falls back to Arial until they load (`fontsReady` resolves when they have). */
export function loadCaptionFonts() {
  if (fontsRequested || typeof document === "undefined" || !document.fonts) return;
  fontsRequested = true;
  for (const f of Object.values(CAPTION_FAMILIES)) void document.fonts.load(`${f.italic ? "italic " : ""}${f.weight} 40px "${f.family}"`).catch(() => {});
}
const fontString = (font: CaptionText["font"], size: number) => {
  const f = CAPTION_FAMILIES[font];
  return `${f.italic ? "italic " : ""}${f.weight} ${size}px "${f.family}", Arial, sans-serif`;
};
const hasFilter = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;
/** The same rounded rectangle the server draws (corner curves with both control points on the corner). */
function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.bezierCurveTo(x + w, y, x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r);
  ctx.bezierCurveTo(x + w, y + h, x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h);
  ctx.bezierCurveTo(x, y + h, x, y + h, x, y + h - r); ctx.lineTo(x, y + r);
  ctx.bezierCurveTo(x, y, x, y, x + r, y); ctx.closePath();
}
let scratch: HTMLCanvasElement | null = null;
/** Letters with only their border (hollow): stroked, then the inside cut out, on a scratch canvas. */
function hollowText(ctx: CanvasRenderingContext2D, item: CaptionText, border: NonNullable<CaptionText["border"]>) {
  const font = fontString(item.font, item.size), pad = Math.ceil(border.width * 2 + item.size * 0.2);
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(item.text).width + pad * 2), h = Math.ceil(item.size * 1.6 + pad * 2);
  scratch ??= document.createElement("canvas");
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  const s = scratch.getContext("2d")!;
  s.clearRect(0, 0, scratch.width, scratch.height);
  s.font = font; s.textAlign = "center"; s.textBaseline = "alphabetic"; s.lineJoin = "round";
  s.lineWidth = border.width * 2; s.strokeStyle = border.color;
  const bx = w / 2, by = h / 2 + item.size * BASELINE;
  s.strokeText(item.text, bx, by);
  s.globalCompositeOperation = "destination-out"; s.fillText(item.text, bx, by); s.globalCompositeOperation = "source-over";
  ctx.globalAlpha *= border.alpha ?? 1;
  ctx.drawImage(scratch, 0, 0, w, h, -w / 2, -h / 2, w, h);
}
/** One item at `time` (seconds on the clock its keyframes use). */
export function drawCaptionItem(ctx: CanvasRenderingContext2D, item: CaptionItem, time: number) {
  const a = animState(item, time), alpha = (item.alpha ?? 1) * a.alpha;
  if (alpha <= 0.002) return;
  ctx.save();
  ctx.translate(item.x + a.dx, item.y + a.dy);
  if (item.rotate) ctx.rotate(item.rotate);
  ctx.scale(a.scale * a.sx, a.scale);
  ctx.globalAlpha = alpha;
  if (item.blur) {
    if (hasFilter) ctx.filter = `blur(${item.blur * a.scale}px)`;
    else ctx.globalAlpha *= 0.6;
  }
  if (item.kind === "box") {
    ctx.fillStyle = item.color;
    roundedPath(ctx, item.fromLeft ? 0 : -item.w / 2, -item.h / 2, item.w, item.h, item.radius); ctx.fill();
  } else if (item.kind === "tail") {
    ctx.fillStyle = item.color; ctx.beginPath();
    item.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath(); ctx.fill();
  } else if (item.fill === null) {
    if (item.border) hollowText(ctx, item, item.border);
  } else {
    ctx.font = fontString(item.font, item.size); ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.lineJoin = "round";
    const y = item.size * BASELINE;
    if (item.border) {
      ctx.save(); ctx.globalAlpha *= item.border.alpha ?? 1;
      ctx.lineWidth = item.border.width * 2; ctx.strokeStyle = item.border.color; ctx.strokeText(item.text, 0, y);
      ctx.restore();
    }
    ctx.globalAlpha *= item.fillAlpha ?? 1; ctx.fillStyle = item.fill; ctx.fillText(item.text, 0, y);
  }
  ctx.restore();
}
/** Items in draw order (lower layers first), at `time`. */
export function drawItems(ctx: CanvasRenderingContext2D, items: CaptionItem[], time: number) {
  loadCaptionFonts();
  for (const item of [...items].sort((a, b) => a.layer - b.layer)) drawCaptionItem(ctx, item, time);
}

// Timelines are cached per document object and frame size: keep the document object stable between frames.
const timelines = new WeakMap<CaptionDocument, Map<string, CaptionInterval[]>>();
function timelineOf(document: CaptionDocument, width: number, height: number) {
  let byFrame = timelines.get(document);
  if (!byFrame) { byFrame = new Map(); timelines.set(document, byFrame); }
  const key = `${width}x${height}`;
  let timeline = byFrame.get(key);
  if (!timeline) { timeline = captionTimeline(document, width, height); byFrame.set(key, timeline); }
  return timeline;
}
/** The captions of `document` at `time` (seconds on its words' clock), laid out for a width × height frame. */
export function drawCaptions(ctx: CanvasRenderingContext2D, width: number, height: number, time: number, document: CaptionDocument) {
  if (!document.enabled) return;
  const timeline = timelineOf(document, width, height);
  // Binary search for the interval at `time`.
  let lo = 0, hi = timeline.length - 1, found: CaptionInterval | null = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, interval = timeline[m];
    if (time < interval.start) hi = m - 1;
    else if (time >= interval.end) lo = m + 1;
    else { found = interval; break; }
  }
  if (found) drawItems(ctx, found.items, time);
}

/** Whether the person asked for less motion: previews then show a still moment instead of looping. */
export const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// One animation frame loop for every live preview on the page (the caption style grid has twenty).
const painters = new Set<(now: number) => void>();
let frame = 0;
function tick(now: number) {
  for (const paint of painters) paint(now);
  frame = painters.size ? requestAnimationFrame(tick) : 0;
}
/** Calls `paint` on every animation frame until the returned function is called. */
export function onFrame(paint: (now: number) => void) {
  painters.add(paint);
  if (!frame) frame = requestAnimationFrame(tick);
  return () => { painters.delete(paint); };
}
/** Sizes a canvas to its box at the screen's pixel density; returns the scale from `frameWidth` units to pixels. */
export function fitCanvas(canvas: HTMLCanvasElement, frameWidth: number, frameHeight: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round((canvas.clientWidth || frameWidth) * dpr)), h = Math.max(1, Math.round(w * frameHeight / frameWidth));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return w / frameWidth;
}
