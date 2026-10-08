import { z } from "zod";
import type { CaptionItem } from "./caption-scene";
import { textWidth, type CaptionFont } from "./caption-fonts";

// On-screen text of short-form posts: the hook over a video, the words on a slide. One layout, measured with the
// renderer's own font metrics (shared/caption-fonts.ts), becomes caption items that server/caption-ass.ts burns in
// with libass; the editor draws the same layout in the browser (src/app/TextPreview.tsx) from these numbers.

const hex = z.string().regex(/^#[0-9a-f]{6}$/i);
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
});
export type TextLook = z.infer<typeof textLookSchema>;
export type TextPosition = TextLook["position"];
/** Ready-made looks the writer and the editor offer. */
export const textPresets: Record<string, { name: string; look: TextLook }> = {
  classic: { name: "Classic", look: { weight: "bold", size: 1, color: "#ffffff", stroke: 4, strokeColor: "#000000", background: null, position: "center" } },
  box: { name: "Text box", look: { weight: "bold", size: 1, color: "#000000", stroke: 0, strokeColor: "#ffffff", background: "#ffffff", position: "center" } },
  quiet: { name: "Quiet", look: { weight: "regular", size: 0.85, color: "#ffffff", stroke: 3, strokeColor: "#000000", background: null, position: "center" } },
  loud: { name: "Loud", look: { weight: "bold", size: 1.3, color: "#ffe14d", stroke: 6, strokeColor: "#000000", background: null, position: "center" } },
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

/** The caption items that draw `text` with a look (boxes first, then letters with their outline). */
export function overlayItems(text: string, look: TextLook, W: number, H: number): CaptionItem[] {
  const layout = layoutOverlay(text, look, W, H), s = layout.size, font = fontOf(look);
  const stroke = (look.stroke * W) / 1080;
  const items: CaptionItem[] = [];
  for (const line of layout.lines) {
    if (look.background)
      items.push({ kind: "box", layer: 0, x: W / 2, y: line.y, w: line.width + s * 0.7, h: s * 1.34, radius: s * 0.28, color: look.background });
    items.push({
      kind: "text", layer: 1, font, size: s, text: line.text, fill: look.color, x: W / 2, y: line.y,
      ...(stroke > 0 && { border: { color: look.strokeColor, width: stroke } }),
    });
  }
  return items;
}
