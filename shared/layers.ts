import { z } from "zod";

// Placement shared by the caption engine (shared/caption-scene.ts) and the renderer: positions inside a 5% safe
// margin, text layers (on-screen titles) and the slow movement of still images.
export const LAYER_MARGIN = 0.05;
export const layerPositions = [
  "top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right",
] as const;
export type LayerPosition = (typeof layerPositions)[number];
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
const time = z.number().finite().min(0).max(600).transform((n) => Math.round(n * 100) / 100);
export const textLayerSchema = z.object({
  id: z.string().min(1).max(64),
  start: time,
  end: time,
  type: z.literal("text"),
  /** Plain text; line breaks allowed. */
  text: z.string().max(200),
  position: z.enum(layerPositions),
  /** Letter height as a share of the frame height. */
  size: z.number().finite().min(0.02).max(0.15),
  color,
  /** Box behind the text, or none. */
  box: color.nullable(),
  bold: z.boolean(),
});
export type TextLayer = z.infer<typeof textLayerSchema>;

/** Horizontal and vertical anchor (0 = left/top, 0.5 = centre, 1 = right/bottom). */
export function anchor(position: LayerPosition): [number, number] {
  const x = position.endsWith("left") ? 0 : position.endsWith("right") ? 1 : 0.5;
  const y = position.startsWith("top") ? 0 : position.startsWith("bottom") ? 1 : 0.5;
  return [x, y];
}

/** Slow movement over a still image ("Ken Burns"): zoom in or out, or pan across the slightly enlarged picture. */
export const motions = ["zoom-in", "zoom-out", "pan-left", "pan-right"] as const;
export type Motion = (typeof motions)[number];
/** How much a moving still is enlarged at most: enough to feel alive, little enough to stay sharp. */
export const MOTION_ZOOM = 0.12;
/** The frame of a moving still at progress p (0..1); renderer/server.py `motion_filter` computes the same. */
export function motionAt(motion: Motion | undefined, p: number) {
  const q = Math.min(1, Math.max(0, p));
  switch (motion) {
    case "zoom-in": return { zoom: 1 + MOTION_ZOOM * q, x: 0.5, y: 0.5 };
    case "zoom-out": return { zoom: 1 + MOTION_ZOOM * (1 - q), x: 0.5, y: 0.5 };
    case "pan-left": return { zoom: 1 + MOTION_ZOOM, x: 1 - q, y: 0.5 };
    case "pan-right": return { zoom: 1 + MOTION_ZOOM, x: q, y: 0.5 };
    default: return { zoom: 1, x: 0.5, y: 0.5 };
  }
}
/** A different movement for each still of a slideshow, so consecutive slides do not repeat the same motion. */
export const motionFor = (i: number): Motion => motions[i % motions.length];

/** The optional brand mark, chosen per workspace: bottom right, above captions and text. */
export function watermarkPlacement(W: number, H: number, size = 0.035, margin = 0.04) {
  const edge = Math.min(W, H);
  return { size: Math.round(edge * size), x: Math.round(W - edge * margin), y: Math.round(H - edge * margin) };
}
