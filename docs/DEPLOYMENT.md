# Deployment

The app deploys as one Cloudflare Worker (with static assets), plus a container image for the renderer. GitHub →
Workers Builds works the same way as for rech-bg: the build runs `npm ci && npm run build`, then `npx wrangler deploy`
(a full deploy, so the container image is published too).

## 1. Cloudflare resources

`wrangler.jsonc` already points at the production database `ad-app` and the bucket `ad-app-media`. On a new Cloudflare
account, create them first and put the new database ID into `wrangler.jsonc`:

```sh
npx wrangler d1 create ad-app            # put the printed database_id into wrangler.jsonc
npx wrangler r2 bucket create ad-app-media
```

Then apply the schema (once, and again whenever a new file lands in `migrations/`):

```sh
npm run db:remote                        # applies every migration not applied yet (0001_initial.sql … 0005_clips.sql)
```

**0002 (analytics):** run `npm run db:remote` *before* deploying the version that uses it. It only adds columns to
`publications` and four new tables, so the version already running keeps working once it is applied. Wrangler records
applied files in `d1_migrations`, so 0001 is not run again. To check: `npx wrangler d1 migrations list ad-app --remote`.
The new social scopes (TikTok `video.list`, Instagram `instagram_business_manage_insights`) need the app changes and
reviews in `docs/SOCIAL.md`; existing connections reconnect to allow stats.

**0004 (operations):** apply it with `npm run db:remote` *before* deploying the version that uses it, like 0002. It
only adds: tables `checkout_consents`, `withdrawals`, `operations_state` and `manual_reviews`, the nullable column
`terms_acceptances.account_deleted_at`, the trigger `evidence_account_deleted` (marks evidence records when an account
is deleted) and indexes for retention and the operations summary. The running version ignores all of them. Without it
the new version's checkout, admin Billing and Operations tabs and the hourly summary fail (`no such table`). Check with
`npx wrangler d1 migrations list ad-app --remote` (nothing left to apply) and
`npx wrangler d1 execute ad-app --remote --command "PRAGMA table_info(terms_acceptances)"` (shows `account_deleted_at`).

**0005 (clips):** rebuilds `posts` and `runs` (new formats `clip` and `story`, the latter for the narrated format that
follows; run kind `speech`), keeping every row, index and trigger. Apply it *before* deploying the version that uses
it, at a quiet moment: while it runs, writes to posts and runs wait. The previous version keeps working on the
rebuilt tables.

- **R2:** add a lifecycle rule to *abort incomplete multipart uploads after 1 day*. Do **not** add an object-expiry
  rule; the app deletes files itself.
- **Workers Paid** is required for Containers and longer CPU time. Containers must be enabled on the account; the
  image is `renderer/Dockerfile`. The first rollout takes a few minutes. The image installs OpenCV
  (`opencv-python-headless`, pinned) and downloads the YuNet face model at a fixed commit, checked against its SHA-256
  (build-time network access to `media.githubusercontent.com`). Each renderer (`standard-2`) needs disk for a 2 GB
  input.
- **Workers AI** is used through the `AI` binding for brand profiles, post ideas and the moments of clips (`TEXT_MODEL`, default
  `openai/gpt-5.6-luna`, the same model rech-bg uses).
- **Email sending:** set up `hookstreak.com` for sending in Cloudflare Email, the same way as `rechbg.com` for
  rech-bg. The sender `hello@hookstreak.com` is already allowed in `wrangler.jsonc`. The same binding sends the
  contract confirmation after checkout and the operations e-mail (below).
- **Operations e-mail:** every address in `ADMIN_EMAILS` gets "Hookstreak: maintenance needs a look" when the hourly
  maintenance finds something overdue or failing, at most every 6 hours for the same state (docs/OPERATIONS.md
  section 2). Nothing to set up beyond `ADMIN_EMAILS` and email sending; check deliverability with the list in
  docs/OPERATIONS.md section 10.
- **Domains:** `wrangler.jsonc` attaches `hookstreak.com`, `www.hookstreak.com`, `hookstreak.app` and
  `www.hookstreak.app` to the Worker as custom domains on deploy (both zones must be on this Cloudflare account,
  with no other DNS records for those names). The Worker sends every host except `SITE_URL`'s to `SITE_URL` with
  the same path (308); `*.workers.dev` keeps working. `SITE_URL` must be the public https origin: the renderer
  only downloads from it, and OAuth redirects and provider input links are built from it.
- **Turnstile:** create a widget for the domain and set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.

## 2. Variables and secrets

Set these in Workers → Settings → Variables and Secrets. `keep_vars` keeps them across deploys.

| Name | Kind | Purpose |
| --- | --- | --- |
| `SITE_URL` | text | Public origin, `https://hookstreak.com` |
| `COMPANY_NAME`, `COMPANY_ADDRESS`, `CONTACT_EMAIL` | text | Operator shown on legal pages (required before sign-ups) |
| `EMAIL_FROM`, `ADMIN_EMAILS` | text | Sender (defaults to `CONTACT_EMAIL`); comma-separated admin emails (verified accounts become admins; they also get the operations e-mail and contact messages) |
| `REGISTRATION_ENABLED`, `BILLING_ENABLED`, `MEDIA_ENABLED` | text | `true` to open sign-ups, payments, rendering/AI |
| `TRIAL_HASH_SECRET` | secret | Long random string |
| `TURNSTILE_SECRET_KEY` / `TURNSTILE_SITE_KEY` | secret / text | Bot checks |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | secret | Stripe |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO` | text | Monthly USD prices ($29 / $49 / $149) |
| `STRIPE_AUTOMATIC_TAX` | text | `true` when Stripe Tax is set up |
| `FAL_KEY` | secret | AI images (`fal-ai/nano-banana-2`) and clips (`fal-ai/kling-video/v2.5-turbo/pro/text-to-video`) |
| `ELEVENLABS_API_KEY` | secret | Voices (`eleven_v3`, text to speech with timestamps) and speech to text (`scribe_v2`: subtitles, cuts, clips; it fetches uploads from `SITE_URL`) |
| `ELEVENLABS_VOICES` | text | Optional JSON overriding the voice mapping in `server/voices.ts` |
| `HEYGEN_API_KEY` | secret | Talking creators (v3 videos; Avatar III for linked looks, photo animation otherwise) |
| `TEXT_MODEL` | text | Optional Workers AI model override |
| `TOKEN_ENCRYPTION_KEY` | secret | `openssl rand -base64 32`; encrypts social tokens. Never change it once accounts are connected |
| `TIKTOK_CLIENT_KEY`/`_SECRET`, `INSTAGRAM_APP_ID`/`_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET`, `LINKEDIN_CLIENT_ID`/`_SECRET` | secret | Social apps (docs/SOCIAL.md) |

### The first values for hookstreak.com

`SITE_URL` (`https://hookstreak.com`) and `CONTACT_EMAIL` (`hello@hookstreak.com`, also the sender) are set in
`wrangler.jsonc`. To open sign-ups, add these in the dashboard; AI, Stripe and the networks can follow.

| Name | Value |
| --- | --- |
| `COMPANY_NAME`, `COMPANY_ADDRESS` | Your legal entity and address, as they should appear on the legal pages |
| `ADMIN_EMAILS` | The address you sign up with (dashboard only: the repository is public) |
| `TRIAL_HASH_SECRET`, `TOKEN_ENCRYPTION_KEY` | Secrets: each the output of `openssl rand -base64 32` |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | From a Turnstile widget for `hookstreak.com` |
| `REGISTRATION_ENABLED` | `true`, last |

## 3. Stripe

1. Create one product per plan, each with a **monthly USD price**: Starter $29, Growth $49, Pro $149. The checkout
   refuses a price whose amount, currency or interval doesn't match `shared/plans.ts`.
2. Add a webhook endpoint at `${SITE_URL}/api/billing/webhook` with these events:
   - `checkout.session.completed`
   - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`
   - `invoice.paid` and `invoice.payment_failed`
   - `charge.refunded` and `charge.dispute.created`
3. Configure the Customer Portal: cancellations, card updates, and switching between the three prices.
4. Nothing else is needed for withdrawals: a first checkout asks for the express request to start at once (shown again
   on Stripe's page as custom text, confirmed by e-mail), and refunds for withdrawals are made from Admin → Billing
   with the same secret key (docs/OPERATIONS.md section 4).

## 4. Content library (as an admin)

Sign in with an address in `ADMIN_EMAILS` (verified), then open **Admin**. Upload:

- **Music:** licensed tracks for commercial use, tagged by mood.
- **Clips:** short vertical reaction, activity and filler clips. Tag them, e.g. `reaction, woman`. Wall of Text and
  Video Hook & Demo use them.
- **Green screens:** creators filmed on green. Tag a different key colour as `chroma:#00ff00`.
- **Creators:** a portrait, or HeyGen avatar looks that support Avatar III. Imported looks use the cheaper library
  rate.
  - *HeyGen looks* takes many look IDs at once: one per line or comma separated, up to 500 per paste, sent 10 at a
    time. Each look is checked with HeyGen, named after the look and given its preview as the portrait. Looks already
    in the library are skipped. Every ID gets its own result: imported, already in the library, can't be used (and
    why), or failed for now (put the failed IDs back in the box and run again).
  - *One look, with details* imports a single look with your own name and description.
  - The list below searches names and descriptions and filters by gender, on/off and kind. Select rows to switch them
    on or off or to set their gender in one go. Switched-off creators leave people's lists; posts already made keep
    them.
  - *Browse HeyGen* pages through HeyGen's stock looks with previews, filters by gender and engine (only looks with
    Avatar III can be imported), marks looks already in the library and imports a selection through the same bulk
    import. Before adding HeyGen's stock avatars, check that your HeyGen plan and terms allow using them through the
    API in your product; the page asks you to confirm it.

You need the rights to everything you upload, including permission for every person shown.

## 5. Turn it on

1. Deploy, then check `GET /api/health`.
2. Set `MEDIA_ENABLED=true` once the container image is deployed and the AI keys are set.
3. Set `REGISTRATION_ENABLED=true`, and `BILLING_ENABLED=true` once Stripe is configured.
4. **Smoke test**, before announcing:
   1. Sign up and confirm the email.
   2. Onboard with a real website.
   3. Generate a batch in Blitz.
   4. Approve a post.
   5. Create a Wall of Text and an AI UGC post.
   6. Connect one account per network and publish a test post (private where the network allows).
   7. Buy and cancel a plan in Stripe test mode; check the confirmation e-mail.
   8. Buy another, then withdraw it from Admin → Billing (the refund shows in Stripe) and give yourself a free month.

## Known limits

- **Untested against real services:** the AI providers, the social networks (publishing and post stats) and Stripe are
  covered by tests with mocked responses only. None has been tried with live keys.
- **Sale reports are unauthenticated:** the site key in the snippet is public, so reports are rate-limited and deduped
  but not verified. They only change that workspace's analytics.
- **Renderer image:** the image has not been built in this environment (no Docker daemon); CI builds it. Its tests
  ran on FFmpeg 6.1, while the image uses Debian bookworm's FFmpeg 5.1.
- **Social platform review:** each network has review steps; until TikTok audits the app, posts may be private.
  See docs/SOCIAL.md.
- **Live trends:** there is no live trend or "remix" data from the networks. Ideas are built on the curated hook
  patterns.
- **Legal pages:** the terms and privacy policy are a starting point; have them reviewed for your business and
  markets — in particular the withdrawal section (14 days, refund less the larger used share of posts or credits)
  and the retention periods (docs/PRIVACY.md).
- **HeyGen stock list:** the browse view follows rech-bg's use of `GET /v3/avatars/looks?ownership=public`; it is
  tested against mocked responses (three list shapes), not against HeyGen's live catalogue.
- **Talking creator prices:** these are estimated from the script length (about 15 characters per second).
- **Speech to text:** Scribe reads files by URL (`source_url`, files under 2 GB); free transcription is capped at 20
  files and 30 minutes per person and day. Face tracking was tested on generated videos and a still face, not on real
  podcast footage.
