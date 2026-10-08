import { z } from "zod";

// The first-run questions (after the brand is set up). Answers tailor recommendations and are stored on the user;
// none of them is required to use the product.
export const teamSizes = ["Just me", "2 - 5", "6 - 10", "11 - 20", "21 - 50", "50+"] as const;
export const revenues = ["Pre-revenue", "$1 - $1,000", "$1,000 - $10k", "$10k - $50k", "$50k - $500k", "$500k+"] as const;
export const roles = [
  "Founder", "Social Media Manager", "Marketing Manager", "Agency Owner", "Freelancer", "Product Manager", "Content Creator", "Growth Manager", "Other",
] as const;
export const urgencies = ["I need marketing now", "I need marketing in the future", "Just curious"] as const;
export const goals = [
  "To save time on content creation", "To get more views on social media", "To drive traffic to my site", "To generate revenue",
  "To learn and become better at content marketing", "Other",
] as const;
export const sources = [
  "X (Twitter)", "LinkedIn", "YouTube", "TikTok", "Instagram", "Facebook", "Podcast", "Newsletter", "Google", "Reddit",
  "ChatGPT", "Claude", "Gemini", "Friend/Referral", "Other",
] as const;

export const onboardingSchema = z.object({
  teamSize: z.enum(teamSizes).optional(),
  revenue: z.enum(revenues).optional(),
  role: z.enum(roles).optional(),
  urgency: z.enum(urgencies).optional(),
  goals: z.array(z.enum(goals)).max(goals.length).optional(),
  sources: z.array(z.enum(sources)).max(sources.length).optional(),
  /** Unix seconds when the onboarding was finished (the app then opens on the dashboard). */
  completedAt: z.number().int().optional(),
});
export type Onboarding = z.infer<typeof onboardingSchema>;
