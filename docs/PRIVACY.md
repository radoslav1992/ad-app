# Personal data: retention and deletion

What Hookstreak keeps, for how long, and what account deletion removes. This is the technical source for the public
privacy policy (`/privacy`, `src/public/Legal.tsx`); keep both in line when either changes. The periods live in code:
`server/retention.ts` (constants and the hourly run), `server/maintenance.ts` (uploads, files) and
`server/analytics.ts` (`pruneAnalytics`). The indexes that keep each statement cheap are in
`migrations/0004_operations.sql`. Ported from rech-bg's `docs/PRIVACY.md`.

Retention runs hourly (maintenance at minute 17) as one D1 batch. Every statement is on an index or bounded
(at most 500 rows per statement and hour, 20 unconfirmed accounts per hour), so a backlog is worked off over a few
hours rather than in one expensive run.

## While the account exists

| Data | Kept | How it goes |
| --- | --- | --- |
| Profile (name, email, password hash, onboarding answers), workspaces, brand profiles, posts, uploads, creators, schedules, connected accounts | While the account exists | With the account, or when the user deletes the item |
| Sessions | 30 days | Removed hourly once expired |
| Email confirmation / password reset links (hash of the token only) | 24 hours / 1 hour | Removed hourly once expired |
| OAuth sign-in states for social networks | 10 minutes | Removed hourly once expired |
| Rate-limit counters (SHA-256 of scope + IP or email + time window) | Until the window ends (at most 1 day) | Removed hourly |
| Accounts whose email was never confirmed | 30 days (the 7-day trial is long over) | Deleted with everything, like a deletion by the user. Never one with a Stripe customer; one with work in progress waits until it is done |
| Runs (AI work and renders): the prompt or description written for the AI (`runs.payload`), provider tickets, the renderer's input-link token and the voice's word timings (`runs.provider`) | 30 days after the run finished | Cleared. The post revision, a creator run's name, gender and IDs, status, credits and dates stay (receipts and AI Studio's list). A run that failed before it started has its prompt cleared the same way |
| Failed or cancelled publications: the media-link token and the network's ticket | 30 days after the last change | Cleared; the publication record (status, error message, times) stays with the post |
| Uploads that failed their check / never finished | 7 days / 1 day | Removed by maintenance |
| Contact form messages (name, email, topic, message; not linked to an account) | 365 days | Removed hourly |
| Daily click counts and reported sales from tracked links | 400 days (13 months) | Removed hourly (`pruneAnalytics`) |
| Checkout intents (which plan a checkout was opened for) | 7 days after the checkout link expired | Removed hourly |
| Request for immediate start of an abandoned checkout (never completed) | 30 days | Removed hourly |
| Processed Stripe event IDs (webhook de-duplication; no personal data) | 90 days | Removed hourly |
| Work set aside for a manual check (run ID, provider request ID, reason) | 90 days | Removed by maintenance |

## Kept after the account is deleted

| Data | Kept | Why |
| --- | --- | --- |
| Trial identifier: HMAC-SHA256 of the normalised mailbox (`+tags` dropped, Gmail dots ignored) with `TRIAL_HASH_SECRET`, plus how many trial posts and credits were used | 24 months after it was last needed (trial started, sign-in) | So deleting and re-registering, or `user+1@…`, does not grant a new free trial. Not the address itself |
| Terms acceptance (internal user ID, terms version, time) | 5 years after the account is deleted | Evidence of the contract (general limitation period) |
| Request for immediate start at checkout (internal user ID, plan, text version, times of checkout, payment and confirmation email) | 5 years after the account is deleted | Evidence of the request and the withdrawal terms (CRD Art. 14(3) and 16(m); ЗЗП чл. 55) |
| Withdrawals (internal user ID, subscription ID, amounts paid and refunded, posts and credits used, status, dates) | 5 years after the withdrawal | Evidence of the withdrawal and its refund |
| Stripe: customer, invoices, payments, refunds, disputes | Kept by Stripe | Accounting and tax records; managed in Stripe, not by the app |

The internal user ID is a random UUID. Once the account is gone it links to a person only through Stripe (paying
customers) and the records above. Deleting an account (trigger `evidence_account_deleted`) stamps
`account_deleted_at` on its terms acceptances and checkout consents, which starts their 5 years.

Open point for the operator: if withdrawals and checkout consents are treated as accounting records, Bulgarian
accounting law asks for 10 years; change `EVIDENCE_DAYS` (or add a separate constant) and this table together.

## What account deletion does

Settings → Danger zone → Delete account, with the password.

1. Refused while work is in progress: a run being made or a post being published (database trigger `user_busy`).
2. Stripe: a paid subscription is cancelled at once, without a refund of the rest of the month
   (`endPaidAccess`). The dialog tells someone who subscribed in the last 14 days to ask to withdraw first (with its
   refund). If Stripe refuses, nothing is deleted.
3. The account row is deleted. Foreign keys remove sessions, tokens, workspaces, posts, runs, uploads and creators,
   connected social accounts, publications, subscriptions and usage windows, and the billing helper rows.
4. Files: the `media/<user>/` prefix is queued (trigger `user_cleanup`) and removed by the hourly cleanup.
5. Kept: what the table "Kept after the account is deleted" lists.

Posts already published stay on the social networks until the person removes them there.

## Requests from people

There is no self-service data export yet: posts and files can be downloaded in the app, and other access or
portability requests come through the contact form and are answered by hand within one month.

## Logs

Workers Logs carry user, run and publication IDs and short error codes, never email addresses, prompts or provider
messages (`server/error-report.ts` scrubs messages). Keep the Cloudflare log retention at 30 days or less
(docs/OPERATIONS.md).
