import type { PlatformId } from "./social";

// Post performance (read from the networks) and the clicks and sales tracked links bring: the API's answers.

/** How far back the analytics page looks. */
export const analyticsRanges = [7, 30] as const;
export type AnalyticsRange = (typeof analyticsRanges)[number];
/** Networks whose captions can't hold a clickable link: they get a "link in bio" tracked link instead. */
export const bioPlatforms = ["tiktok", "instagram"] as const satisfies readonly PlatformId[];
/** Networks whose captions get the post's tracked link (when the workspace turns it on). */
export const captionLinkPlatforms = ["youtube", "linkedin"] as const satisfies readonly PlatformId[];
/** Networks we can read post stats from (LinkedIn keeps member post analytics to approved partners). */
export const statsPlatforms = ["tiktok", "instagram", "youtube"] as const satisfies readonly PlatformId[];
/** A sale or sign-up is credited to the last tracked click at most this long before it. */
export const ATTRIBUTION_DAYS = 30;

/** An amount per currency (sales in different currencies are never added together). */
export type Money = { currency: string; amount: number };
export type Counts = {
  /** Lifetime counts from the networks; null when none of the posts has that number yet. */
  views: number | null; likes: number | null; comments: number | null; shares: number | null;
  clicks: number; conversions: number; revenue: Money[];
};
export type NetworkNote = { tone: "info" | "warn"; text: string; action?: "reconnect" };
export type NetworkRow = Counts & {
  platform: PlatformId;
  /** Posts published in the range, and how many of them have stats. */
  posts: number; withStats: number;
  statsAvailable: boolean; lastUpdated: number | null; notes: NetworkNote[];
};
export type TopPost = Counts & {
  postId: string; platform: PlatformId; hook: string; format: string | null; thumbAssetId: string | null;
  url: string | null; publishedAt: number | null; deleted: boolean;
};
export type AnalyticsResponse = {
  days: AnalyticsRange; since: number;
  totals: Counts & { posts: number; withStats: number };
  networks: NetworkRow[];
  /** One entry per UTC day of the range, oldest first. */
  daily: { day: string; clicks: number; conversions: number }[];
  top: TopPost[];
  /** Sales reported without a tracked click in the 30 days before them. */
  unattributed: { conversions: number; revenue: Money[] };
  lastUpdated: number | null;
};
export type SetupResponse = {
  siteKey: string; scriptUrl: string; endpoint: string; snippet: string;
  linksEnabled: boolean; targetUrl: string | null; website: string | null;
  /** Where tracked links lead now (target, else the website); null when neither is a usable web address. */
  target: string | null;
  bioLinks: { platform: PlatformId; url: string; clicks: number }[];
  /** When the site's script last answered `hookstreak('test')`. */
  testedAt: number | null;
};
/** Per post: what the content cards and calendar show. */
export type PostStatsResponse = { posts: Record<string, { views: number | null; clicks: number }> };

/** UTC day number of a unix time (how clicks are counted). */
export const dayOf = (unix: number) => Math.floor(unix / 86400);
export const dayLabel = (day: number) => new Date(day * 86400 * 1000).toISOString().slice(0, 10);
