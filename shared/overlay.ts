import { z } from "zod";
import type { CaptionItem, Keyframe } from "./caption-scene";
import { textWidth, type CaptionFont } from "./caption-fonts";

// On-screen text of short-form posts: the hook over a video, the words on a slide. One layout, measured with the
// renderer's own font metrics (shared/caption-fonts.ts), becomes caption items that server/caption-ass.ts burns in
// with libass; the editor draws the same items on a canvas (src/app/caption-canvas.ts), entrance animation included.

const hex = z.string().regex(/^#[0-9a-f]{6}$/i);
/** How a text block enters, from its start (each slide's start in a slideshow). All but "words" are over within 0.6 s. */
export const textAnimations = ["none", "fade", "pop", "rise", "words"] as const;
export type TextAnimation = (typeof textAnimations)[number];
export const textAnimationInfo: Record<TextAnimation, { name: string; description: string }> = {
  none: { name: "None", description: "On screen from the start" },
  fade: { name: "Fade", description: "Fades in softly" },
  pop: { name: "Pop", description: "Pops in with a small bounce" },
  rise: { name: "Rise", description: "Slides up, line by line" },
  words: { name: "Words", description: "Appears word by word" },
};
/** How a text looks: the controls of the editor's Text panel. */
export const textLookSchema = z.object({
  weight: z.enum(["regular", "bold"]).default("bold"),
  /** Relative size (1 = the default for the frame). */
  size: z.number().min(0.5).max(1.8).default(1),
  color: hex.default("#ffffff"),
  /** Outline width in pixels at 1080 wide (0 = none). */
  stroke: z.number().min(0).max(12).default(4),
  strokeColor: hex.default("#000000"),
  /** A rounded box behind each line, or none. */
  background: hex.nullable().default(null),
  position: z.enum(["top", "center", "bottom"]).default("center"),
  /** Entrance animation; posts made before it existed have none. */
  animation: z.enum(textAnimations).default("none"),
});
export type TextLook = z.infer<typeof textLookSchema>;
export type TextPosition = TextLook["position"];
/** Ready-made looks the writer and the editor offer. */
export const textPresets: Record<string, { name: string; look: TextLook }> = {
  classic: { name: "Classic", look: { weight: "bold", size: 1, color: "#ffffff", stroke: 4, strokeColor: "#000000", background: null, position: "center", animation: "none" } },
  box: { name: "Text box", look: { weight: "bold", size: 1, color: "#000000", stroke: 0, strokeColor: "#ffffff", background: "#ffffff", position: "center", animation: "none" } },
  quiet: { name: "Quiet", look: { weight: "regular", size: 0.85, color: "#ffffff", stroke: 3, strokeColor: "#000000", background: null, position: "center", animation: "none" } },
  loud: { name: "Loud", look: { weight: "bold", size: 1.3, color: "#ffe14d", stroke: 6, strokeColor: "#000000", background: null, position: "center", animation: "none" } },
};
export const defaultLook = (): TextLook => ({ ...textPresets.classic.look });

/** Letters the renderer's fonts cannot draw (emoji, pictographs) are removed from on-screen text. */
export function screenText(text: string) {
  return text
    .replace(/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\u{FE0F}|\u{200D}/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
const fontOf = (look: TextLook): CaptionFont => (look.weight === "bold" ? "sans" : "regular");
/** Vertical centre of the text block for a position. */
const centreY = (position: TextPosition, H: number) => H * (position === "top" ? 0.24 : position === "center" ? 0.5 : 0.74);

/** Breaks text into lines no wider than `max` at `size`, keeping the author's line breaks. */
export function wrapLines(text: string, size: number, max: number, font: CaptionFont) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ").filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, size, font) > max) { lines.push(line); line = word; }
      else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

export type OverlayLayout = { size: number; lineHeight: number; lines: { text: string; width: number; y: number }[] };
/**
 * Fits the text inside 82% of the frame width and 70% of its height, shrinking from the look's size when needed
 * (a "wall of text" gets smaller letters; a short hook stays big).
 */
export function layoutOverlay(text: string, look: TextLook, W: number, H: number): OverlayLayout {
  const clean = screenText(text), font = fontOf(look);
  const max = W * 0.82;
  const lineFactor = look.background ? 1.42 : 1.3;
  let size = Math.round(W * 0.052 * look.size);
  let lines = wrapLines(clean, size, max, font);
  while (size > 16 && (lines.length * size * lineFactor > H * 0.7 || lines.some((l) => textWidth(l, size, font) > max))) {
    size -= 1;
    lines = wrapLines(clean, size, max, font);
  }
  const lineHeight = size * lineFactor;
  const top = centreY(look.position, H) - ((lines.length - 1) / 2) * lineHeight;
  return { size, lineHeight, lines: lines.map((t, i) => ({ text: t, width: textWidth(t, size, font), y: top + i * lineHeight })) };
}

/** When a text block is on screen (seconds on the video clock). */
export type TextTiming = { start: number; end: number };
const LINE_ENTRANCE = 0.4, WORD_ENTRANCE = 0.25;
/** Delay between lines: the last line starts at most 0.2 s after the first, so every entrance ends within 0.6 s. */
const lineStagger = (lines: number) => (lines > 1 ? Math.min(0.08, 0.2 / (lines - 1)) : 0);
/**
 * Delay between words of a word-by-word reveal, paced to the text: about 0.18 s a word for a short hook, quicker for
 * a wall of text, so that every word is on screen by 40% of the block (and 6 s at the latest).
 */
export function wordStep(words: number, seconds: number) {
  if (words <= 1) return 0;
  return Math.max(0.03, Math.min(0.18, (Math.min(6, seconds * 0.4) - WORD_ENTRANCE) / (words - 1)));
}
const wordsOf = (line: string) => line.split(" ").filter(Boolean);
/** Seconds after the block's start when all of it is fully on screen (0 without an animation). */
export function revealSeconds(text: string, look: TextLook, W: number, H: number, seconds: number) {
  const layout = layoutOverlay(text, look, W, H), n = layout.lines.length;
  if (!n || look.animation === "none") return 0;
  if (look.animation === "words") {
    const count = layout.lines.reduce((sum, l) => sum + wordsOf(l.text).length, 0);
    return (count - 1) * wordStep(count, seconds) + WORD_ENTRANCE;
  }
  return (n - 1) * lineStagger(n) + (look.animation === "pop" ? 0.36 : LINE_ENTRANCE);
}
/** Keyframes of one line (or word) entering at `t`; `s` is the letter size. Linear between keyframes, as in ASS. */
function entrance(animation: TextAnimation, t: number, s: number): Keyframe[] | undefined {
  switch (animation) {
    case "fade": return [{ t, alpha: 0 }, { t: t + LINE_ENTRANCE, alpha: 1 }];
    // Grows past its size and settles: 0.36 s.
    case "pop": return [{ t, alpha: 0, scale: 0.7 }, { t: t + 0.12, alpha: 1 }, { t: t + 0.24, scale: 1.06 }, { t: t + 0.36, scale: 1 }];
    // Eases out: three quarters of the way up at half time.
    case "rise": return [{ t, alpha: 0, dy: s * 0.6 }, { t: t + LINE_ENTRANCE / 2, alpha: 0.85, dy: s * 0.15 }, { t: t + LINE_ENTRANCE, alpha: 1, dy: 0 }];
    case "words": return [{ t, alpha: 0, dy: s * 0.25 }, { t: t + WORD_ENTRANCE, alpha: 1, dy: 0 }];
    default: return undefined;
  }
}

/**
 * The caption items that draw `text` with a look (boxes first, then letters with their outline). With `timing`, the
 * look's animation is added as keyframes on the video clock; without it (or with "none") the text is static. A
 * word-by-word reveal draws each word on its own, at its place in the same wrapped lines.
 */
export function overlayItems(text: string, look: TextLook, W: number, H: number, timing?: TextTiming): CaptionItem[] {
  const layout = layoutOverlay(text, look, W, H), s = layout.size, font = fontOf(look);
  const stroke = (look.stroke * W) / 1080;
  const animation = timing ? look.animation : "none";
  const border = stroke > 0 ? { border: { color: look.strokeColor, width: stroke } } : {};
  const items: CaptionItem[] = [];
  const count = layout.lines.reduce((sum, l) => sum + wordsOf(l.text).length, 0);
  const step = animation === "words" ? wordStep(count, timing!.end - timing!.start) : 0;
  const stagger = lineStagger(layout.lines.length);
  let n = 0;
  layout.lines.forEach((line, i) => {
    const words = wordsOf(line.text);
    const lineStart = timing ? timing.start + (animation === "words" ? n * step : i * stagger) : 0;
    // A word reveal fades each line's box in with its first word.
    const lineAnim = animation === "words" ? [{ t: lineStart, alpha: 0 }, { t: lineStart + WORD_ENTRANCE, alpha: 1 }] : entrance(animation, lineStart, s);
    if (look.background)
      items.push({ kind: "box", layer: 0, x: W / 2, y: line.y, w: line.width + s * 0.7, h: s * 1.34, radius: s * 0.28, color: look.background, ...(lineAnim && { anim: lineAnim }) });
    if (animation !== "words") {
      items.push({ kind: "text", layer: 1, font, size: s, text: line.text, fill: look.color, x: W / 2, y: line.y, ...border, ...(lineAnim && { anim: lineAnim }) });
      n += words.length;
      return;
    }
    // Each word centred where it sits in the whole line (the shared widths have no kerning, so they add up).
    let x = W / 2 - line.width / 2;
    const space = textWidth(" ", s, font);
    for (const word of words) {
      const w = textWidth(word, s, font);
      items.push({ kind: "text", layer: 1, font, size: s, text: word, fill: look.color, x: x + w / 2, y: line.y, ...border, anim: entrance("words", timing!.start + n * step, s) });
      x += w + space;
      n++;
    }
  });
  return items;
}
