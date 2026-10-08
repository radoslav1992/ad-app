import { z } from "zod";

export const businessCategories = ["ecommerce", "saas", "agency", "services", "marketplace", "media", "mobile_app", "other"] as const;
export const businessCategoryNames: Record<(typeof businessCategories)[number], string> = {
  ecommerce: "E-commerce", saas: "SaaS", agency: "Agency", services: "Services", marketplace: "Marketplace", media: "Media/Content", mobile_app: "Mobile app", other: "Other",
};
// A workspace's brand profile: what the website scan understood, editable by the owner. Every idea, script and
// caption is written from it.
const line = (max: number) => z.string().trim().max(max).default("");
const list = (n: number, max = 160) => z.array(z.string().trim().min(1).max(max)).max(n).default([]);
const hex = z.string().regex(/^#[0-9a-f]{6}$/i);
export const profileSchema = z.object({
  name: line(80),
  /** One line: what it is. */
  product: line(200),
  description: line(1200),
  category: line(80),
  audience: line(400),
  valueProps: list(6),
  painPoints: list(6),
  features: list(8),
  /** How the brand sounds, e.g. "playful, direct, a little cheeky". */
  tone: line(160),
  /** Call to action used at the end of scripts, e.g. "Download it free on the App Store". */
  cta: line(160),
  keywords: list(12, 40),
  /** BCP-47 language of the content, e.g. "en". */
  language: z.string().trim().regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/).default("en"),
  colors: z.object({ primary: hex.default("#7c5cff"), accent: hex.default("#c6f432") }).default({ primary: "#7c5cff", accent: "#c6f432" }),
  /** From onboarding: who the brand sells to, and what kind of business it is. */
  businessModel: z.enum(["b2b", "b2c", "both", ""]).default(""),
  categories: z.array(z.enum(businessCategories)).max(8).default([]),
  /** Free notes the writer always follows (claims to avoid, words to use). */
  notes: line(1000),
});
export type Profile = z.infer<typeof profileSchema>;
export const emptyProfile = (): Profile => profileSchema.parse({});
