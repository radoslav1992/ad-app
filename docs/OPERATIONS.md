# Operations runbook

How to keep hookstreak.com running after launch: what alerts you, where to look, how to handle withdrawals and free
months, and what the maintenance cron does. Setting up from scratch is in [DEPLOYMENT.md](DEPLOYMENT.md); what is kept
for how long is in [PRIVACY.md](PRIVACY.md). Ported from rech-bg's `docs/OPERATIONS.md` and adapted to Hookstreak.

## 1. Signals at a glance

| Signal | Where | What it means |
| --- | --- | --- |
| E-mail "Hookstreak: maintenance needs a look" | inboxes in `ADMIN_EMAILS` | The hourly maintenance found something overdue or suspicious (section 2). |
| Admin → **Operations** | the app | Failures of the last 24 h by area and code, work still open, accounts to reconnect, cleanup queue, Stripe reconciliation, manual checks, the last maintenance run. Same data: `GET /api/admin/operations`. |
| Admin → **Overview** | the app | Users, paying customers (free months counted apart), posts, runs and publications of the last 24 h; which features are configured. |
| `GET /api/health` | external uptime monitor | `200 {"ok":true}` when the Worker runs and D1 answers; `503 {"ok":false}` otherwise. Uncached. |
| Workers Logs | Cloudflare → Workers & Pages → ad-app → Logs | Every log line quoted in this file. |

Point an external uptime check (1–5 minutes, alert on anything but 200) at `https://hookstreak.com/api/health`; it
also catches DNS, certificate and account problems nothing inside Cloudflare can report. If your plan offers alerts on
Workers Logs, alert on `Maintenance attention`, `Maintenance stage failed`, `Storage cleanup refused` and
`Request failed`; the admin e-mail covers the first three without it.

## 2. The hourly summary e-mail

The cron runs every minute (`server/maintenance.ts`); the hourly part runs at minute 17 and **starts** with the
summary (`server/operations.ts`), so a stage that later fails or runs out of time cannot hold it back. When any line
is above zero it logs `Maintenance attention` with the counts and e-mails every valid address in `ADMIN_EMAILS`
(comma separated, at most 10) through the `EMAIL` binding, from `EMAIL_FROM` (`hello@hookstreak.com`):

- at once when the summary differs from the last one sent;
- otherwise at most once every **6 hours** for an unchanged summary;
- nothing once everything is back to zero (the next occurrence is reported again at once).

The last alert (a hash of its lines and the time) is kept in D1 table `operations_state` (key `alert`). A failed send
is logged as `Operator alert not sent` and tried again next hour; it never stops maintenance. Codes in the e-mail are
Hookstreak's own short codes, never provider text.

| Line | Counted | What to do |
| --- | --- | --- |
| AI or render runs still open after 3 hours | `runs` queued/running, created over 3 h 15 min ago | Maintenance fails (and refunds) runs at 3 h every 5 minutes, so it is not reaching them: is the `CONTENT` Workflow binding there, is the cron running? Look the run up in Workers Logs (`runId`) and the `ad-app-content` Workflow. |
| HeyGen / fal / ElevenLabs / Renderer / Other: N failed runs in the last hour (codes) | failed `runs` of the last hour by code prefix (`AVATAR_` HeyGen, `GENERATION_` fal, `VOICE_` ElevenLabs, `RENDERER_*`/`MEDIA_TIMEOUT` renderer), from **3** up | Probably an outage or an account problem at that provider (`*_UNAVAILABLE`: key, plan or balance; `*_BUSY`: rate limits). Check the provider's status page and dashboard. Failures caused by the request itself (`*_REJECTED` content filters, `POST_INVALID`, unreadable files) never count. The credits were refunded. |
| Scheduled posts more than 15 minutes overdue | `publications` scheduled before now − 15 min | The per-minute publishing stage isn't starting them: is the `PUBLISH` Workflow binding there (`Publishing is not configured` in the logs)? |
| Failed publications in the last hour | `publications` failed in the last hour, from **3** up | Admin → Operations groups them by network and message. A network outage, an app review change or revoked permissions (docs/SOCIAL.md). |
| Social accounts that need reconnecting, marked in the last 24 hours | `social_accounts` expired/revoked in the last 24 h, from **5** up | Many at once means a network revoked tokens, the app's credentials changed, or `TOKEN_ENCRYPTION_KEY` changed (never change it). |
| Post stats reads that failed in the last hour | published posts whose last stats read failed (`metrics_error='failed'`), from **5** up | The network's stats API is failing; reads are retried at the next interval (`Post stats failed` in the logs). |
| Speech transcriptions that failed in the last hour | uploads whose speech status became failed (among the 5,000 newest files), from **3** up | Workers AI or the renderer's audio step is failing; people only lose subtitles. Check `Speech not found` in the logs. |
| Storage cleanup waiting for more than 1 day | `cleanup_tasks` older than 1 day | R2 deletes keep failing; check `Maintenance stage failed` with stage `cleanup`. |
| Work set aside for a manual check in the last 24 hours | rows in `manual_reviews` | Section 3. |
| Stripe: failed reconciliations, or paid periods overdue for renewal | the last nightly reconciliation's failures (`Stripe reconciliation failed`), plus active non-cancelling subscriptions whose period ended over 4 days ago | Webhooks are being missed and the backstop can't read Stripe: check the webhook endpoint, its secret and `STRIPE_SECRET_KEY` (DEPLOYMENT.md section 3). |
| Maintenance stages that failed in the last hour | stages that threw in any pass of the last hour (names listed) | Search Workers Logs for `Maintenance stage failed` with that `stage`; the log has the error name, a scrubbed message and the top of the stack. |

The thresholds are constants at the top of `server/operations.ts` (`FAILURE_BURST`, `RECONNECT_BURST`,
`METRICS_BURST`).

## 3. Manual checks (provider work that may still bill)

HeyGen and fal keep working (and billing) after Hookstreak gives up on a run. The run is failed and its credits are
refunded; the hourly stage `reviews` then sets the provider work aside in `manual_reviews`, shown under
**Operations → Set aside for a manual check** with the provider's request ID:

- reason `timeout`: the run failed with `AVATAR_TIMEOUT`, `GENERATION_TIMEOUT` or `MEDIA_TIMEOUT` while a HeyGen video
  or a fal request it started had no stored result;
- reason `uncertain`: `GENERATION_UNCERTAIN` (the request was claimed but its answer was lost, so it may have been
  accepted; there is no request ID);
- reason `failed`: the run failed for another reason (`INTERNAL`) while provider work was open.

What to do: open the provider's dashboard, find the request, and cancel it or note what it billed. Rows are kept 90
days.

Storage cleanup refuses any prefix outside `media/` and `library/` (`drainCleanup`): nothing is deleted, `Storage
cleanup refused` is logged, and the row moves to the same list (area "Storage cleanup", reason `refused`). A refused
row means a bug or a new kind of key; when a feature queues another prefix, extend the check and its test.

## 4. Withdrawal within 14 days

Consumers may withdraw from a paid plan within 14 days of subscribing (CRD Art. 9 and 14(3); ЗЗП чл. 50 and 55).
Before a first checkout they ask for the plan to start at once (`checkout_consents`, text and version in
`shared/withdrawal.ts`); the request is repeated on Stripe's page and confirmed by e-mail after payment (stage
`contracts` retries a failed e-mail hourly for a week).

How a customer asks: the contact form with the topic "Withdraw from my plan (14 days)" (linked from Billing, the
account deletion dialog, the terms and the confirmation e-mail), an e-mail, or the model form in the terms
(`/terms#withdrawal-form`). Such messages show in Admin → Messages with an orange "Withdrawal" chip and are also
forwarded to `ADMIN_EMAILS`.

What to do: Admin → **Billing** → Withdrawal within 14 days.

1. Enter the customer's e-mail and **Check**. The app reads the subscription and its paid invoices from Stripe and
   shows the plan, the start and deadline, what was paid (net of earlier refunds), the posts and AI credits used in the
   paid period and the amount to refund.
2. Tick that the customer withdrew in time, then **End the plan and refund**. In one action the subscription is
   cancelled in Stripe (no further charges), the period's remaining posts and credits stop, and the amount is refunded
   to the original payment (Stripe idempotency key `withdrawal-<id>-<payment>`). The withdrawal is recorded.

The refund is `floor(paid × (quota − used) / quota)` for the meter with the **larger used share** — posts or AI
credits — of the paid period (`withdrawalRefund` in `shared/withdrawal.ts`): a plan gives both side by side, so using
up either one used the plan to that extent. Example: Growth, $49.00, 125 of 500 credits (25%) and 60 of 600 posts
(10%) used → $36.75.

Safeguards: one withdrawal per subscription; the amount must still match what the administrator saw (more use since
then answers 409 "check again"); after 14 days it is refused. If Stripe refuses the refund the plan has still ended,
the withdrawal shows "Refund by hand" and `Withdrawal refund failed` is logged: refund the rest in Stripe. A full
refund or a dispute made directly in Stripe also ends the plan by itself (webhook `charge.refunded` /
`charge.dispute.created`).

## 5. Free months (plan grants)

Admin → **Billing** → Free month of a plan gives a person (they need an account) a paid plan for 30 days without
Stripe: testers, partners, support cases. A grant is a `subscriptions` row with an ID starting `grant_`, so it gets
its own usage window with the plan's full posts and credits and ends by itself. **New month** replaces a running grant
with a fresh one; **End now** ends it.

- A running grant wins over a paid plan unless the person pays for a higher one; afterwards they return to their paid
  plan or the free plan (`allowance` in `server/billing.ts`). Billing shows "Free month" and the end date.
- Grants never reach Stripe: the nightly reconciliation skips them, refunds, disputes and withdrawals never touch their
  window, and the Customer Portal is offered only for a real Stripe subscription.
- If the person also pays in Stripe, the subscription keeps billing while the grant runs; the admin page says so.

## 6. Retention

Hourly stage `retention` (`server/retention.ts`) removes or clears what has expired: sessions, links, rate limits,
OAuth states, contact messages, Stripe event IDs, checkout intents, run details (prompts, provider tickets, input-link
tokens) after 30 days, failed publications' tokens and tickets after 30 days, trial identifiers after 24 months,
evidence records after 5 years, click and sale counts after 13 months, and accounts never confirmed after 30 days.
The periods and why are in [PRIVACY.md](PRIVACY.md); change both (and the privacy policy) together.

## 7. HeyGen stock looks

Admin → Creators → Add library creators → **Browse HeyGen** lists HeyGen's public looks 50 at a time (`GET
/v3/avatars/looks?ownership=public`), loading up to 20 pages per run with Stop and Load more. It filters by gender
(from HeyGen's data), engine (only Avatar III looks are importable) and name or tag, marks looks already in the
library (also switched-off ones) and imports a selection through the same bulk import as pasted IDs, which checks
every look again. Previews come through `/api/admin/heygen/image` (administrators only): HTTPS on `heygen.ai` or
`heygen.com` only (every redirect too), at most 5 MB, JPEG/PNG/WebP by their bytes. Confirm on the page that your
HeyGen plan and terms let you offer stock avatars to your users.

## 8. Migrations and rollback

Apply migrations **before** deploying the code that needs them (`npm run db:remote`). Every migration so far is
additive (new tables, nullable columns, indexes, triggers), so the version already running keeps working on the newer
schema, and a Worker rollback (`npx wrangler rollback`) never needs a schema rollback. `0004_operations.sql` adds
`checkout_consents`, `withdrawals`, `operations_state`, `manual_reviews`, `terms_acceptances.account_deleted_at`, the
trigger `evidence_account_deleted` and the retention/summary indexes. To check it applied:
`npx wrangler d1 migrations list ad-app --remote` shows nothing left, and `PRAGMA table_info(terms_acceptances)` shows
`account_deleted_at`.

D1 keeps 30 days of point-in-time history (`npx wrangler d1 time-travel info|restore ad-app --timestamp=…`). A restore
replaces the whole database, including payments and credits written since: switch `REGISTRATION_ENABLED`,
`BILLING_ENABLED` and `MEDIA_ENABLED` off first, note the current bookmark, and afterwards let the nightly
reconciliation re-read doubtful subscriptions. R2 is not part of Time Travel.

## 9. Logs and privacy

- Keep Workers Logs retention (and any Logpush destination) at **30 days or less**. Logs carry user, run and
  publication IDs and short error codes.
- Request logs record full URLs, including capability links with their token (`/api/render-inputs/…?token=`,
  `/api/upload-inputs/…`, `/api/publish-media/…`). These tokens are short-lived or tied to a running task, but limit
  dashboard access and don't export request logs to third parties without stripping query strings.
- The app's own error logs are scrubbed (`server/error-report.ts`). Unexpected errors are logged as `Request failed`
  with a reference the user sees; search for it when a user quotes it.

## 10. E-mail deliverability (hookstreak.com)

- [ ] Email Sending is active for `hookstreak.com` and its DNS records are present and verified.
- [ ] One SPF record including Cloudflare's sender (and any other service sending as `@hookstreak.com`).
- [ ] DKIM records published and verified; DMARC `p=none` with reports first, then `quarantine`/`reject`.
- [ ] `EMAIL_FROM` (or `CONTACT_EMAIL`) matches `allowed_sender_addresses` in `wrangler.jsonc` (`hello@hookstreak.com`).
- [ ] Send a test alert: with one line above zero (e.g. a cleanup row older than a day in a staging database), the next
      minute-17 run e-mails `ADMIN_EMAILS`; check it lands in the inbox with `spf=pass`, `dkim=pass`, `dmarc=pass`.
