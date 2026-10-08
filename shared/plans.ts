import { AVATAR_STEP, CLIP_CREDITS, CLIP_SECONDS, IMAGE_CREDITS, VOICE_CHARS, avatarRates } from "./credits";

// Plans: the source of truth for prices and limits. The server enforces `posts` and `credits` per usage window
// (D1 triggers), and `workspaces`, `accounts`, `scheduling` and `storageGb` in code.
export const plans = [
  {
    id: "free",
    name: "Free",
    price: 0,
    credits: 10,
    posts: 15,
    workspaces: 1,
    accounts: 0,
    scheduling: false,
    storageGb: 1,
    description: "A 7-day trial: see what your brand looks like on short-form.",
    features: ["7-day free trial", "15 posts and 10 AI credits", "Blitz swipe review", "Download everything", "No credit card"],
  },
  {
    id: "starter",
    name: "Starter",
    price: 29,
    credits: 250,
    posts: 150,
    workspaces: 1,
    accounts: 4,
    scheduling: true,
    storageGb: 10,
    description: "One brand, posting every day.",
    features: ["150 posts a month", "250 AI credits a month", "1 workspace", "4 social accounts", "Auto-publishing and calendar"],
  },
  {
    id: "growth",
    name: "Growth",
    price: 49,
    credits: 500,
    posts: 600,
    workspaces: 3,
    accounts: 30,
    scheduling: true,
    storageGb: 30,
    description: "Several brands or accounts at full speed.",
    features: ["600 posts a month", "500 AI credits a month", "3 workspaces", "Up to 30 social accounts", "Everything in Starter"],
  },
  {
    id: "pro",
    name: "Pro",
    price: 149,
    credits: 2000,
    posts: 3000,
    workspaces: 10,
    accounts: 100,
    scheduling: true,
    storageGb: 100,
    description: "Agencies and app studios running many accounts.",
    features: ["3,000 posts a month", "2,000 AI credits a month", "10 workspaces", "Up to 100 social accounts", "Everything in Growth"],
  },
] as const;
export type Plan = (typeof plans)[number];
export type PlanId = Plan["id"];
export const paidPlans = ["starter", "growth", "pro"] as const;
/** The free plan is a trial: it makes new posts for this many days after sign-up (made posts stay). */
export const TRIAL_DAYS = 7;
export type PaidPlanId = (typeof paidPlans)[number];
export const planById = (id: string | undefined): Plan => plans.find((p) => p.id === id) || plans[0];

/** In every plan. */
export const planIncludes = [
  "Every format: slideshows, wall of text, hook & demo, green screen memes and AI UGC",
  "Brand profile from your website",
  "Captions, music and your brand colours",
  "Commercial use of everything you make",
] as const;

/** Every AI price in credits, built from the constants the server charges by. */
export const tariffs: readonly { name: string; text: string }[] = [
  { name: "Rendered post", text: "No credits — counts as one post of your plan." },
  { name: "AI image", text: `${IMAGE_CREDITS} credit per image (slide, background or character portrait).` },
  { name: "AI video background", text: `${CLIP_CREDITS} credits per ${CLIP_SECONDS}-second clip.` },
  { name: "AI voice", text: `1 credit per started ${VOICE_CHARS} characters.` },
  {
    name: "Talking AI creator",
    text: `${avatarRates.library} credits per started ${AVATAR_STEP} seconds with a library character, ${avatarRates.custom} with your own character; plus the voice.`,
  },
];
export const PRICE_NOTE = "Prices in US dollars, billed monthly. Taxes may apply at checkout.";
