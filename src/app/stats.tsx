import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { api, number } from "../lib";
import type { Money, PostStatsResponse } from "../../shared/analytics";
import "./analytics.css";

// Small helpers for showing post stats (analytics page, home, content cards, calendar). Only numbers the networks or
// our own counters reported are shown; a missing one is "–", never a guess.

const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** 1,284 · 12.9K · 4.2M */
export const compact = (n: number) => (Math.abs(n) < 10_000 ? number(n) : compactFormat.format(n));
export const orDash = (n: number | null | undefined, full = false) => (n === null || n === undefined ? "–" : full ? number(n) : compact(n));
export const plural = (n: number, one: string, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
/** "just now", "40 min ago", "3 h ago", "2 days ago": how fresh a number is. */
export function since(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} day${s < 2 * 86400 ? "" : "s"} ago`;
}
/** Likes, comments and shares together; null when the network reported none of them. */
export const engagementOf = (c: { likes: number | null; comments: number | null; shares: number | null }) =>
  c.likes === null && c.comments === null && c.shares === null ? null : (c.likes ?? 0) + (c.comments ?? 0) + (c.shares ?? 0);

function moneyText({ currency, amount }: Money) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: Number.isInteger(amount) ? 0 : 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
/** "$64.90 + €20": sales in different currencies are listed, never added together. */
export const formatMoney = (list: Money[]) => (list.length ? list.map(moneyText).join(" + ") : null);

/** Views (all networks, all time) and tracked-link clicks per post of a workspace; empty until loaded. */
export function usePostStats(workspaceId: string) {
  const [stats, setStats] = useState<PostStatsResponse["posts"]>({});
  useEffect(() => {
    let live = true;
    api<PostStatsResponse>(`/workspaces/${workspaceId}/analytics/posts`).then((r) => { if (live) setStats(r.posts || {}); }).catch(() => {});
    return () => { live = false; };
  }, [workspaceId]);
  return stats;
}

/** "1.2K views" with an eye icon, for cards. */
export function Views({ views, short = false }: { views: number; short?: boolean }) {
  return (
    <span className="an-views" title={`${number(views)} views`}>
      <Eye size={12} aria-hidden="true" />
      {compact(views)}{short ? <span className="sr-only"> views</span> : " views"}
    </span>
  );
}
