# Postloop

Short-form content on autopilot. Paste your website (or an App Store / Google Play link) and get finished TikToks, Reels,
Shorts and LinkedIn posts made for your brand. Swipe to approve them in **Blitz**; they publish themselves on your schedule.

"Postloop" is a working name, kept in one place (`shared/brand.ts`, plus `index.html` and `public/favicon.svg`).

Built on the same stack as [rech-bg](https://github.com/radoslav1992/rech-bg): Cloudflare Workers (Hono), D1, R2,
Workflows, Containers (FFmpeg) and Workers AI, with Stripe billing. Much of rech-bg's code is reused here:
- auth and sessions, rate limits;
- the Stripe usage windows, webhooks and reconciliation;
- the caption engine and the libass/ASS renderer;
- the ElevenLabs voice and HeyGen talking-avatar pipelines;
- chunked uploads and the maintenance cron.

## What it does

- **Onboarding (8 steps).** Company name and logo come first. Next is the brand analysis, from a website or app store link, or a written description; it runs in the background while you answer a few questions about yourself and your business. The last step shows the two ways to create content.
- **Brand profile.** The website scan reads up to 3 pages: the homepage and up to two key pages (about, pricing, features). A text model turns them into the profile: product, audience, value props, pain points, tone, CTA and colours. The best website images are saved as brand images. Everything stays editable.
- **Five formats.**
  - **Slideshow:** photo carousel with bold text.
  - **Wall of Text:** a thought written over a reaction or b-roll clip.
  - **Video Hook & Demo:** a 3-second reaction, then your product demo.
  - **Green Screen Meme:** a creator keyed over your screenshot.
  - **AI UGC:** an AI creator talking to camera, with word-by-word captions.
- **Blitz.** Finished posts are shown one at a time. Swipe or use ←/→ to skip or approve, and Z to undo. "Why this content?" explains the hook pattern each post is built on. Approved posts can schedule themselves into the next free slot.
- **Create.** Pick the format, media, style and topic, and whether to mention the brand; then *Generate*. Edit the words and the text look (weight, size, colour, stroke, box, position) with a live preview that uses the renderer's own fonts and layout. Save, and it renders in the background.
- **Calendar and auto-publishing.** You connect TikTok, Instagram, YouTube and LinkedIn with OAuth; tokens are stored encrypted. Posting times are set per weekday in the workspace's time zone. A cron publishes due posts every minute: slideshows go out as photo carousels where the network supports them, everything else as video.
- **Automations.** Fresh posts for review every day, only while the review queue is short.
- **AI Studio and Creators.** AI images, and AI creators made from a description or from your own photo (with consent).
- **Library.** Your uploads and brand images. Administrators fill a shared library of music, reaction/b-roll clips and green-screen clips, plus library creators (a portrait or an imported HeyGen avatar).
- **Plans.** Free 7-day trial (15 posts, 10 AI credits), then Starter ($29/mo), Growth ($49/mo) and Pro ($149/mo). Posts and AI credits are reserved and refunded by D1 triggers; rendering a post costs no credits. See `shared/plans.ts` and `shared/credits.ts`.

Hook patterns (`shared/hooks.ts`) are curated, proven structures — the app does not claim live trend data, view counts
or testimonials.

## Local development

Node.js 24 and npm:

```sh
npm ci
cp .dev.vars.example .dev.vars   # fill in what you need
npm run db:local
npm run preview                  # builds the client and runs the Worker on :8787
```

For hot reload keep the Worker running and run `npm run dev` in another terminal, with `SITE_URL=http://localhost:5173`
in `.dev.vars`.

Checks (the same as CI):

```sh
npm run ci                        # typecheck, lint, tests, build, bundle budget
python3 tests/renderer_test.py    # renderer (needs ffmpeg)
npx wrangler deploy --dry-run --no-autoconfig
```

The tests run the real Hono routes, SQL schema and triggers, and the content and publishing workflows against local
SQLite/R2 stand-ins with mocked providers. They are not a substitute for a smoke test with real keys.

## Docs

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Cloudflare, Stripe, AI providers, turning features on.
- [docs/SOCIAL.md](docs/SOCIAL.md): developer apps and reviews for TikTok, Instagram, YouTube and LinkedIn.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how a post is made and published, credits, safety.
- [docs/DESIGN.md](docs/DESIGN.md): the look and the onboarding/dashboard flow.
