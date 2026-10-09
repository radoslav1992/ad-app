import type { CaptionDocument } from "../shared/captions";
import { animState, captionTimeline, textLayerItems, type CaptionItem } from "../shared/caption-scene";
import { ASS_SIZE, CAPTION_FAMILIES } from "../shared/caption-fonts";
import { watermarkPlacement, type TextLayer } from "../shared/layers";
export function renderDimensions(doc: CaptionDocument) {
  const short = doc.resolution === "1080p" ? 1080 : 720;
  const [a, b] = doc.format.split(":").map(Number);
  return a <= b
    ? [short, Math.round((short * b) / a / 2) * 2]
    : [Math.round((short * a) / b / 2) * 2, short];
}
const assColor = (hex: string) => "&H" + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3) + "&";
const assAlpha = (opacity: number) => "&H" + Math.round(255 * (1 - Math.min(1, Math.max(0, opacity)))).toString(16).padStart(2, "0").toUpperCase() + "&";
const num = (n: number) => String(Math.round(n * 100) / 100);
const assEscape = (text: string) => text.replaceAll("\\", "＼").replaceAll("{", "｛").replaceAll("}", "｝").replace(/[\r\n]/g, " ");
/** The same rounded rectangle as the browser (corner curves with both control points on the corner). */
function roundedDrawing(w: number, h: number, radius: number) {
  const r = Math.min(radius, w / 2, h / 2), n = (v: number) => num(v);
  return `m ${n(r)} 0 l ${n(w - r)} 0 b ${n(w)} 0 ${n(w)} 0 ${n(w)} ${n(r)} l ${n(w)} ${n(h - r)} b ${n(w)} ${n(h)} ${n(w)} ${n(h)} ${n(w - r)} ${n(h)} ` +
    `l ${n(r)} ${n(h)} b 0 ${n(h)} 0 ${n(h)} 0 ${n(h - r)} l 0 ${n(r)} b 0 0 0 0 ${n(r)} 0`;
}
/** Override tags for an item's look at one moment (scale and opacity are what animations change). */
function lookTags(item: CaptionItem, state: ReturnType<typeof animState>) {
  const alpha = (item.alpha ?? 1) * state.alpha;
  const scale = `\\fscx${num(100 * state.scale * state.sx)}\\fscy${num(100 * state.scale)}`;
  if (item.kind !== "text") return `${scale}\\1a${assAlpha(alpha)}`;
  const fill = item.fill === null ? "\\1a&HFF&" : `\\1a${assAlpha(alpha * (item.fillAlpha ?? 1))}`;
  return `${scale}${fill}${item.border ? `\\3a${assAlpha(alpha * (item.border.alpha ?? 1))}` : ""}`;
}
/** ASS events for one item during [from, to): one event per stretch between its keyframes (\\move moves once per event). */
function itemEvents(item: CaptionItem, from: number, to: number, time: (s: number) => string, style = "Default", layerBase = 0) {
  const cuts = [from, ...(item.anim || []).map((k) => k.t).filter((t) => t > from + .005 && t < to - .005), to];
  let out = "";
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (Math.round(b * 100) <= Math.round(a * 100)) continue;
    const s0 = animState(item, a), s1 = animState(item, b), dur = Math.round((b - a) * 1000);
    const x0 = item.x + s0.dx, y0 = item.y + s0.dy, x1 = item.x + s1.dx, y1 = item.y + s1.dy;
    const place = Math.abs(x1 - x0) > .05 || Math.abs(y1 - y0) > .05 ? `\\move(${num(x0)},${num(y0)},${num(x1)},${num(y1)})` : `\\pos(${num(x0)},${num(y0)})`;
    const start = lookTags(item, s0), end = lookTags(item, s1);
    const change = start !== end ? `\\t(0,${dur},${end})` : "";
    const rotate = item.rotate ? `\\frz${num(-item.rotate * 180 / Math.PI)}` : "";
    const blur = item.blur ? `\\blur${num(item.blur * s0.scale)}` : "";
    let tags: string, body: string;
    if (item.kind === "text") {
      const f = CAPTION_FAMILIES[item.font];
      tags = `\\an5${place}\\fn${f.family}\\b${f.weight >= 700 ? 1 : 0}\\i${f.italic ? 1 : 0}\\fs${num(item.size * ASS_SIZE)}` +
        `\\1c${assColor(item.fill ?? "#000000")}` +
        (item.border ? `\\3c${assColor(item.border.color)}\\bord${num(item.border.width)}` : "\\bord0") + `\\shad0${rotate}${blur}${start}${change}`;
      body = assEscape(item.text);
    } else if (item.kind === "box") {
      tags = `\\an${item.fromLeft ? 4 : 5}${place}\\p1\\1c${assColor(item.color)}\\bord0\\shad0${rotate}${blur}${start}${change}`;
      body = roundedDrawing(item.w, item.h, item.radius) + "{\\p0}";
    } else {
      const xs = item.points.map((p) => p[0]), ys = item.points.map((p) => p[1]), minX = Math.min(...xs), minY = Math.min(...ys);
      tags = `\\an7\\pos(${num(minX + item.x + s0.dx)},${num(minY + item.y + s0.dy)})\\p1\\1c${assColor(item.color)}\\bord0\\shad0${blur}${start}`;
      body = `m ${item.points.map(([x, y]) => `${num(x - minX)} ${num(y - minY)}`).join(" l ")}{\\p0}`;
    }
    out += `Dialogue: ${item.layer + layerBase},${time(a)},${time(b)},${style},,0,0,0,,{${tags}}${body}\n`;
  }
  return out;
}
/** `offset` shifts every caption, e.g. by the timeline's lead-in before the voice starts. */
export function captionAss(doc: CaptionDocument, offset = 0) {
  const [width, height] = renderDimensions(doc);
  const time = (s: number) => {
    const n = Math.max(0, Math.round((s + offset) * 100));
    return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, "0")}:${String(Math.floor(n / 100) % 60).padStart(2, "0")}.${String(n % 100).padStart(2, "0")}`;
  };
  // Every word is placed by the shared layout (shared/caption-scene.ts), exactly as in the browser preview.
  let ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans,${Math.round(height * .05)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  for (const interval of captionTimeline(doc, width, height))
    for (const item of interval.items) ass += itemEvents(item, interval.start, interval.end, time, "Default", 10);
  return ass;
}
/** Adds captions (times on the video's clock, drawn above on-screen text) to an ASS script for the same frame. */
export function withCaptions(ass: string, doc: CaptionDocument, offset = 0) {
  const events = captionAss(doc, offset).split("[Events]\n")[1].split("\n").filter((line) => line.startsWith("Dialogue:"));
  return events.length ? ass + events.join("\n") + "\n" : ass;
}
/**
 * One ASS script for several scenes on the final video's clock. Frame size comes from `base`; each scene
 * keeps its own look as a separate style (S0, S1, …) and its captions are shifted by `offset`.
 */
export function captionAssScenes(base: CaptionDocument, scenes: { document: CaptionDocument; offset: number }[]) {
  let header = "", styles = "", events = "";
  scenes.forEach(({ document, offset }, i) => {
    const ass = captionAss({ ...document, format: base.format, resolution: base.resolution }, offset);
    const [head, rest] = ass.split("[V4+ Styles]\n");
    const [styleBlock, eventBlock] = rest.split("[Events]\n");
    if (!i) header = head;
    const [format, style] = styleBlock.trim().split("\n");
    if (!i) styles = format + "\n";
    styles += style.replace(/^Style: Default,/, `Style: S${i},`) + "\n";
    const [eventFormat, ...lines] = eventBlock.trim().split("\n");
    if (!i) events = eventFormat + "\n";
    for (const line of lines) if (line) events += line.replace(/^(Dialogue: \d+,[^,]*,[^,]*,)Default,/, `$1S${i},`) + "\n";
  });
  return `${header}[V4+ Styles]\n${styles}\n[Events]\n${events}`;
}
/**
 * Adds text layers (titles, lower thirds) to an ASS script as positioned events, before the captions so
 * captions stay on top. Times are on the final video's clock. Matches the canvas drawing in the browser.
 */
export function withTextLayers(ass: string, texts: TextLayer[], width: number, height: number) {
  if (!texts.length) return ass;
  const time = (s: number) => {
    const n = Math.max(0, Math.round(s * 100));
    return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, "0")}:${String(Math.floor(n / 100) % 60).padStart(2, "0")}.${String(n % 100).padStart(2, "0")}`;
  };
  // Below the captions (their layers start at 10); every look comes from the items' own tags.
  const styles = "Style: T,Noto Sans,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n";
  const events = texts.flatMap((t) => textLayerItems(t, width, height).map((item) => itemEvents(item, t.start, t.end, time, "T"))).join("");
  return ass
    .replace("\n\n[Events]\n", `\n${styles}\n[Events]\n`)
    .replace(/(\[Events\]\nFormat:[^\n]*\n)/, `$1${events}`);
}
/** ASS layer of the watermark: above text layers (0+) and captions (10+). */
const WATERMARK_LAYER = 100;
/** Adds a small semi-transparent brand mark for the whole video, bottom right, above captions and text layers. */
export function withWatermark(ass: string, text: string, width: number, height: number) {
  if (!text.trim()) return ass;
  const { size, x, y } = watermarkPlacement(width, height);
  const style = `Style: W,Noto Sans,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(size * 0.06))},0,3,0,0,0,1\n`;
  return ass.replace("\n\n[Events]\n", `\n${style}\n[Events]\n`) +
    `Dialogue: ${WATERMARK_LAYER},0:00:00.00,9:59:59.99,W,,0,0,0,,{\\an3\\pos(${x},${y})\\alpha&H26&}${assEscape(text.slice(0, 40))}\n`;
}
/** An empty ASS script for a frame, to which captions, text layers and timed items are added. */
export function emptyAss(width: number, height: number) {
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Noto Sans,${Math.round(height * .05)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
}
const clock = (s: number) => {
  const n = Math.max(0, Math.round(s * 100));
  return `${Math.floor(n / 360000)}:${String(Math.floor(n / 6000) % 60).padStart(2, "0")}:${String(Math.floor(n / 100) % 60).padStart(2, "0")}.${String(n % 100).padStart(2, "0")}`;
};
/** Adds caption items (on-screen text from shared/overlay.ts) shown from `from` to `to` on the video clock. */
export function withItems(ass: string, items: CaptionItem[], from: number, to: number, layerBase = 0) {
  return ass + items.map((item) => itemEvents(item, from, to, clock, "Default", layerBase)).join("");
}
