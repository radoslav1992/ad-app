// The consumer's right of withdrawal from a subscription (Consumer Rights Directive Art. 9, 14(3) and 16(m);
// Bulgarian ЗЗП чл. 50–57). The plan starts within the 14 days only at the consumer's express request, given before
// checkout; a withdrawal within 14 days then returns what was paid, less the share of the plan that was used.

export const WITHDRAWAL_DAYS = 14;
/** Change the version whenever the text changes: each consent records the version it was given for. */
export const IMMEDIATE_START_VERSION = "2026-10-09";
export const IMMEDIATE_START_TEXT =
  "I want my plan to start straight after payment, so I can use its posts and AI credits during the 14-day withdrawal period. " +
  "I understand that if I withdraw in that period, I get back what I paid less the share of the plan I used " +
  "(the larger of the share of posts and the share of AI credits).";

/** A paid period's two meters: AI credits (`used`/`quota`) and posts (`postsUsed`/`postsQuota`). */
export type Usage = { used: number; quota: number; postsUsed: number; postsQuota: number };

/**
 * The meter with the larger used share: a plan gives posts and AI credits side by side, so using up either one used
 * up the plan to that extent. Compared as integers (used × other quota) so equal shares never flip on rounding.
 */
export function usedMeter(u: Usage): { meter: "credits" | "posts"; used: number; quota: number } {
  const credits = { meter: "credits" as const, used: clamp(u.used, u.quota), quota: Math.max(0, u.quota) };
  const posts = { meter: "posts" as const, used: clamp(u.postsUsed, u.postsQuota), quota: Math.max(0, u.postsQuota) };
  if (!credits.quota) return posts;
  if (!posts.quota) return credits;
  return posts.used * credits.quota > credits.used * posts.quota ? posts : credits;
}
const clamp = (used: number, quota: number) => Math.min(Math.max(0, used), Math.max(0, quota));

/**
 * Refund (in cents) on withdrawal: what was paid, less the used share of the plan (the larger of the two meters).
 * floor(paid × unused / quota) in integer arithmetic, so 30% used of $29.00 refunds exactly $20.30.
 */
export function withdrawalRefund(paid: number, u: Usage) {
  const m = usedMeter(u);
  if (!(paid > 0) || !(m.quota > 0)) return 0;
  return Math.floor((paid * (m.quota - m.used)) / m.quota);
}
