import type { Env } from "./types";
import { now, DAY } from "./types";
import { pruneAnalytics } from "./analytics";

// Storage limitation (GDPR Art. 5(1)(e)): records kept only for a while. The periods are described in docs/PRIVACY.md
// and the privacy policy (src/public/Legal.tsx); change all three together. Runs hourly from maintenance; each
// statement is on an index (migrations/0004_operations.sql) or bounded, so a run stays cheap. A `+` before a column
// keeps SQLite on the partial index meant for the statement instead of a wider index on that column.

/** Finished runs keep only non-personal details after this: provider tickets, input-link tokens and prompts go. */
export const RUN_DETAILS_DAYS = 30;
/** Failed or cancelled publications drop their media-link token and provider ticket after this. */
export const PUBLICATION_DETAILS_DAYS = 30;
/** Contact form messages. */
export const CONTACT_DAYS = 365;
/** Accounts whose email was never confirmed (the 7-day trial is long over by then). */
export const UNCONFIRMED_DAYS = 30;
/** A trial identifier nobody needed for this long (no new trial, no sign-in) is removed. */
export const TRIAL_HISTORY_DAYS = 730;
/** Terms acceptances and checkout consents of a deleted account, and withdrawals: the general 5-year limitation period. */
export const EVIDENCE_DAYS = 5 * 365;
/** Processed Stripe event IDs (webhook de-duplication; no personal data). */
export const BILLING_EVENT_DAYS = 90;
/** A checkout that was never completed: its intent (a week) and its consent (30 days). */
export const CHECKOUT_INTENT_DAYS = 7;
export const ABANDONED_CONSENT_DAYS = 30;

// What a finished run keeps in `payload`: the post revision and a creator run's name (shown in AI Studio's list); the
// prompt and description written for the AI are the person's text and go.
const KEPT_PAYLOAD = ["revision", "name", "gender", "characterId", "workspaceId"];
const keptPayload = `CASE WHEN json_valid(payload) THEN json_patch('{}',json_object(${KEPT_PAYLOAD.map((k) => `'${k}',json_extract(payload,'$.${k}')`).join(",")})) ELSE '{}' END`;

export async function applyRetention(e: Env, t = now()) {
  const details = t - RUN_DETAILS_DAYS * DAY;
  await e.DB.batch([
    e.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(t),
    e.DB.prepare("DELETE FROM auth_tokens WHERE expires_at<?").bind(t),
    e.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(t),
    e.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(t),
    e.DB.prepare("DELETE FROM contact_messages WHERE created_at<?").bind(t - CONTACT_DAYS * DAY),
    e.DB.prepare("DELETE FROM billing_events WHERE created_at<?").bind(t - BILLING_EVENT_DAYS * DAY),
    e.DB.prepare("DELETE FROM checkout_intents WHERE expires_at<?").bind(t - CHECKOUT_INTENT_DAYS * DAY),
    // Provider tickets, the renderer's input-link token and the voice's word timings are needed only while a run works.
    e.DB.prepare(
      `UPDATE runs SET payload=${keptPayload},provider='{}' WHERE id IN (SELECT id FROM runs WHERE provider<>'{}' AND updated_at<? AND +status IN ('completed','failed') LIMIT 500)`,
    ).bind(details),
    // A run that failed before it started has no provider state, but may still hold the prompt.
    e.DB.prepare(
      `UPDATE runs SET payload=${keptPayload} WHERE id IN (SELECT id FROM runs WHERE status='failed' AND created_at BETWEEN ? AND ? AND provider='{}' AND json_valid(payload) AND (json_extract(payload,'$.prompt') IS NOT NULL OR json_extract(payload,'$.description') IS NOT NULL) LIMIT 500)`,
    ).bind(details - 7 * DAY, details),
    e.DB.prepare(
      "UPDATE publications SET token=NULL,ticket=NULL WHERE id IN (SELECT id FROM publications WHERE (token IS NOT NULL OR ticket IS NOT NULL) AND updated_at<? AND +status IN ('failed','canceled') LIMIT 500)",
    ).bind(t - PUBLICATION_DETAILS_DAYS * DAY),
    // A row written without a time (not expected) starts its period now rather than going at once.
    e.DB.prepare("UPDATE trial_history SET updated_at=? WHERE updated_at=0").bind(t),
    e.DB.prepare("DELETE FROM trial_history WHERE updated_at<?").bind(t - TRIAL_HISTORY_DAYS * DAY),
    e.DB.prepare("DELETE FROM terms_acceptances WHERE account_deleted_at<?").bind(t - EVIDENCE_DAYS * DAY),
    e.DB.prepare("DELETE FROM checkout_consents WHERE account_deleted_at<?").bind(t - EVIDENCE_DAYS * DAY),
    e.DB.prepare("DELETE FROM checkout_consents WHERE confirmed_at IS NULL AND completed_at IS NULL AND created_at<?").bind(t - ABANDONED_CONSENT_DAYS * DAY),
    e.DB.prepare("DELETE FROM withdrawals WHERE created_at<?").bind(t - EVIDENCE_DAYS * DAY),
  ]);
  // Daily click counts and reported sales: 13 months (server/analytics.ts).
  await pruneAnalytics(e, t);
  await deleteUnconfirmed(e, t);
}

/**
 * Accounts whose email was never confirmed are deleted with everything in them, like a deletion by their owner (files
 * are queued for cleanup by the users trigger). One at a time: an account with work in progress is refused by its
 * trigger and tried again next hour. Never one with a Stripe customer.
 */
async function deleteUnconfirmed(e: Env, t: number) {
  const rows = (await e.DB.prepare("SELECT id FROM users WHERE verified=0 AND created_at<? AND +stripe_customer IS NULL LIMIT 20")
    .bind(t - UNCONFIRMED_DAYS * DAY).all<{ id: string }>()).results;
  let deleted = 0;
  for (const { id } of rows) {
    try { deleted += (await e.DB.prepare("DELETE FROM users WHERE id=? AND verified=0").bind(id).run()).meta.changes ? 1 : 0; }
    catch { console.warn("Unconfirmed account not deleted yet", { userId: id }); }
  }
  if (deleted) console.log("Unconfirmed accounts deleted", { count: deleted });
}
