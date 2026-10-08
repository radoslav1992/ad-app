import { captionGroups, captionPresets, readableOn, type CaptionDocument, type CaptionStyle, type CaptionWord } from "./captions";
import { BASELINE, textWidth, type CaptionFont } from "./caption-fonts";
import { anchor, LAYER_MARGIN, type TextLayer } from "./layers";

// One description of what the captions show, used by both the browser preview (canvas) and the server render
// (ASS subtitles burned in by FFmpeg/libass): the same layout, sizes, colours and animations, so the export looks
// like the preview. Time is cut into intervals in which the shown words and their state do not change; inside an
// interval only keyframed animations move (linear between keyframes, which ASS can express with \move and \t).

/** Linear keyframes on the video clock; values hold before the first and after the last. */
export type Keyframe = { t: number; dx?: number; dy?: number; scale?: number; sx?: number; alpha?: number };
type Base = {
  /** Draw order: lower first. */
  layer: number;
  /** Anchor: the centre (text, box) or the left middle (`fromLeft` boxes). */
  x: number; y: number;
  /** Clockwise, in radians, around the anchor. */
  rotate?: number;
  alpha?: number;
  anim?: Keyframe[];
};
export type CaptionText = Base & {
  kind: "text"; text: string; font: CaptionFont; size: number;
  /** Null: hollow letters (only the border shows). */
  fill: string | null; fillAlpha?: number;
  /** Drawn outside the letters, `width` px wide. */
  border?: { color: string; width: number; alpha?: number };
  /** Gaussian blur (sigma, px) of the whole item: shadows and glows. */
  blur?: number;
};
export type CaptionBox = Base & {
  kind: "box"; w: number; h: number; radius: number; color: string; blur?: number; fromLeft?: boolean;
};
/** A filled triangle (the bubble's tail), in absolute coordinates. */
export type CaptionTail = Base & { kind: "tail"; points: [number, number][]; color: string; blur?: number };
export type CaptionItem = CaptionText | CaptionBox | CaptionTail;
export type CaptionInterval = { start: number; end: number; items: CaptionItem[] };

const DARK = "#121612", SHADOW = "#000000";
const fontOf = (style: CaptionStyle): CaptionFont => style === "luxe" ? "serif" : "sans";
const sizeFactor = (style: CaptionStyle) => style === "minimal" ? .045 : style === "pop" || style === "impact" ? .09 : style === "luxe" ? .07 : .065;
/** Vertical centre of the caption block: top, middle or the lower part of the frame. */
export const captionCenter = (position: CaptionDocument["position"], height: number) =>
  height * (position === "top" ? .2 : position === "middle" ? .5 : .79);

export type CaptionLayout = {
  size: number; lineHeight: number;
  lines: { y: number; left: number; width: number; words: { word: CaptionWord; text: string; x: number; width: number; n: number }[] }[];
};
/** Wraps into at most two lines inside the frame, shrinking the text when needed (the same as the preview always did). */
export function layoutCaption(words: CaptionWord[], document: CaptionDocument, width: number, height: number): CaptionLayout {
  const style = document.style, font = fontOf(style);
  const texts = words.map((w) => document.uppercase ? w.text.toLocaleUpperCase("en") : w.text);
  const maxWidth = width * (style === "bubble" || style === "tiles" ? .78 : .84);
  let size = Math.round(Math.min(width, height) * sizeFactor(style) * (document.size || 1));
  let lines: number[][] = [];
  const gap = () => style === "tiles" ? size * .24 : 0;
  const lineWidth = (line: number[]) =>
    line.reduce((sum, i) => sum + textWidth(texts[i], size, font), 0) + (textWidth(" ", size, font) + gap()) * Math.max(0, line.length - 1);
  do {
    lines = [[]];
    texts.forEach((_, i) => {
      const line = lines.at(-1)!;
      if (line.length && lineWidth([...line, i]) > maxWidth) lines.push([i]);
      else line.push(i);
    });
    if (lines.length <= 2 && lines.every((l) => lineWidth(l) <= maxWidth)) break;
    size -= 1;
  } while (size > 10);
  const lineHeight = size * (style === "tiles" ? 1.6 : 1.4);
  const top = captionCenter(document.position, height) - (lines.length - 1) / 2 * lineHeight;
  let n = 0;
  return {
    size, lineHeight,
    lines: lines.map((line, index) => {
      const total = lineWidth(line), left = (width - total) / 2;
      let x = left;
      return {
        y: top + index * lineHeight, left, width: total,
        words: line.map((i) => {
          const w = textWidth(texts[i], size, font), placed = { word: words[i], text: texts[i], x, width: w, n: n++ };
          x += w + textWidth(" ", size, font) + gap();
          return placed;
        }),
      };
    }),
  };
}

/** Times inside [from, to) on a 0.1 s grid, with both ends: keyframes for continuous motion. */
function grid(from: number, to: number) {
  const out = [from];
  for (let t = Math.ceil(from * 10 + 1e-6) / 10; t < to - 1e-6; t = Math.round(t * 10 + 1) / 10) out.push(t);
  out.push(to);
  return out;
}

/** What the captions of one group show while the spoken word (and the shown words) stay the same. */
function groupItems(group: CaptionWord[], document: CaptionDocument, width: number, height: number, from: number, to: number): CaptionItem[] {
  const style = document.style, accent = document.accent || captionPresets.find((p) => p.id === style)!.accent;
  const textColor = document.textColor || "#ffffff", onAccent = readableOn(accent), font = fontOf(style);
  const mid = (from + to) / 2;
  const active = (w: CaptionWord) => mid >= w.start && mid < w.end;
  const shown = style === "pop" || style === "impact" ? group.filter(active) : style === "typewriter" ? group.filter((w) => mid >= w.start) : group;
  if (!shown.length) return [];
  const layout = layoutCaption(shown, document, width, height), s = layout.size;
  const items: CaptionItem[] = [];
  const text = (o: Omit<CaptionText, "kind" | "font" | "size"> & { size?: number }): CaptionText => ({ kind: "text", font, size: s, ...o });
  const lines = layout.lines;
  // Backgrounds behind whole lines.
  if (style === "banner") {
    const top = lines[0].y - s * .78, h = (lines.length - 1) * layout.lineHeight + s * 1.56;
    items.push({ kind: "box", layer: 0, x: width / 2, y: top + h / 2, w: width, h, radius: 0, color: accent });
  }
  if (style === "bubble") {
    const wide = Math.max(...lines.map((l) => l.width)), top = lines[0].y - s * .8, bottom = lines.at(-1)!.y + s * .8;
    const box = { layer: 0, x: width / 2, y: (top + bottom) / 2, w: wide + s, h: bottom - top, radius: s * .45, color: "#ffffff" };
    const tail: [number, number][] = [[width / 2 - s * .35, bottom - 1], [width / 2 - s * .55, bottom + s * .45], [width / 2 + s * .2, bottom - 1]];
    items.push({ kind: "box", ...box, layer: 0, y: box.y + s * .08, color: SHADOW, alpha: .35, blur: s * .15 });
    items.push({ kind: "tail", layer: 0, x: 0, y: s * .08, points: tail, color: SHADOW, alpha: .35, blur: s * .15 });
    items.push({ kind: "box", ...box, layer: 1 });
    items.push({ kind: "tail", layer: 1, x: 0, y: 0, points: tail, color: "#ffffff" });
  }
  if (style === "classic" || style === "typewriter")
    for (const line of lines) items.push({ kind: "box", layer: 0, x: width / 2, y: line.y, w: line.width + s * .6, h: s * 1.36, radius: s * .16, color: "#0f1410", alpha: .85 });

  for (const line of lines) for (const placed of line.words) {
    const { word } = placed, selected = active(word), cx = placed.x + placed.width / 2, y = line.y, w = placed.width;
    if (style === "fade" && mid < word.start) continue;
    let fill = textColor;
    if (selected && ["karaoke", "pop", "neon", "bounce", "wave", "luxe", "fade"].includes(style)) fill = accent;
    // Motion of this word while the interval lasts.
    let anim: Keyframe[] | undefined, rotate = 0;
    if ((style === "pop" || style === "impact") && word.start < to) anim = [{ t: word.start, scale: 1.1 }, { t: word.start + .12, scale: 1 }];
    if (style === "bounce" && selected) {
      const lift = (p: number) => -s * (Math.sin(Math.min(1, p) * Math.PI) * .2 + .05);
      anim = [0, .25, .5, .75, 1].map((p) => ({ t: word.start + p * .18, dy: lift(p), scale: 1.05 }));
    }
    if (style === "wave") anim = grid(from, to).map((t) => ({ t, dy: Math.sin(t * 5 - placed.n * .9) * s * .09 }));
    if (style === "fade") anim = [{ t: word.start, alpha: 0, dy: s * .3 }, { t: word.start + .25, alpha: 1, dy: 0 }];
    if (style === "impact") rotate = -.06;
    if (style === "sticker" && selected) { rotate = -.07; anim = [{ t: from, scale: 1.06 }]; }
    const at = { x: cx, y, rotate, anim };

    if (style === "highlight" && selected) {
      items.push({ kind: "box", layer: 0, ...at, w: w + s * .2, h: s * 1.3, radius: s * .12, color: accent });
      items.push(text({ layer: 2, ...at, text: placed.text, fill: onAccent }));
    } else if (style === "banner") {
      items.push(text({ layer: 2, ...at, text: placed.text, fill: onAccent, fillAlpha: selected ? 1 : .55 }));
    } else if (style === "bubble") {
      items.push(text({ layer: 2, ...at, text: placed.text, fill: selected ? accent : "#111611" }));
    } else if (style === "tiles" || style === "impact") {
      const tile = { ...at, w: w + s * .28, h: s * 1.4, radius: s * .18 };
      items.push({ kind: "box", layer: 0, ...tile, y: y + s * .06, color: SHADOW, alpha: .35, blur: s * .1 });
      items.push({ kind: "box", layer: 1, ...tile, color: selected ? accent : "#0f1410", alpha: selected ? 1 : .85 });
      items.push(text({ layer: 2, ...at, text: placed.text, fill: selected ? onAccent : textColor }));
    } else if (style === "sticker") {
      items.push(text({ layer: 1, ...at, y: y + s * .06, text: placed.text, fill: SHADOW, fillAlpha: .45, border: { color: SHADOW, width: s * .16, alpha: .45 }, blur: s * .075 }));
      items.push(text({ layer: 2, ...at, text: placed.text, fill: selected ? accent : DARK, border: { color: "#ffffff", width: s * .16 } }));
    } else if (style === "luxe") {
      items.push(text({ layer: 1, ...at, y: y + s * .04, text: placed.text, fill: SHADOW, fillAlpha: .8, blur: s * .175 }));
      items.push(text({ layer: 2, ...at, text: placed.text, fill, border: { color: "#0a0c0a", width: s * .035, alpha: .7 } }));
    } else if (style === "outline") {
      // Hollow letters; the spoken word fills with the accent colour.
      items.push(text({ layer: 1, ...at, text: placed.text, fill: null, border: { color: SHADOW, width: s * .08 }, blur: s * .06 }));
      items.push(text({ layer: 2, ...at, text: placed.text, fill: selected ? accent : null, border: { color: DARK, width: s * .08 } }));
      if (!selected) items.push(text({ layer: 3, ...at, text: placed.text, fill: null, border: { color: textColor, width: s * .035 } }));
    } else if (style === "retro") {
      const offset = s * (selected ? .1 : .07);
      items.push(text({ layer: 1, ...at, x: cx + offset, y: y + offset, text: placed.text, fill: selected ? DARK : accent }));
      items.push(text({ layer: 2, ...at, text: placed.text, fill: selected ? accent : textColor, border: { color: DARK, width: s * .03 } }));
    } else if (style === "classic" || style === "typewriter") {
      items.push(text({ layer: 2, ...at, text: placed.text, fill: textColor }));
    } else {
      // Bold, karaoke, pop, minimal, neon, bounce, wave, fade, underline, highlight (other words).
      const glow = style === "neon" && selected;
      const border = style === "minimal" ? undefined : { color: DARK, width: s * .06 };
      items.push(text({ layer: 1, ...at, y: y + s * .03, text: placed.text, fill: glow ? accent : SHADOW, border: border && { ...border, color: glow ? accent : SHADOW }, blur: glow ? s * .225 : s * .05 }));
      items.push(text({ layer: 2, ...at, text: placed.text, fill, border }));
    }
    if (style === "underline" && selected) {
      const full = Math.max(s * .3, w), grow = Math.max(.05, word.end - word.start) / 2.5;
      items.push({ kind: "box", layer: 3, x: placed.x, y: y + s * .59, w: full, h: s * .18, radius: s * .09, color: accent, fromLeft: true,
        anim: [{ t: word.start, sx: Math.min(1, s * .3 / full) }, { t: word.start + grow, sx: 1 }] });
    }
  }
  return items;
}

/** Every interval of the captions on the document's own clock (0 = the start of its recording). */
export function captionTimeline(document: CaptionDocument, width: number, height: number): CaptionInterval[] {
  if (!document.enabled) return [];
  const out: CaptionInterval[] = [];
  for (const group of captionGroups(document.words)) {
    const start = group[0].start, end = group.at(-1)!.end;
    const cuts = [...new Set([start, end, ...group.flatMap((w) => [w.start, w.end])])].filter((t) => t >= start && t <= end).sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      if (cuts[i + 1] - cuts[i] < .005) continue;
      const items = groupItems(group, document, width, height, cuts[i], cuts[i + 1]);
      if (items.length) out.push({ start: cuts[i], end: cuts[i + 1], items });
    }
  }
  return out;
}

/** The animated state of an item at `t`: offsets, scale, horizontal scale and opacity. */
export function animState(item: CaptionItem, t: number) {
  const k = item.anim;
  const base = { dx: 0, dy: 0, scale: 1, sx: 1, alpha: 1 };
  if (!k?.length) return base;
  const value = (key: keyof Omit<Keyframe, "t">) => {
    const frames = k.filter((f) => f[key] !== undefined);
    if (!frames.length) return base[key];
    if (t <= frames[0].t) return frames[0][key]!;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1], b = frames[i];
      if (t <= b.t) return a[key]! + (b[key]! - a[key]!) * ((t - a.t) / Math.max(1e-6, b.t - a.t));
    }
    return frames.at(-1)![key]!;
  };
  return { dx: value("dx"), dy: value("dy"), scale: value("scale"), sx: value("sx"), alpha: value("alpha") };
}

/**
 * A text layer (title, lower third) as caption items: one text per line and its optional box, placed with the
 * shared letter widths so the preview and the render wrap and align it alike.
 */
export function textLayerItems(layer: TextLayer, W: number, H: number): CaptionItem[] {
  const size = layer.size * H, font: CaptionFont = layer.bold ? "sans" : "regular", lines = layer.text.split(/\r?\n/);
  const widths = lines.map((l) => textWidth(l, size, font)), lineHeight = size * 1.2;
  const blockW = Math.max(...widths), blockH = lineHeight * lines.length;
  const [ax, ay] = anchor(layer.position);
  const px = W * LAYER_MARGIN + ax * W * (1 - 2 * LAYER_MARGIN), py = H * LAYER_MARGIN + ay * H * (1 - 2 * LAYER_MARGIN);
  const left = px - ax * blockW, top = py - ay * blockH;
  const items: CaptionItem[] = [];
  if (layer.box) {
    const pad = size * .3;
    items.push({ kind: "box", layer: 0, x: left + blockW / 2, y: top + blockH / 2, w: blockW + pad * 2, h: blockH + pad * 2, radius: 0, color: layer.box });
  }
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    // Baseline at 0.95 em below the line's top, as titles always were.
    items.push({ kind: "text", layer: 1, font, size, text: line, fill: layer.color,
      x: left + ax * (blockW - widths[i]) + widths[i] / 2, y: top + lineHeight * i + size * (.95 - BASELINE),
      border: layer.box ? undefined : { color: "#000000", width: Math.max(.5, size * .06) } });
  });
  return items;
}
