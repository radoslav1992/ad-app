export type CaptionWord = { text: string; start: number; end: number };
export const captionStyles = ["classic", "bold", "karaoke", "highlight", "pop", "minimal", "neon", "typewriter", "bounce", "outline", "banner", "retro", "underline", "bubble", "wave", "sticker", "fade", "tiles", "luxe", "impact"] as const;
export type CaptionStyle = typeof captionStyles[number];
export type CaptionFormat = "9:16" | "1:1" | "16:9" | "4:5";
/**
 * How a picture of another shape fills the frame. "auto" (the default) fills the frame's height: a wider picture loses
 * its sides and stays centred (a horizontal avatar in a vertical video), a narrower one is shown whole. "contain" shows
 * the whole picture, "cover" fills the frame in both directions.
 */
export const captionFits = ["auto", "contain", "cover"] as const;
export type CaptionFit = typeof captionFits[number];
export type CaptionDocument = {
  words: CaptionWord[]; style: CaptionStyle; format: CaptionFormat;
  position: "bottom" | "middle" | "top"; enabled: boolean;
  accent?: string; textColor?: string; size?: number; uppercase?: boolean;
  resolution?: "720p" | "1080p"; fit?: CaptionFit;
};
export type CaptionLook = Omit<CaptionDocument, "words">;
export const captionPresets: { id: CaptionStyle; name: string; description: string; accent: string; uppercase: boolean }[] = [
  { id: "karaoke", name: "Karaoke", description: "Every word gets its moment", accent: "#c8f560", uppercase: true },
  { id: "highlight", name: "Marker", description: "A colour block follows the voice", accent: "#ffe16b", uppercase: false },
  { id: "bold", name: "Loud", description: "Big words, strong outline", accent: "#c8f560", uppercase: true },
  { id: "pop", name: "Spotlight", description: "One word. All the attention.", accent: "#c8f560", uppercase: true },
  { id: "classic", name: "Classic", description: "Readable text on a dark box", accent: "#c8f560", uppercase: false },
  { id: "minimal", name: "Clean", description: "Quiet text, more picture", accent: "#c8f560", uppercase: false },
  { id: "neon", name: "Neon", description: "A soft coloured glow", accent: "#73e8ec", uppercase: true },
  { id: "typewriter", name: "Reveal", description: "Words appear as they are spoken", accent: "#c8f560", uppercase: false },
  { id: "bounce", name: "Bounce", description: "The spoken word jumps", accent: "#ffd84d", uppercase: true },
  { id: "outline", name: "Outline", description: "Hollow letters the voice fills", accent: "#c8f560", uppercase: true },
  { id: "banner", name: "Banner", description: "A colour band across the frame", accent: "#ffe16b", uppercase: true },
  { id: "retro", name: "Retro", description: "Hard colour shadow", accent: "#ff5fa2", uppercase: true },
  { id: "underline", name: "Underline", description: "A bar follows each word", accent: "#73e8ec", uppercase: false },
  { id: "bubble", name: "Bubble", description: "Comic speech bubble", accent: "#7c5cff", uppercase: false },
  { id: "wave", name: "Wave", description: "Words sway in rhythm", accent: "#7cf5c4", uppercase: true },
  { id: "sticker", name: "Sticker", description: "Cut-out words with a white edge", accent: "#ff4d4d", uppercase: true },
  { id: "fade", name: "Fade", description: "Words float in one by one", accent: "#ffffff", uppercase: false },
  { id: "tiles", name: "Tiles", description: "Each word on its own tile", accent: "#c8f560", uppercase: true },
  { id: "luxe", name: "Luxe", description: "Elegant italic, gold accent", accent: "#e8c170", uppercase: false },
  { id: "impact", name: "Impact", description: "One word on a tilted label", accent: "#ff3b30", uppercase: true },
];
// Dark or white text, whichever reads better on the given colour.
export function readableOn(hex: string) {
  const [r, g, b] = hex.slice(1).match(/.{2}/g)!.map(v => parseInt(v, 16));
  return r * .299 + g * .587 + b * .114 > 150 ? "#111611" : "#ffffff";
}
export const defaultCaptions: CaptionDocument = { words: [], style: "karaoke", format: "9:16", position: "bottom", enabled: true };
export const demoWords: CaptionWord[] = [
  { text: "Stop", start: 0, end: .45 }, { text: "scrolling.", start: .45, end: 1.2 },
  { text: "This", start: 1.3, end: 1.6 }, { text: "changes", start: 1.6, end: 2.1 }, { text: "everything.", start: 2.1, end: 2.9 },
];
/** Captions of `words` in one of the styles, as posts burn them in (1080 × 1920, the style's own accent and case). */
export function styledCaptions(words: CaptionWord[], style: CaptionStyle, position: CaptionDocument["position"] = "bottom"): CaptionDocument {
  const preset = captionPresets.find((p) => p.id === style);
  return { words, style, format: "9:16", position, enabled: true, uppercase: preset?.uppercase ?? false, resolution: "1080p", accent: preset?.accent };
}
export function captionLook(document: CaptionDocument): CaptionLook {
  return {
    style: document.style, format: document.format, position: document.position, enabled: document.enabled,
    accent: document.accent || captionPresets.find(p => p.id === document.style)!.accent,
    textColor: document.textColor || "#ffffff", size: document.size || 1, uppercase: document.uppercase || false,
    resolution: document.resolution || "720p", fit: document.fit || "auto",
  };
}
export function alignmentWords(alignment: { characters: string[]; characterStartTimesSeconds: number[]; characterEndTimesSeconds: number[] } | undefined): CaptionWord[] {
  if (!alignment) return [];
  const { characters, characterStartTimesSeconds: starts, characterEndTimesSeconds: ends } = alignment;
  if (characters.length !== starts.length || characters.length !== ends.length) return [];
  const words: CaptionWord[] = [];
  let word: CaptionWord | null = null, inTag = false;
  const flush = () => { if (word) words.push(word); word = null; };
  for (let i = 0; i < characters.length; i++) {
    const char = characters[i];
    if (!Number.isFinite(starts[i]) || !Number.isFinite(ends[i]) || starts[i] < 0 || ends[i] < starts[i]) return [];
    if (char === "[") { flush(); inTag = true; }
    if (inTag) { if (char === "]") inTag = false; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    if (!word) word = { text: "", start: starts[i], end: ends[i] };
    word.text += char; word.end = ends[i];
  }
  flush();
  return words;
}
export function captionGroups(words: CaptionWord[]) {
  const groups: CaptionWord[][] = [];
  let group: CaptionWord[] = [];
  for (const word of words) {
    if (group.length && (group.length === 4 || word.start - group.at(-1)!.end > 0.8 || group.map(w => w.text).join(" ").length + word.text.length > 38)) {
      groups.push(group); group = [];
    }
    group.push(word);
    if (/[.!?]$/.test(word.text)) { groups.push(group); group = []; }
  }
  if (group.length) groups.push(group);
  return groups;
}
export function subtitleFile(words: CaptionWord[], type: "srt" | "vtt") {
  const time = (n: number) => new Date(Math.round(n * 1000)).toISOString().slice(11, 23).replace(".", type === "srt" ? "," : ".");
  return (type === "vtt" ? "WEBVTT\n\n" : "") + captionGroups(words).map((g, i) =>
    `${i + 1}\n${time(g[0].start)} --> ${time(g.at(-1)!.end)}\n${g.map(w => w.text).join(" ")}\n`).join("\n");
}
