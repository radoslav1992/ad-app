# Deployment

The app deploys as one Cloudflare Worker (with static assets), plus a container image for the renderer. GitHub →
Workers Builds works the same way as for rech-bg: the build runs `npm ci && npm run build`, then `npx wrangler deploy`
(a full deploy, so the container image is published too).

## 1. Cloudflare resources

```sh
npx wrangler d1 create ad-app            # put the printed database_id into wrangler.jsonc
npx wrangler r2 bucket create ad-app-media
npm run db:remote                        # applies migrations/0001_initial.sql
```

- **R2:** add a lifecycle rule to *abort incomplete multipart uploads after 1 day*. Do **not** add an object-expiry
  rule; the app deletes files itself.
- **Workers Paid** is required for Containers and longer CPU time. Containers must be enabled on the account; the
  image is `renderer/Dockerfile`. The first rollout takes a few minutes.
- **Workers AI** is used through the `AI` binding for brand profiles and post ideas (`TEXT_MODEL`, default
  `openai/gpt-5.6-luna`, the same model rech-bg uses).
- **Email Sending:** verify your domain, then add `"allowed_sender_addresses": ["hello@your-domain"]` to the
  `send_email` binding in `wrangler.jsonc` and set `EMAIL_FROM`.
- **Custom domain:** add a `routes` entry in `wrangler.jsonc` and set `SITE_URL=https://your-domain`. `SITE_URL`
  must be the public https origin: the renderer only downloads from it, and OAuth redirects and provider input
  links are built from it.
- **Turnstile:** create a widget for the domain and set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.

## 2. Variables and secrets

Set these in Workers → Settings → Variables and Secrets. `keep_vars` keeps them across deploys.

| Name | Kind | Purpose |
| --- | --- | --- |
| `SITE_URL` | text | Public origin, e.g. `https://postloop.app` |
| `COMPANY_NAME`, `COMPANY_ADDRESS`, `CONTACT_EMAIL` | text | Operator shown on legal pages (required before sign-ups) |
| `EMAIL_FROM`, `ADMIN_EMAILS` | text | Sender; comma-separated admin emails (verified accounts become admins) |
| `REGISTRATION_ENABLED`, `BILLING_ENABLED`, `MEDIA_ENABLED` | text | `true` to open sign-ups, payments, rendering/AI |
| `TRIAL_HASH_SECRET` | secret | Long random string |
| `TURNSTILE_SECRET_KEY` / `TURNSTILE_SITE_KEY` | secret / text | Bot checks |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | secret | Stripe |
| `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_PRO` | text | Monthly USD prices ($29 / $49 / $149) |
| `STRIPE_AUTOMATIC_TAX` | text | `true` when Stripe Tax is set up |
| `FAL_KEY` | secret | AI images (`fal-ai/nano-banana-2`) and clips (`fal-ai/kling-video/v2.5-turbo/pro/text-to-video`) |
| `ELEVENLABS_API_KEY` | secret | Voices (`eleven_v3`, text to speech with timestamps) |
| `ELEVENLABS_VOICES` | text | Optional JSON overriding the voice mapping in `server/voices.ts` |
| `HEYGEN_API_KEY` | secret | Talking creators (v3 videos; Avatar III for linked looks, photo animation otherwise) |
| `TEXT_MODEL` | text | Optional Workers AI model override |
| `TOKEN_ENCRYPTION_KEY` | secret | `openssl rand -base64 32`; encrypts social tokens. Never change it once accounts are connected |
| `TIKTOK_CLIENT_KEY`/`_SECRET`, `INSTAGRAM_APP_ID`/`_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET`, `LINKEDIN_CLIENT_ID`/`_SECRET` | secret | Social apps (docs/SOCIAL.md) |

## 3. Stripe

1. Create one product per plan, each with a **monthly USD price**: Starter $29, Growth $49, Pro $149. The checkout
   refuses a price whose amount, currency or interval doesn't match `shared/plans.ts`.
2. Add a webhook endpoint at `${SITE_URL}/api/billing/webhook` with these events:
   - `checkout.session.completed`
   - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`
   - `invoice.paid` and `invoice.payment_failed`
   - `charge.refunded` and `charge.dispute.created`
3. Configure the Customer Portal: cancellations, card updates, and switching between the three prices.

## 4. Content library (as an admin)

Sign in with an address in `ADMIN_EMAILS` (verified), then open **Admin**. Upload:

- **Music:** licensed tracks for commercial use, tagged by mood.
- **Clips:** short vertical reaction, activity and filler clips. Tag them, e.g. `reaction, woman`. Wall of Text and
  Video Hook & Demo use them.
- **Green screens:** creators filmed on green. Tag a different key colour as `chroma:#00ff00`.
- **Creators:** a portrait, or *Import from HeyGen* with an avatar look ID that supports Avatar III. Imported looks
  use the cheaper library rate.

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
   7. Buy and cancel a plan in Stripe test mode.

## Known limits

- **Untested against real services:** the AI providers, the social networks and Stripe are covered by tests with
  mocked responses only. None has been tried with live keys.
- **Renderer image:** the image has not been built in this environment (no Docker daemon); CI builds it. Its tests
  ran on FFmpeg 6.1, while the image uses Debian bookworm's FFmpeg 5.1.
- **Social platform review:** each network has review steps; until TikTok audits the app, posts may be private.
  See docs/SOCIAL.md.
- **Live trends:** there is no live trend or "remix" data from the networks. Ideas are built on the curated hook
  patterns.
- **Legal pages:** the terms and privacy policy are a starting point; have them reviewed for your business and
  markets.
- **Talking creator prices:** these are estimated from the script length (about 15 characters per second).
