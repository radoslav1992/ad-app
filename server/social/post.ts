import { json } from "../db";
import { platforms, postsAsPhotos, type PlatformId } from "../../shared/social";
import { clip } from "./http";

// How a post goes out on a network: its text, title and media checks.

export type PostRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  format: string;
  spec: string;
  hook: string;
  caption: string;
  title: string;
  status: string;
  render_status: string;
  video_asset: string | null;
  cover_asset: string | null;
  slides: string;
  duration: number;
};

const hashtag = (t: unknown) => typeof t === "string" && /^#?[\p{L}\p{N}_]{1,60}$/u.test(t.trim()) ? (t.trim().startsWith("#") ? t.trim() : `#${t.trim()}`) : "";

/**
 * The text to publish: caption, a blank line and the hashtags, cut to the network's limit (hashtags kept). A tracked
 * `link` goes between them, whole: the caption is shortened to make room.
 */
export function postText(post: PostRow, platform: PlatformId, link?: string | null) {
  const spec = json<any>(post.spec, {});
  const caption = String(post.caption || spec.caption || "").trim();
  const hashtags = (Array.isArray(spec.hashtags) ? spec.hashtags : []).map(hashtag).filter(Boolean).slice(0, 30) as string[];
  const max = platforms[platform].captionMax;
  const tail = [link, hashtags.join(" ")].filter(Boolean).join("\n\n");
  const text = !tail ? clip(caption, max)
    : tail.length + 2 >= max ? clip(`${caption}\n\n${tail}`, max)
    : [clip(caption, max - tail.length - 2), tail].filter(Boolean).join("\n\n");
  const firstLine = caption.split("\n").find((l) => l.trim())?.trim() || "";
  const title = clip(String(spec.title || post.title || firstLine || post.hook || "").replace(/\s+/g, " ").trim(), 100);
  return { text, caption, hashtags, title, ...(link ? { link } : {}) };
}

/** Realistic AI media (a talking AI creator, AI images, clips or voices): disclosed where the network asks. */
export function synthetic(post: PostRow) {
  const spec = json<any>(post.spec, {});
  return post.format === "ugc" || !!spec.generated || !!spec.hookClip?.characterId || /"prompt"\s*:\s*"/.test(post.spec || "");
}

const span = (s: number) => (s % 60 === 0 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s} seconds`);

/** Why the post cannot go to this network as it is, or null. */
export function unfit(post: PostRow, platform: PlatformId): string | null {
  const facts = platforms[platform];
  if (postsAsPhotos(post.format, platform))
    return json<unknown[]>(post.slides, []).length ? null : `This post has no slides to send to ${facts.name}.`;
  if (!post.video_asset) return "This post has no video yet.";
  const d = Number(post.duration) || 0;
  if (d && d < facts.video.min) return `This video is too short for ${facts.name}: it needs at least ${span(facts.video.min)}.`;
  if (d > facts.video.max) return `This video is too long for ${facts.name}: the limit is ${span(facts.video.max)}.`;
  return null;
}
