export interface Env {
  DB: D1Database;
  /** Private bucket: uploads, generated media, renders, library files. */
  MEDIA: R2Bucket;
  AI: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  ASSETS: Fetcher;
  /** Post runs ({runId}) and upload checks ({inspectId}). */
  CONTENT?: Workflow<{ runId?: string; inspectId?: string }>;
  SCAN?: Workflow<{ workspaceId: string }>;
  PUBLISH?: Workflow<{ publicationId: string }>;
  MEDIA_RENDERER?: DurableObjectNamespace;
  EMAIL?: SendEmail;
  SITE_URL?: string;
  APP_ENV?: string;
  REGISTRATION_ENABLED?: string;
  BILLING_ENABLED?: string;
  /** Rendering and AI generation (needs the renderer container and provider keys). */
  MEDIA_ENABLED?: string;
  EMAIL_FROM?: string;
  CONTACT_EMAIL?: string;
  ADMIN_EMAILS?: string;
  COMPANY_NAME?: string;
  COMPANY_ADDRESS?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Key of the trial identifier (HMAC of the mailbox), see billing.ts trialKey. */
  TRIAL_HASH_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_GROWTH?: string;
  STRIPE_PRICE_PRO?: string;
  /** "true": Stripe Checkout calculates tax (needs Stripe Tax set up). */
  STRIPE_AUTOMATIC_TAX?: string;
  /** Workers AI text model for brand profiles, ideas and scripts. */
  TEXT_MODEL?: string;
  FAL_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  /** Optional JSON {"aria":"<provider voice id>", …} overriding server/voices.ts. */
  ELEVENLABS_VOICES?: string;
  HEYGEN_API_KEY?: string;
  /** 32 random bytes, base64: encrypts social OAuth tokens at rest. */
  TOKEN_ENCRYPTION_KEY?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  INSTAGRAM_APP_ID?: string;
  INSTAGRAM_APP_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
}
export type DbUser = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  verified: number;
  created_at: number;
  stripe_customer: string | null;
  /** JSON answers of the onboarding questions (shared/onboarding.ts). */
  onboarding?: string;
};
export type ContextVars = { user: DbUser; session: string };
export type App = { Bindings: Env; Variables: ContextVars };
export const now = () => Math.floor(Date.now() / 1000);
/** Durations in seconds, matching now(). */
export const MINUTE = 60, HOUR = 3600, DAY = 86400;
export const MB = 1024 * 1024, GB = 1024 * MB;
export const uid = () => crypto.randomUUID();
/** The operator details the legal pages need before registrations and payments open. */
export function ready(e: Env) {
  return !!(e.COMPANY_NAME && e.CONTACT_EMAIL && e.SITE_URL);
}
export const mediaEnabled = (e: Env) => e.MEDIA_ENABLED === "true";
