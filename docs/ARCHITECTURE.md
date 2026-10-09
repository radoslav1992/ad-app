# Architecture

## Stack

React 19 + React Router + Vite (client, `src/`), a Hono Worker (`server/`), Cloudflare D1 (the schema in
`migrations/`: `0001_initial.sql`, then files that add to it, and `0005_clips.sql`, which rebuilds `posts` and `runs`
for clips and paid speech; see below), a private R2 bucket (`MEDIA`), three Workflows, a Containers pool of three
FFmpeg renderers (`renderer/server.py`, with OpenCV for face tracking) and the Workers AI binding for text. Contracts shared by the client and server live
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

**Text, captions and subtitles** are one description shared by the render and the editor's preview. On-screen
text (`TextLook`) has an optional entrance animation (none, fade, pop, rise, words) that `overlayItems` writes as
keyframes on the caption items, from each block's start; libass gets them as `\move`/`\t` events and the browser
draws the same items on a canvas (`src/app/caption-canvas.ts`, ported from rech-bg) with the same fonts. All but the
word-by-word reveal are over within 0.6 s; that one is paced to the text and done by 40% of the block. Stills are
drawn without animation and the cover is taken once the first text is fully shown. AI UGC captions use one of the
twenty caption styles (`captionStyle`); the writer picks one per post and never repeats one within a batch.

**Speech in uploads** (ported from rech-bg). An uploaded video or track is transcribed by ElevenLabs Scribe v2
(`server/speech.ts`: `POST /v1/speech-to-text`, `model_id=scribe_v2`, `timestamps_granularity=word`, no
`language_code`, so the language is detected and kept). Scribe reads the file itself from a capability link
(`/api/upload-inputs/:id?token=`, valid while the transcription is pending, 3 hours at most). Only real words are
kept, in time order and within the file, in `media_assets.meta.transcript` (`{language, words}`, at most 30,000);
lists never carry them, `GET /api/media/:id?from=&to=` gives one moment's words. The call is made once: a claim is
stored before it, so a step that runs again stops instead of paying twice.
- **Free:** files up to 10 minutes, right after their check (or "Find speech"), within 20 files and 30 minutes per
  person and day. A failure only means no subtitles.
- **Paid:** longer videos (paid plans upload up to 2 hours, 1.9 GB) are transcribed on request, `POST
  /api/media/:id/transcribe` with the price the person was shown (`speechCredits`: 1 credit per started 10 minutes).
  It is a run of kind `speech`: credits reserved by the insert, refunded by `run_refund` when it fails, one active per
  file (unique index).

Where speech is used:
- **Subtitles:** a hook & demo, or a wall of text whose own clip keeps its sound, can switch on `subtitles` (off by
  default). The plan places the words heard in the used part of the clip on the output clock in the chosen caption
  style; the writer switches them on when its demo has speech.
- **Instant cuts** (`shared/cuts.ts`, rech-bg's "Мигновен монтаж"): with `cuts` on, a talking demo or a clip keeps
  only its speech with a little air: pauses over 0.6 s (and, with `fillers`, "um"/"uh"/"erm") are cut. The kept
  ranges are snapped to the 1/30 s frame grid and the preview computes the same ranges, so both cut at the same
  places. The renderer selects them from one input (picture by frame, sound in 160-sample blocks), so picture and
  sound stay the same length; subtitles move with the cuts and words a cut runs through are dropped.

**Clips from a long video** (rech-bg's "Кратки клипове", the Clips page). `POST /api/shorts/moments` numbers the
transcript by sentence and asks the text model for its strongest self-contained moments of 15–60 s, with a hook title,
why it works and post text (a long transcript is read in parts of 24,000 characters, in parallel, best of each part
first). Picks are checked: on sentence edges, inside the video, 12–75 s, not overlapping. 20 successful searches a
day; the latest moments are kept with the video. Each chosen moment becomes a `clip` post (`POST /api/posts`, so it
goes to Blitz): the moment of the video with its own sound, cut, captions of what is said and the hook title for 3 s.
**Follow the speaker** (`shared/track.ts`): before the render, the renderer's `track` operation finds the main face
in the moment (OpenCV YuNet at 4 samples a second, hard cuts from FFmpeg's scene score) and returns a path of crop
keyframes. It is kept with the post (`spec.tracked`, server-owned, for that moment), and the render crops the wide
video to 9:16 around it; no face, a video no wider than 9:16, or a failure leaves the picture centred.

**Migration 0005.** D1 always enforces foreign keys and runs a migration in one transaction, and `DROP TABLE`
deletes every row first, which would cascade to `runs`, `media_assets` and `publications` (and queue their files for
deletion) even with `defer_foreign_keys`. So `posts` and `runs` are copied aside, their keys are moved (`'~'||id`) so
no child row matches, the tables are dropped and recreated, and the copies are put back under the original keys,
which resolves the deferred violations before the commit. Indexes and triggers are recreated word for word
(`tests/shorts.test.ts` proves it with rows in every child table).

Paid provider calls are made once. A claim is stored in `runs.provider` before the call and the ticket right after,
so a retried step polls instead of paying again. A claim without a ticket fails the run; the exception is HeyGen,
which is re-sent with the same `Idempotency-Key`. A failed run is refunded exactly once by the `run_refund` trigger.
Maintenance re-dispatches runs whose workflow never started and fails runs stuck for 3 hours.

Inputs reach the renderer, HeyGen, fal and Scribe only through capability links: `/api/render-inputs/:run/:n?token=`, valid
while the run works and for at most 6 hours, and only for the owner's or library files. The renderer refuses any
other origin or path.

## Publishing

`publications` rows are claimed by the cron every minute (`dispatchDue`). Each claimed publication starts a
**Publication** workflow (`server/publish-workflow.ts`). The workflow refreshes the token if needed, then publishes
once: a checkpoint is saved before any call that makes a post public, so a retried step resumes instead of
reposting. It then polls the network and records the URL. TikTok and Instagram fetch media from
`/api/publish-media/:id/:n?token=`, which works only while that publication is publishing. OAuth tokens are
AES-GCM-encrypted with `TOKEN_ENCRYPTION_KEY`. See `docs/SOCIAL.md`.

## Analytics

- **Post stats.** Every 5 minutes the cron reads a bounded batch of published posts' lifetime views, likes, comments
  and shares from the networks (`server/metrics.ts`, `stats()` in each network client): new posts every 3 hours for two
  days, then daily, for 30 days. They are stored on `publications` (`views` … `metrics_at`, `metrics_error`). A
  number a network doesn't report stays NULL and shows as "–"; LinkedIn shares none.
- **Tracked links.** `/go/<code>` redirects to the workspace's own target URL with UTM tags and `hs=<code>`, and counts
  clicks per link and UTC day (`tracked_links`, `link_clicks`). Captions on YouTube and LinkedIn can carry the post's
  link; TikTok and Instagram get one "link in bio" each.
- **Sales.** The customer's site loads `/t.js`, which remembers the last `hs` code for 30 days in that site's
  localStorage and reports sales to `POST /api/t/<site key>` (also callable from their server). Sales are credited to
  the post and network of that link (`conversions`); unmatched ones count as "not from a tracked link".
- **The page.** `GET /api/workspaces/:id/analytics?days=7|30` adds the stored numbers up (totals, per network, per
  post, per day; money per currency, never converted). Details and limits: `docs/SOCIAL.md`.

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
- **Tracking:** click and sale counting keeps no visitor data (no IP addresses, cookies or fingerprints; order IDs only
  as hashes). The public tracking routes answer before the Origin check with their own CORS headers and a
  `default-src 'none'` policy, and a link can only lead to its workspace's checked address.
- **AI marking:** AI-made media is marked in its MP4/JPEG metadata (IPTC digital source type). The saved render also
  carries `{"ai":true}` in `media_assets.meta`, which sets the networks' AI labels on publishing (TikTok `is_aigc`,
  YouTube `containsSyntheticMedia`).
- **Deletion:** deleting posts, files, creators or accounts queues R2 cleanup. Work in progress is protected by
  triggers.
