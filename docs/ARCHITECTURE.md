# Architecture

## Stack

React 19 + React Router + Vite (client, `src/`), a Hono Worker (`server/`), Cloudflare D1 (one schema in
`migrations/0001_initial.sql`), a private R2 bucket (`MEDIA`), three Workflows, a Containers pool of three FFmpeg
renderers (`renderer/server.py`) and the Workers AI binding for text. Contracts shared by the client and server live
in `shared/` (formats/specs, plans and credits, captions and on-screen text layout, schedule, renderer payloads).

## From website to brand profile

`POST /api/workspaces/:id/analyze` stores the website (or description) and starts **WorkspaceScan**
(`server/scan-workflow.ts`):

1. **website:** reads the homepage and up to two key pages (`server/scan.ts`). Fetches are limited to public
   http(s) hosts: no IP literals or internal names, every redirect re-checked, at most 2 MB per page, timeouts on
   each. An App Store link uses Apple's lookup API; a Google Play listing is read as a single page.
2. **profile:** a text model writes the brand profile from the pages, which are passed as data and never as
   instructions. The owner's company name and onboarding answers win. Without the model, a plain profile is built
   from the page metadata.
3. **images:** up to 10 website images are saved as brand images. Each must be JPEG, PNG or WebP, at least 320 px
   and at most 4096 px on a side; duplicates are skipped.

`scan_step` lets the onboarding show "Preparing workspace · Website · Profile" while the person answers questions.

## From idea to finished post

1. **Write.** `POST /api/workspaces/:id/batch` (Blitz, automations) or `/ideas` (manual drafts) loads the workspace's
   media catalogue: images, uploaded videos, library clips, green screens, music and creators. It plans the formats in
   turn, and the text model writes one post per slot (`server/ideas.ts`), referring to media by short codes (`img3`,
   `clip2`). `conceptToSpec` maps codes back to IDs, falls back safely (another image, the brand colour) and
   validates the result against the post schema (`shared/formats.ts`).
2. **Reserve.** Each post is one transaction (`server/posts.ts`): a `posts` row (the plan's post quota, trigger
   `post_quota`) and a `runs` row (AI credits, trigger `run_credit_reserve`). Rendering is free; credits pay only for
   AI images/clips (`specCredits`) and talking creators (voice + lip-synced video, estimated from the script).
3. **Make.** **ContentGeneration** (`server/content-workflow.ts`) works through these stages:
   - **AI images and clips (fal):** the generated asset IDs are written back into the spec.
   - **Talking creator:** an ElevenLabs voice with timings, then a HeyGen video lip-synced to that voice.
   - **Render:** `server/render-plan.ts` turns the spec into a renderer payload of segments, music with ducking, an
     optional green-screen overlay, and ASS captions/text from `shared/overlay.ts` + `shared/caption-scene.ts`. The
     container renders the MP4 and a cover; slideshows also get JPEG slides.
   - **Save:** files from earlier versions of the post are deleted.
4. **Review.** Blitz lists ready, pending posts. Approving can auto-schedule (`autoSchedule` in
   `server/publishing.ts`).

Paid provider calls are made once. A claim is stored in `runs.provider` before the call and the ticket right after,
so a retried step polls instead of paying again. A claim without a ticket fails the run; the exception is HeyGen,
which is re-sent with the same `Idempotency-Key`. A failed run is refunded exactly once by the `run_refund` trigger.
Maintenance re-dispatches runs whose workflow never started and fails runs stuck for 3 hours.

Inputs reach the renderer, HeyGen and fal only through capability links: `/api/render-inputs/:run/:n?token=`, valid
while the run works and for at most 6 hours, and only for the owner's or library files. The renderer refuses any
other origin or path.

## Publishing

`publications` rows are claimed by the cron every minute (`dispatchDue`). Each claimed publication starts a
**Publication** workflow (`server/publish-workflow.ts`). The workflow refreshes the token if needed, then publishes
once: a checkpoint is saved before any call that makes a post public, so a retried step resumes instead of
reposting. It then polls the network and records the URL. TikTok and Instagram fetch media from
`/api/publish-media/:id/:n?token=`, which works only while that publication is publishing. OAuth tokens are
AES-GCM-encrypted with `TOKEN_ENCRYPTION_KEY`. See `docs/SOCIAL.md`.

## Accounts, plans and credits

Auth, sessions, rate limits and Stripe come from rech-bg. Each paid period is a usage window
(`user:subscription:period_start`); the trial is one lasting window, once per mailbox (HMAC with
`TRIAL_HASH_SECRET`).
- **Upgrades** add only the unused share of the difference for the rest of the period.
- **Webhooks** always read the current state back from Stripe.
- **A nightly reconciliation** catches missed events.
- **Storage** is limited per plan by a trigger.

## Safety and privacy

- **Requests:** CSRF uses an exact Origin check on every state change. Sessions are HttpOnly cookies, and the server
  stores only a SHA-256 of each token. Passwords use PBKDF2-SHA256.
- **Untrusted text:** website content, prompts and model answers are treated as data. Model output is cleaned and
  schema-validated before use.
- **Logs:** provider messages are never logged or shown; failures become short codes with plain-English messages.
- **AI marking:** AI-made media is marked in its MP4/JPEG metadata (IPTC digital source type).
- **Deletion:** deleting posts, files, creators or accounts queues R2 cleanup. Work in progress is protected by
  triggers.
