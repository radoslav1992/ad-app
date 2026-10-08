import { useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { captionPresets, demoWords, type CaptionDocument, type CaptionStyle } from "../../shared/captions";
import { overlayItems, textAnimationInfo, textAnimations, type TextAnimation, type TextLook } from "../../shared/overlay";
import { drawCaptions, drawItems, fitCanvas, loadCaptionFonts, onFrame, reducedMotion } from "./caption-canvas";

// Pickers with live samples: the twenty caption styles (spoken captions of AI UGC, subtitles of uploads) and the
// entrance animations of on-screen text. Each sample is drawn by the same code as the preview and the render.

/** A small canvas that redraws `draw(ctx, t)` on a `period`-second loop while it is on screen (still with reduced motion). */
function LoopCanvas({ width, height, period, stillAt, draw }: {
  width: number; height: number; period: number; stillAt: number; draw: (ctx: CanvasRenderingContext2D, t: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(draw);
  useEffect(() => { latest.current = draw; });
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    loadCaptionFonts();
    const paint = (t: number) => {
      const k = fitCanvas(c, width, height), ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      latest.current(ctx, t);
    };
    // A still moment first (also for tiles not yet scrolled to, and again once the fonts are in), then the loop
    // while the sample is on screen, unless less motion was asked for.
    let stop: (() => void) | null = null;
    paint(stillAt);
    void document.fonts?.ready.then(() => { if (!stop) paint(stillAt); });
    if (reducedMotion() || typeof IntersectionObserver === "undefined") return;
    const begun = performance.now();
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !stop) stop = onFrame((now) => paint(((now - begun) / 1000) % period));
      else if (!entry.isIntersecting && stop) { stop(); stop = null; }
    });
    observer.observe(c);
    return () => { observer.disconnect(); stop?.(); };
  }, [width, height, period, stillAt]);
  return <canvas ref={canvas} className="loop-canvas" aria-hidden="true" />;
}

/** Radio-group keys: arrows move (and choose), Home/End jump; the chosen option is the one tab stop. */
function useRadioKeys<T>(options: readonly T[], value: T, onChange: (v: T) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const n = options.length;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n
      : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(options[next]);
    refs.current[next]?.focus();
  };
  const props = (option: T, i: number) => ({
    ref: (el: HTMLButtonElement | null) => { refs.current[i] = el; },
    role: "radio" as const, "aria-checked": option === value, tabIndex: option === value ? 0 : -1,
    onClick: () => onChange(option), onKeyDown: (e: ReactKeyboardEvent) => onKey(e, i),
  });
  return props;
}

const SAMPLE_W = 480, SAMPLE_H = 300;
/** A caption style on the sample sentence ("Stop scrolling. This changes everything."), looping. */
function StyleSample({ style }: { style: CaptionStyle }) {
  const document = useMemo<CaptionDocument>(() => {
    const preset = captionPresets.find((p) => p.id === style)!;
    return { words: demoWords, style, format: "9:16", position: "middle", enabled: true, accent: preset.accent, uppercase: preset.uppercase, size: 2.1 };
  }, [style]);
  return <LoopCanvas width={SAMPLE_W} height={SAMPLE_H} period={3.4} stillAt={0.85} draw={(ctx, t) => drawCaptions(ctx, SAMPLE_W, SAMPLE_H, t, document)} />;
}

/** The twenty caption styles, each a live sample with its name and what it does. */
export function CaptionStylePicker({ value, onChange, label = "Caption style" }: { value: CaptionStyle; onChange: (style: CaptionStyle) => void; label?: string }) {
  const ids = useMemo(() => captionPresets.map((p) => p.id), []);
  const radio = useRadioKeys(ids, value, onChange);
  return (
    <div className="style-grid" role="radiogroup" aria-label={label}>
      {captionPresets.map((p, i) => (
        <button key={p.id} type="button" className="style-tile" {...radio(p.id, i)} aria-label={`${p.name}: ${p.description}`}>
          <StyleSample style={p.id} />
          <span className="style-name">{p.name}</span>
          <span className="style-about">{p.description}</span>
        </button>
      ))}
    </div>
  );
}

const ANIM_W = 200, ANIM_H = 120;
/** An entrance animation on a short two-line sample, in the look being edited (as large as the tile allows). */
function AnimationSample({ animation, look }: { animation: TextAnimation; look: TextLook }) {
  const items = useMemo(() => overlayItems("Stop\nscrolling", { ...look, animation, size: 5, position: "center" }, ANIM_W, ANIM_H, { start: 0.2, end: 2.2 }), [animation, look]);
  return <LoopCanvas width={ANIM_W} height={ANIM_H} period={2.4} stillAt={2} draw={(ctx, t) => drawItems(ctx, items, t)} />;
}

/** The entrance animations of on-screen text, each a live sample in the current look. */
export function TextAnimationPicker({ look, onChange }: { look: TextLook; onChange: (animation: TextAnimation) => void }) {
  const radio = useRadioKeys(textAnimations, look.animation, onChange);
  return (
    <div className="anim-grid" role="radiogroup" aria-label="Text animation">
      {textAnimations.map((a, i) => (
        <button key={a} type="button" className="anim-tile" {...radio(a, i)} aria-label={`${textAnimationInfo[a].name}: ${textAnimationInfo[a].description}`} title={textAnimationInfo[a].description}>
          <AnimationSample animation={a} look={look} />
          <span>{textAnimationInfo[a].name}</span>
        </button>
      ))}
    </div>
  );
}

/** A titled block of the editor with an optional control on the right (a switch). */
export function EditorSection({ title, hint, action, children }: { title: string; hint?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="editor-section" aria-label={title}>
      <div className="row between">
        <div>
          <h2 className="section-title">{title}</h2>
          {hint && <p className="muted small">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
