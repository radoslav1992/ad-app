// What each network accepts from us, used to check a post before it is scheduled and to label the UI.
export const platformIds = ["tiktok", "instagram", "youtube", "linkedin"] as const;
export type PlatformId = (typeof platformIds)[number];
export const platforms: Record<PlatformId, {
  name: string; color: string; captionMax: number; video: { min: number; max: number }; photos: { max: number } | null; note: string;
}> = {
  tiktok: { name: "TikTok", color: "#111111", captionMax: 2200, video: { min: 3, max: 600 }, photos: { max: 35 }, note: "Videos and photo posts." },
  instagram: { name: "Instagram", color: "#e1306c", captionMax: 2200, video: { min: 3, max: 900 }, photos: { max: 10 }, note: "Reels and carousels on professional accounts." },
  youtube: { name: "YouTube", color: "#ff0000", captionMax: 5000, video: { min: 1, max: 180 }, photos: null, note: "Shorts up to 3 minutes." },
  linkedin: { name: "LinkedIn", color: "#0a66c2", captionMax: 3000, video: { min: 3, max: 1800 }, photos: { max: 20 }, note: "Video and multi-image posts on your profile." },
};
export const isPlatform = (p: string): p is PlatformId => (platformIds as readonly string[]).includes(p);
/** How a post goes out on a network: slideshows post as photos where the network has them, otherwise as video. */
export const postsAsPhotos = (format: string, platform: PlatformId) => format === "slideshow" && !!platforms[platform].photos;
