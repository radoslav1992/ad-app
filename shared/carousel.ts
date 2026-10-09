import { z } from "zod";
import type { CaptionItem, CaptionText } from "./caption-scene";
import { textWidth, type CaptionFont } from "./caption-fonts";
import { screenText } from "./overlay";

// Carousels: Instagram-style swipeable picture posts. Designed, text-led slides at 4:5 or 1:1 in one of six themes,
// coloured by the post's brand kit: a cover with a bold hook (over a full-bleed picture by default), one point per
// slide, and a call to action last. One layout (carouselSlide) turns a slide into a page colour, an optional picture
// box, an optional logo box and caption items; the server burns the items into the picture with libass (renderer op
// "stills") and the editor draws the same items on a canvas (src/app/caption-canvas.ts), so the preview is the render.

export const carouselAspects = ["4:5", "1:1"] as const;
export type CarouselAspect = (typeof carouselAspects)[number];
/** Pixel sizes of the slides; Instagram takes feed pictures from 4:5 to 1.91:1, so both fit everywhere. */
export const carouselFrames: Record<CarouselAspect, { width: number; height: number }> = {
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
};
export const aspectInfo: Record<CarouselAspect, { name: string; note: string }> = {
  "4:5": { name: "Portrait 4:5", note: "Uses the most of the screen in the feed" },
  "1:1": { name: "Square 1:1", note: "Uses less of the screen" },
};

export const carouselThemeIds = ["clean", "bold", "dark", "paper", "photo", "quote"] as const;
export type CarouselTheme = (typeof carouselThemeIds)[number];
export const carouselThemes: Record<CarouselTheme, { name: string; description: string }> = {
  clean: { name: "Clean", description: "White page, dark words, a bar in your colour" },
  bold: { name: "Bold", description: "Your colour as the page, huge titles" },
  dark: { name: "Dark", description: "Ink page with a bright accent" },
  paper: { name: "Notebook", description: "Ruled paper and a highlighter" },
  photo: { name: "Photo", description: "Every picture full-bleed, words on a shade" },
  quote: { name: "Quote", description: "A quiet page and big serif words" },
};
export const slideKinds = ["cover", "content", "cta"] as const;
export type SlideKind = (typeof slideKinds)[number];
export const CAROUSEL_MIN_SLIDES = 2, CAROUSEL_MAX_SLIDES = 10;
export const SLIDE_TITLE_MAX = 120, SLIDE_BODY_MAX = 300, SLIDE_LABEL_MAX = 24;

const hex = z.string().regex(/^#[0-9a-f]{6}$/i);
const uuid = z.uuid();
const words = (max: number) => z.string().trim().max(max).transform(screenText);
/** The bundled fonts (renderer/fonts, public/fonts): no others can be drawn alike by the browser and libass. */
export const carouselFonts = ["sans", "regular", "serif"] as const satisfies readonly CaptionFont[];
export const fontNames: Record<CaptionFont, string> = { sans: "Noto Sans Bold", regular: "Noto Sans Regular", serif: "Noto Serif Italic" };

/** A slide's picture: one of the owner's images (an upload, a website image, an AI image), or an AI image to make. */
export const carouselImageSchema = z
  .object({ assetId: uuid.optional(), prompt: z.string().trim().min(3, "Describe the AI picture in a few words.").max(400).optional() })
  .refine((r) => r.assetId || r.prompt, "Choose a picture or describe one.");
export const carouselSlideSchema = z.object({
  kind: z.enum(slideKinds).default("content"),
  title: words(SLIDE_TITLE_MAX).default(""),
  body: words(SLIDE_BODY_MAX).default(""),
  /** A cover's kicker ("5 tips"), a point's number ("01") or tag ("Myth"); no emoji (the fonts cannot draw them). */
  label: words(SLIDE_LABEL_MAX).default(""),
  image: carouselImageSchema.optional(),
});
export type CarouselSlide = z.infer<typeof carouselSlideSchema>;

/** The call to action of the last slide; the post's caption ends with the same line. */
export const ctaTypes = ["comment", "link", "save", "follow"] as const;
export type CtaType = (typeof ctaTypes)[number];
export const ctaPresets: Record<CtaType, { name: string; text: string }> = {
  comment: { name: "Comment a keyword", text: "Comment {KEYWORD} and I'll send you the link" },
  link: { name: "Link in bio", text: "Link in bio" },
  save: { name: "Save and share", text: "Save this for later and send it to a friend who needs it" },
  follow: { name: "Follow", text: "Follow for more" },
};
export const KEYWORD = "{KEYWORD}";
export const carouselCtaSchema = z.object({
  type: z.enum(ctaTypes).default("save"),
  text: words(120).default(ctaPresets.save.text),
  /** The word people comment (type "comment"), shown big. */
  keyword: z.string().trim().max(20).transform((k) => screenText(k).toLocaleUpperCase("en").replace(/[^\p{L}\p{N}_-]/gu, "")).default(""),
});
export type CarouselCta = z.infer<typeof carouselCtaSchema>;
/** The CTA as one line (for the caption): the keyword written in. */
export function ctaLine(cta: CarouselCta) {
  const keyword = cta.keyword || "INFO";
  const text = cta.type === "comment" && !cta.text.includes(KEYWORD) ? `${cta.text} ${KEYWORD}` : cta.text;
  return text.replaceAll(KEYWORD, keyword).trim();
}
/** A caption that ends with the CTA line: the previous CTA's line replaced, or the line added on its own. */
export function captionWithCta(caption: string, cta: CarouselCta, previous?: CarouselCta) {
  const line = ctaLine(cta), text = caption.trim();
  const norm = (t: string) => t.replace(/[\s.!]+$/, ""), body = norm(text);
  if (!line || body.toLowerCase().endsWith(norm(line).toLowerCase())) return text;
  const old = previous ? norm(ctaLine(previous)) : "";
  const base = old && body.toLowerCase().endsWith(old.toLowerCase()) ? body.slice(0, body.length - old.length).trimEnd() : text;
  return `${base}${base ? "\n\n" : ""}${line}`.slice(0, 2200);
}

/**
 * The brand kit of a carousel, stored with the post (so its render and price never depend on later changes) and
 * offered as the workspace's default for new carousels.
 */
export const carouselKitSchema = z.object({
  /** In the footer of every slide, e.g. "@brand" or "brand.com". */
  handle: words(40).default(""),
  /** The workspace logo (an image of the owner's), in the footer. */
  logoId: uuid.optional(),
  /** The page colour; null: the theme's own. */
  background: hex.nullable().default(null),
  primary: hex.default("#7c5cff"),
  accent: hex.default("#c6f432"),
  /** Heading and paragraph fonts; null: the theme's pairing. */
  fonts: z.object({ title: z.enum(carouselFonts), body: z.enum(carouselFonts) }).nullable().default(null),
  /** A character or mascot every AI picture of the post keeps (an image of the owner's). */
  referenceId: uuid.optional(),
});
export type CarouselKit = z.infer<typeof carouselKitSchema>;
/** A new carousel's kit: the workspace's saved one, else its watermark or website as the handle, its logo and colours. */
export function defaultKit(w: { name: string; website: string | null; logoAssetId: string | null; profile: { colors: { primary: string; accent: string } }; settings: { watermark?: string; carousel?: CarouselKit | null } }): CarouselKit {
  const kit = (value: unknown) => { const r = carouselKitSchema.safeParse(value); return r.success ? r.data : null; };
  const saved = w.settings.carousel && kit(w.settings.carousel);
  if (saved) return saved;
  let host = "";
  try { host = w.website ? new URL(/^https?:/i.test(w.website) ? w.website : `https://${w.website}`).hostname.replace(/^www\./, "") : ""; } catch { /* not a link */ }
  const made = { handle: (w.settings.watermark || host || w.name || "").slice(0, 40), primary: w.profile.colors.primary, accent: w.profile.colors.accent };
  return kit({ ...made, ...(w.logoAssetId && { logoId: w.logoAssetId }) }) ?? kit(made) ?? carouselKitSchema.parse({});
}

/** What the layout reads of a carousel spec. */
export type CarouselInput = {
  aspect: CarouselAspect; theme: CarouselTheme; cover: "image" | "page";
  slides: { kind: SlideKind; title: string; body: string; label: string; image?: unknown }[];
  cta: CarouselCta; brand: CarouselKit; numbers: boolean; swipe: boolean;
};

/* ------------------------------------------------------------------------------------------------------ colours */

export const INK = "#111418", WHITE = "#ffffff", BLACK = "#000000", LIME = "#b8f53a";
const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** WCAG relative luminance. */
export function luminance(c: string) { const [r, g, b] = rgb(c); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
/** WCAG contrast ratio (1–21). Normal text needs 4.5, large text and shapes 3. */
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** `a` moved towards `b` by `t` (0–1). */
export function mix(a: string, b: string, t: number) {
  const p = rgb(a), q = rgb(b);
  return "#" + p.map((v, i) => Math.round(v + (q[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
/** White or ink on `bg`, whichever reads; black when even ink is short of 4.5:1 (a mid grey). */
export function textOn(bg: string) {
  if (contrast(WHITE, bg) >= 4.5) return WHITE;
  return contrast(INK, bg) >= 4.5 ? INK : contrast(WHITE, bg) > contrast(BLACK, bg) ? WHITE : BLACK;
}
/** `want` when it reaches `ratio` on `bg`, else the first fallback that does, else the readable text colour. */
export function readable(bg: string, ratio: number, ...want: string[]) {
  return want.find((c) => contrast(c, bg) >= ratio) ?? textOn(bg);
}
/** What a colour tends to suggest (rules of thumb, for the colour picker). */
export function colourMood(c: string) {
  const [r, g, b] = rgb(c).map((v) => v / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (l < 0.16) return "Black: sophistication and exclusivity.";
  if (d < 0.12 || l > 0.94) return "A neutral: it lets the words and pictures lead.";
  const h = (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60, hue = (h + 360) % 360;
  if (hue < 15 || hue >= 330) return "Red: energy and action.";
  if (hue < 45) return "Orange: creativity and fun.";
  if (hue < 70) return "Yellow: happiness and optimism.";
  if (hue < 165) return "Green: growth and health.";
  if (hue < 245) return "Blue: trust and calm.";
  return "Purple: luxury and imagination.";
}

/** The colours of one theme for a kit, every text colour checked against what it sits on. */
export type CarouselPalette = {
  background: string; title: string; body: string; muted: string; accent: string; onAccent: string;
  /** Notebook: the rules, the margin line and the highlighter behind titles. */
  rule?: string; margin?: string; highlight?: string;
};
export function carouselPalette(theme: CarouselTheme, kit: Pick<CarouselKit, "background" | "primary" | "accent">): CarouselPalette {
  const brand = kit.primary, second = kit.accent;
  const page = kit.background ?? ({ clean: WHITE, bold: brand, dark: "#0f1115", paper: "#f7f2e6", photo: "#16181d", quote: mix(WHITE, brand, 0.06) } as const)[theme];
  // Bold keeps the brand page: where neither white nor ink reads on it, it is darkened until white does.
  let bg = page;
  if (theme === "bold" && !kit.background) for (let t = 0.05; contrast(WHITE, bg) < 4.5 && contrast(INK, bg) < 4.5 && t <= 1; t += 0.05) bg = mix(page, BLACK, t);
  const text = textOn(bg), light = text === WHITE;
  const title = theme === "bold" || theme === "photo" ? text : readable(bg, 4.5, light ? WHITE : INK);
  const body = readable(bg, 4.5, light ? "#d5d8de" : theme === "paper" ? "#2f3238" : "#3a3e46", title);
  const muted = readable(bg, 4.5, light ? "#a3a8b1" : "#62666e", mix(body, bg, 0.15), body);
  const accent = theme === "bold" ? text : readable(bg, 3, brand, second, light ? LIME : INK);
  const onAccent = theme === "bold" ? bg : textOn(accent);
  const out: CarouselPalette = { background: bg, title, body, muted, accent, onAccent };
  if (theme === "paper") {
    out.rule = mix(bg, light ? WHITE : "#5b7fa6", 0.22);
    out.margin = mix(bg, "#d9534f", 0.45);
    // A highlighter tint of the brand colour that the title still reads on.
    out.highlight = [0.55, 0.7, 0.82].map((t) => mix(brand, bg, t)).find((c) => contrast(title, c) >= 4.5) ?? mix(bg, title === WHITE ? BLACK : WHITE, 0.3);
  }
  return out;
}
/** The fonts of a theme, unless the kit picks its own. */
export function carouselFontsOf(theme: CarouselTheme, kit: Pick<CarouselKit, "fonts">): { title: CaptionFont; body: CaptionFont } {
  return kit.fonts ?? { title: theme === "paper" || theme === "quote" ? "serif" : "sans", body: "regular" };
}

/* ------------------------------------------------------------------------------------------------------- layout */

export type Box = { x: number; y: number; w: number; h: number; radius: number };
export type CarouselSlideLayout = {
  width: number; height: number; background: string;
  /** The slide's picture, cover-cropped into this box (rounded by `radius`), under the items. */
  picture: Box | null;
  /** The logo, fitted inside this box, over everything. */
  logo: Box | null;
  items: CaptionItem[];
  /** "full": the picture fills the slide under a shade; "boxed": a picture under the words; "page": words only. */
  mode: "full" | "boxed" | "page";
};
type Row = { h: number; after: number; draw: (top: number, out: CaptionItem[]) => void; titleLines?: number };
type Frame = {
  W: number; H: number; x0: number; x1: number; align: "left" | "center"; pal: CarouselPalette; fonts: { title: CaptionFont; body: CaptionFont };
  /** Hollow numbers (Bold); the colour of numbers and quote marks (white over a picture, whose colours are unknown). */
  bold: boolean; mark: string;
};

/** Breaks text into lines no wider than `max`; a word wider than a line is split between letters, so nothing overflows. */
export function wrapText(text: string, size: number, max: number, font: CaptionFont): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ").filter(Boolean)) {
      if (textWidth(word, size, font) > max) {
        if (line) lines.push(line);
        let part = "";
        for (const ch of word) {
          if (part && textWidth(part + ch, size, font) > max) { lines.push(part); part = ch; } else part += ch;
        }
        line = part;
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if (line && textWidth(next, size, font) > max) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}
const lineX = (f: Frame, width: number) => (f.align === "center" ? (f.x0 + f.x1) / 2 : f.x0 + width / 2);
/** Lines of text; `highlight`: a marker stroke behind each line (Notebook titles). */
function textRow(f: Frame, text: string, font: CaptionFont, size: number, lead: number, fill: string, after: number, highlight?: string, title = false): Row | null {
  const lines = wrapText(text, size, f.x1 - f.x0, font);
  if (!lines.length) return null;
  const lh = size * lead;
  return {
    h: lines.length * lh, after, titleLines: title ? lines.length : undefined,
    draw: (top, out) => lines.forEach((line, i) => {
      const w = textWidth(line, size, font), x = lineX(f, w), y = top + lh * (i + 0.5);
      if (highlight) out.push({ kind: "box", layer: 2, x, y: y + size * 0.14, w: w + size * 0.3, h: size * 0.52, radius: size * 0.08, color: highlight });
      out.push({ kind: "text", layer: 3, font, size, text: line, fill, x, y });
    }),
  };
}
/** Text in a rounded box (a kicker, a tag, a button); long text wraps inside it. */
function pillRow(f: Frame, text: string, size: number, bg: string, fg: string, after: number, font: CaptionFont = "sans"): Row | null {
  const pad = size * 0.65, lines = wrapText(text, size, f.x1 - f.x0 - pad * 2, font);
  if (!lines.length) return null;
  const lh = size * 1.25, h = lines.length * lh + size * 0.7, w = Math.max(...lines.map((l) => textWidth(l, size, font))) + pad * 2;
  return {
    h, after,
    draw: (top, out) => {
      const cx = f.align === "center" ? (f.x0 + f.x1) / 2 : f.x0 + w / 2;
      out.push({ kind: "box", layer: 2, x: cx, y: top + h / 2, w, h, radius: Math.min(h / 2, size * 0.95), color: bg });
      lines.forEach((line, i) => out.push({ kind: "text", layer: 3, font, size, text: line, fill: fg, x: cx, y: top + size * 0.35 + lh * (i + 0.5) }));
    },
  };
}
function barRow(f: Frame, color: string, after: number): Row {
  const w = f.W * 0.11, h = f.W * 0.013;
  return { h, after, draw: (top, out) => out.push({ kind: "box", layer: 2, x: f.align === "center" ? (f.x0 + f.x1) / 2 : f.x0 + w / 2, y: top + h / 2, w, h, radius: h / 2, color }) };
}
/** A point's big number ("01"): in the accent colour, or hollow on a Bold page. */
function numberRow(f: Frame, text: string, size: number, after: number): Row {
  const font: CaptionFont = f.fonts.title === "serif" ? "serif" : "sans", h = size * 0.82;
  return {
    h, after,
    draw: (top, out) => {
      const w = textWidth(text, size, font), item: CaptionText = { kind: "text", layer: 3, font, size, text, x: lineX(f, w), y: top + h / 2, fill: f.mark };
      out.push(f.bold ? { ...item, fill: null, border: { color: f.mark, width: Math.max(2, size * 0.045) } } : item);
    },
  };
}
/** The big opening quote mark of the Quote theme (the glyph sits in the upper third of its em). */
function quoteRow(f: Frame, size: number, after: number): Row {
  return { h: size * 0.34, after, draw: (top, out) => out.push({ kind: "text", layer: 3, font: "serif", size, text: "\u201C", fill: f.mark, x: lineX(f, textWidth("\u201C", size, "serif")), y: top + size * 0.33 }) };
}
const total = (rows: Row[]) => rows.reduce((n, r, i) => n + r.h + (i < rows.length - 1 ? r.after : 0), 0);

/**
 * One slide: its page colour, picture and logo boxes and caption items, for the frame of its aspect. Words shrink until
 * they fit their part of the slide (titles first, then the body), and long words break, so nothing overflows or clips.
 * `picture`: the slide's picture can be shown (default: it has one); `logo`: the logo's width / height, when shown.
 */
export function carouselSlide(c: CarouselInput, index: number, opts: { picture?: boolean; logo?: number | null } = {}): CarouselSlideLayout {
  const { width: W, height: H } = carouselFrames[c.aspect];
  const slide = c.slides[index], n = c.slides.length, kind = slide.kind;
  const hasPicture = opts.picture ?? !!slide.image;
  const mode = !hasPicture ? "page" : c.theme === "photo" || (kind === "cover" && c.cover === "image") ? "full" : "boxed";
  const base = carouselPalette(c.theme, c.brand), fonts = carouselFontsOf(c.theme, c.brand);
  // Over a picture the words are white on a shade; the theme's accent stays where it reads on the shade.
  const shade = "#1b1d22";
  const pal: CarouselPalette = mode === "full"
    ? { ...base, title: WHITE, body: "#f1f2f4", muted: "#e4e6ea", accent: readable(shade, 3, base.accent, c.brand.primary, c.brand.accent, LIME) }
    : base;
  if (mode === "full") pal.onAccent = textOn(pal.accent);
  const paper = c.theme === "paper" && mode !== "full";
  const align = c.theme === "quote" && mode === "page" ? "center" : "left";
  const M = W * 0.085, x0 = paper ? W * 0.17 : M, x1 = W - M;
  const f: Frame = { W, H, x0, x1, align, pal, fonts, bold: c.theme === "bold" && mode !== "full", mark: mode === "full" ? WHITE : pal.accent };
  const y0 = W * 0.085, y1 = H - W * 0.15, area = y1 - y0;
  const gap = W * 0.045, minPicture = area * 0.36;
  const budget = mode === "boxed" ? area - gap - minPicture : mode === "full" ? area * (kind === "cover" ? 0.62 : 0.7) : area;

  const label = slide.label.trim(), number = kind === "content" && label.length <= 3 && /\S/.test(label);
  // Words alone on a page are bigger; next to a picture they leave it room.
  const sizes = { page: [0.11, 0.088, 0.09, 0.05, 0.046], boxed: [0.095, 0.07, 0.08, 0.04, 0.043], full: [0.105, 0.08, 0.085, 0.043, 0.043] }[mode];
  const titleMax = (kind === "cover" ? sizes[0] : kind === "content" ? sizes[1] : sizes[2]) * W, bodyMax = (kind === "content" ? sizes[3] : sizes[4]) * W;
  const maxLines = kind === "cover" ? 5 : 4;
  const build = (k: number): Row[] => {
    const t = titleMax * k, b = bodyMax * (0.45 + 0.55 * k), small = W * 0.032 * (0.6 + 0.4 * k);
    const rows: (Row | null)[] = [];
    if (c.theme === "clean" && kind !== "content" && mode === "page") rows.push(barRow(f, pal.accent, W * 0.045 * k));
    if (c.theme === "quote" && kind === "content" && mode === "page" && !number) rows.push(quoteRow(f, W * 0.26 * k, W * 0.01));
    if (label && number) rows.push(numberRow(f, label, W * 0.13 * k, W * 0.025 * k));
    else if (label) rows.push(pillRow(f, label, small, pal.accent, pal.onAccent, W * 0.035 * k));
    rows.push(textRow(f, slide.title, fonts.title, t, 1.12, pal.title, W * 0.032 * k, paper ? pal.highlight : undefined, true));
    if (c.theme === "dark" && mode !== "full" && slide.title) rows.push(barRow(f, pal.accent, W * 0.035 * k));
    rows.push(textRow(f, slide.body, fonts.body, b, 1.38, pal.body, W * 0.04 * k));
    if (kind === "cta") rows.push(...ctaRows(f, c.cta, b, k));
    return rows.filter((r): r is Row => !!r);
  };
  let k = 1, rows = build(k);
  // Shrink until the words fit their part of the slide and a title keeps to a few lines (the floor always fits).
  while (k > 0.14 && (total(rows) > budget || (k > 0.45 && rows.some((r) => (r.titleLines ?? 0) > maxLines)))) rows = build((k *= 0.95));
  const height = total(rows);

  const items: CaptionItem[] = [];
  let picture: Box | null = null, top: number;
  if (mode === "full") {
    picture = { x: 0, y: 0, w: W, h: H, radius: 0 };
    top = kind === "cover" && c.cover === "image" && c.theme !== "photo" ? y0 + (area - height) * 0.62 : y1 - height;
    // A shade over the whole picture and a deeper one from above the words to the bottom: the words keep at least
    // 4.5:1 even on a white picture (at most a third of it shows through).
    const from = Math.min(top - W * 0.15, H - W * 0.32), blur = W * 0.05;
    items.push({ kind: "box", layer: 0, x: W / 2, y: H / 2, w: W, h: H, radius: 0, color: BLACK, alpha: 0.18 });
    items.push({ kind: "box", layer: 1, x: W / 2, y: (from + H + blur * 4) / 2, w: W + blur * 8, h: H + blur * 4 - from, radius: 0, color: BLACK, alpha: 0.55, blur });
  } else if (mode === "boxed") {
    top = y0;
    const py = y0 + height + gap;
    picture = { x: x0, y: py, w: x1 - x0, h: y1 - py, radius: paper ? 0 : W * 0.03 };
  } else {
    top = y0 + (area - height) * (kind === "content" && c.theme !== "quote" ? 0.4 : 0.45);
  }
  for (const r of rows) { r.draw(top, items); top += r.h + r.after; }
  if (c.theme === "paper" && mode !== "full") items.push(...notebook(W, H, pal, picture));
  const logo = footer(c, index, n, f, pal, mode, opts.logo ?? null, items);
  return { width: W, height: H, background: pal.background, picture, logo, items, mode };
}

/** The last slide's call to action: a button, or "Comment" with the keyword big in a pill. */
function ctaRows(f: Frame, cta: CarouselCta, size: number, k: number): (Row | null)[] {
  const W = f.W;
  if (cta.type !== "comment") return [pillRow(f, cta.text, size * 1.05, f.pal.accent, f.pal.onAccent, 0)];
  const keyword = cta.keyword || "INFO";
  const [before, after = ""] = cta.text.includes(KEYWORD) ? cta.text.split(KEYWORD, 2) : [cta.text, ""];
  return [
    textRow(f, before.trim(), f.fonts.body, size, 1.38, f.pal.body, W * 0.02 * k),
    pillRow(f, keyword, W * 0.075 * k, f.pal.accent, f.pal.onAccent, W * 0.02 * k),
    textRow(f, after.trim(), f.fonts.body, size, 1.38, f.pal.body, 0),
  ];
}

/** Ruled paper and its margin line; rules stop at a picture (the words and lines are drawn over pictures). */
function notebook(W: number, H: number, pal: CarouselPalette, picture: Box | null): CaptionItem[] {
  const out: CaptionItem[] = [], h = Math.max(2, W * 0.0022);
  for (let y = W * 0.15; y < H - W * 0.04; y += W * 0.062) {
    const inPicture = picture && y > picture.y - h && y < picture.y + picture.h + h;
    const parts: [number, number][] = inPicture ? [[0, picture!.x - W * 0.012], [picture!.x + picture!.w + W * 0.012, W]] : [[0, W]];
    for (const [a, b] of parts) if (b - a > 1) out.push({ kind: "box", layer: 0, x: (a + b) / 2, y, w: b - a, h, radius: 0, color: pal.rule! });
  }
  out.push({ kind: "box", layer: 0, x: W * 0.12, y: H / 2, w: Math.max(2, W * 0.003), h: H, radius: 0, color: pal.margin! });
  // A white photo border, as if the picture were taped in.
  if (picture) {
    const b = W * 0.012, { x, y, w, h: ph } = picture;
    out.push({ kind: "box", layer: 1, x: x + w / 2, y: y - b / 2, w: w + 2 * b, h: b, radius: 0, color: WHITE });
    out.push({ kind: "box", layer: 1, x: x + w / 2, y: y + ph + b / 2, w: w + 2 * b, h: b, radius: 0, color: WHITE });
    out.push({ kind: "box", layer: 1, x: x - b / 2, y: y + ph / 2, w: b, h: ph, radius: 0, color: WHITE });
    out.push({ kind: "box", layer: 1, x: x + w + b / 2, y: y + ph / 2, w: b, h: ph, radius: 0, color: WHITE });
  }
  return out;
}

/** The footer: logo and handle on the left; the page ("3/7") or, on the cover, a "Swipe" cue on the right. */
function footer(c: CarouselInput, index: number, n: number, f: Frame, pal: CarouselPalette, mode: string, logoAspect: number | null, items: CaptionItem[]): Box | null {
  const { W, H } = f, M = W * 0.085, fs = W * 0.028, y = H - W * 0.075;
  let right = W - M;
  if (index === 0 && c.swipe && n > 1) {
    const s = fs, arrow = s * 1.15, pad = s * 0.8, tw = textWidth("Swipe", s, "sans"), w = pad + tw + s * 0.5 + arrow + pad, h = s * 2;
    const x = W - M - w;
    items.push({ kind: "box", layer: 4, x: x + w / 2, y, w, h, radius: h / 2, color: pal.accent });
    items.push({ kind: "text", layer: 5, font: "sans", size: s, text: "Swipe", fill: pal.onAccent, x: x + pad + tw / 2, y });
    const ax = x + pad + tw + s * 0.5;
    items.push({ kind: "box", layer: 5, x: ax + arrow * 0.4, y, w: arrow * 0.8, h: s * 0.16, radius: s * 0.08, color: pal.onAccent });
    items.push({ kind: "tail", layer: 5, x: 0, y: 0, color: pal.onAccent, points: [[ax + arrow * 0.55, y - s * 0.42], [ax + arrow, y], [ax + arrow * 0.55, y + s * 0.42]] });
    right = x - fs;
  } else if (c.numbers && n > 1) {
    const text = `${index + 1}/${n}`, w = textWidth(text, fs, "sans");
    items.push({ kind: "text", layer: 5, font: "sans", size: fs, text, fill: pal.muted, x: W - M - w / 2, y });
    right = W - M - w - fs;
  }
  let left = M, logo: Box | null = null;
  if (logoAspect && logoAspect > 0) {
    const h = fs * 1.7, w = h * Math.min(4, Math.max(0.6, logoAspect));
    logo = { x: M, y: y - h / 2, w, h, radius: 0 };
    // Logos are mostly dark on clear: on a dark page or a picture they sit on a small white chip.
    if (mode === "full" || luminance(pal.background) < 0.35) {
      const p = h * 0.22;
      items.push({ kind: "box", layer: 4, x: M + w / 2, y, w: w + 2 * p, h: h + 2 * p, radius: h * 0.3, color: WHITE });
      left += p;
      logo.x += p;
    }
    left += w + fs * 0.6;
  }
  const handle = c.brand.handle.trim();
  if (handle) {
    const room = right - left;
    let size = fs, text = handle;
    if (textWidth(text, size, "sans") > room) size = Math.max(fs * 0.6, (size * room) / textWidth(text, size, "sans"));
    while (text.length > 1 && textWidth(text, size, "sans") > room) text = `${text.slice(0, -2).trimEnd()}…`;
    if (room > fs && text.length > 1) items.push({ kind: "text", layer: 5, font: "sans", size, text, fill: pal.muted, x: left + textWidth(text, size, "sans") / 2, y });
  }
  return logo;
}
