# Social accounts and auto-publishing

People connect TikTok, Instagram, YouTube and LinkedIn accounts to a workspace (OAuth), schedule approved posts (or let
the swipe review drop them into the workspace's next free slot), and a cron + Workflow publishes them.

| Piece | Where |
| --- | --- |
| Connect / list / disconnect accounts | `server/accounts.ts` (`/api/accounts`) |
| Schedule, calendar, move, cancel, retry | `server/publishing.ts` (`/api/posts/:id/schedule`, `/api/workspaces/:id/calendar`, `/api/publications/:id`) |
| Media links the networks fetch | `server/publishing.ts` (`/api/publish-media/:publication/:n?token=`) |
| Due posts → workflow (cron, every minute) | `dispatchDue(env)` in `server/publishing.ts` |
| Publishing one post | `Publication` workflow, `server/publish-workflow.ts` |
| Network clients | `server/social/{tiktok,instagram,youtube,linkedin}.ts` |
| Token encryption | `server/crypto.ts` (AES-256-GCM) |

## Environment

| Variable | What |
| --- | --- |
| `SITE_URL` | Public `https://` origin. Redirect URIs and media links are built from it. |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes, base64: `openssl rand -base64 32`. Encrypts every OAuth token at rest. Changing it disconnects every account (people reconnect). |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | TikTok app. |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | The Instagram app ID/secret of the Meta app (Instagram product, not the Facebook app ID). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client (Web application). |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | LinkedIn app. |

Set them as Worker secrets (`npx wrangler secret put …`). A network without credentials shows as "not configured" and
cannot be connected; without `TOKEN_ENCRYPTION_KEY` none can.

**Redirect URI** for every network (register it exactly, no trailing slash):

```
${SITE_URL}/api/accounts/callback/tiktok
${SITE_URL}/api/accounts/callback/instagram
${SITE_URL}/api/accounts/callback/youtube
${SITE_URL}/api/accounts/callback/linkedin
```

For local development register the `http://localhost:8787/...` variants where the network allows http (TikTok and
Meta require https: use a tunnel such as `cloudflared tunnel --url http://localhost:8787` and set `SITE_URL` to it).

## TikTok (Login Kit + Content Posting API)

1. developers.tiktok.com → Manage apps → create an app. Platform: Web. Fill in the terms and privacy policy URLs
   (`${SITE_URL}/terms`, `${SITE_URL}/privacy`).
2. Add products **Login Kit** and **Content Posting API**. In Content Posting API turn on **Direct Post**.
3. Scopes: `user.info.basic`, `video.publish`.
4. Login Kit → Redirect URI: `${SITE_URL}/api/accounts/callback/tiktok`.
5. **Verify the media domain** (URL properties): photo posts use `PULL_FROM_URL`, so TikTok downloads each slide from
   `${SITE_URL}/api/publish-media/...`. Verify the `SITE_URL` domain (DNS TXT record) or the URL prefix
   `${SITE_URL}/api/publish-media/`. Without it photo posts fail with "Publishing to TikTok is not set up right now"
   (`url_ownership_unverified`). Videos are uploaded as files and need no verification.
6. Submit the app for review, then apply for the **Direct Post audit**.

Before the audit (unaudited client): at most 5 users can post in 24 hours, every post is private (`SELF_ONLY`), and
the posting account must itself be set to private. The publisher picks `PUBLIC_TO_EVERYONE` when TikTok offers it and
otherwise the first allowed level; when TikTok refuses a public post from an unaudited app it retries once as
`SELF_ONLY`, and if that is refused too the person is told to make the account private.

The audit checks TikTok's Content Sharing Guidelines in the UI: the creator's nickname and avatar shown before
posting, the privacy level **chosen by the person (no default)**, comment/duet/stitch toggles respecting
`creator_info`, the commercial content disclosure, a preview, and the consent line ("By posting, you agree to TikTok's
Music Usage Confirmation"). Fully automatic publishing needs those choices made once per account in our UI and stored
(see "Open items"); expect the audit to ask about it.

Tokens: access 24 hours, refresh 365 days (renewed automatically when publishing). Uploads go in 10 MiB chunks
(TikTok: 5–64 MB per chunk, the last up to 128 MB, `total_chunk_count = floor(size / chunk_size)`).

## Instagram (Instagram API with Instagram Login)

1. developers.facebook.com → create an app, use case "Manage messaging & content on Instagram" (type Business).
2. Add the **Instagram** product → "API setup with Instagram business login". Note the **Instagram app ID and secret**
   shown there (these are `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`).
3. Business login settings → OAuth redirect URI: `${SITE_URL}/api/accounts/callback/instagram`.
4. Permissions: `instagram_business_basic`, `instagram_business_content_publish`.
5. **App Review**: request Advanced Access for both permissions (screencast of connecting and publishing), and complete
   **Business Verification**. Until then only people with a role on the app (and test users) can connect.

Only **professional accounts** (Business or Creator) work; personal accounts cannot log in through this flow. Reels
are 3 s–15 min; carousels take up to 10 images (JPEG). Instagram downloads the media from our media links, which work
only while the post is publishing and for at most 24 hours. Accounts have a rolling 24-hour publishing limit
(`/{ig-user-id}/content_publishing_limit`); hitting it shows "Instagram is limiting how often this account can post".

Tokens: long-lived (60 days), renewed in their last 10 days when publishing and by `refreshAccounts(env)` (run it
daily from maintenance so quiet accounts stay connected). Graph API version: `v23.0` (`server/social/instagram.ts`).

## YouTube (Google OAuth + YouTube Data API v3)

1. console.cloud.google.com → new project → enable **YouTube Data API v3**.
2. OAuth consent screen (Google Auth Platform): External; app name, support email, logo, home page, privacy policy,
   terms; authorized domain = your domain. Scopes: `https://www.googleapis.com/auth/youtube.upload` and
   `https://www.googleapis.com/auth/youtube.readonly` (both "sensitive").
3. Clients → create OAuth client ID, type **Web application**; authorized redirect URI:
   `${SITE_URL}/api/accounts/callback/youtube`.
4. Publish the app and submit for **verification** (sensitive scopes: demo video, privacy policy).
5. Fill in the **YouTube API Services audit and quota extension** form.

Limits until then:

- **Testing** status: only listed test users can connect, and their refresh tokens expire after 7 days.
- **Unverified** app: people see the "Google hasn't verified this app" warning, and at most 100 users can ever
  connect.
- **Unaudited API project** (created after 28 July 2020): every video uploaded through the API is locked to
  **private**, whatever `privacyStatus` we send, until the project passes the YouTube compliance audit.
- Quota: the default is 10,000 units a day per project and an upload costs 1,600 units (check Google's quota
  calculator) — about six uploads a day; ask for more in the audit form.

Uploads use the resumable protocol in 16 MiB chunks; an interrupted upload is resumed through the same session, so it
never creates a second video. Videos are posted as Shorts (vertical, at most 3 minutes): the description ends with
`#Shorts` and the link is `https://youtube.com/shorts/<id>`. `containsSyntheticMedia` is set for posts with AI people,
voices, images or clips. A Google account without a YouTube channel gets "Create a YouTube channel…".

## LinkedIn (member profile)

1. linkedin.com/developers → Create app. It must be associated with a LinkedIn **Page** (create one for the company)
   and the Page admin must verify the app.
2. Products: **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn** (both self-serve, granted at
   once). This gives `openid`, `profile` and `w_member_social`.
3. Auth → Authorized redirect URL: `${SITE_URL}/api/accounts/callback/linkedin`.

Posts go to the member's own profile (videos and up to 20 images). Company pages need the Community Management API
(`w_organization_social`), a reviewed product that is not implemented here.

Tokens last 60 days. Refresh tokens are only issued to approved partner apps: when one is present it is used,
otherwise the account turns "expired" after 60 days and the person reconnects (the accounts list shows it).
API version header: `LinkedIn-Version: 202607` (`server/social/linkedin.ts`). LinkedIn supports each monthly version
for about a year — move it forward at least yearly.

## How publishing works

1. `POST /api/posts/:id/schedule` (or `autoSchedule` after approval) creates one `publications` row per account,
   `status='scheduled'`. The `publication_once` index prevents the same post twice on one account.
2. Every minute `dispatchDue(env)` claims up to 25 due rows (`status='publishing'`, `attempts+1`, a random media-link
   `token`) and creates Workflow instance `pub-<publication>-<attempt>`. If the instance cannot be created the row goes
   back to `scheduled`. Rows stuck in `publishing` for 2 hours fail with a "took too long" message.
3. The `Publication` workflow checks the post, account, plan and setup, refreshes the token if needed, starts the post
   once, then polls every 15 seconds for up to 30 minutes. Before any call that makes a post public it saves a
   checkpoint in `publications.ticket`; a step that runs again resumes from it instead of posting twice. When the
   outcome cannot be known (for example LinkedIn's post call timed out) the publication fails with "Publishing was
   interrupted. Check your … profile before retrying".
4. Results: `published` with `external_id`, `url`, `published_at`; or `failed` with a short plain-English `error`.
   An expired or revoked token marks the account `expired`. `POST /api/publications/:id/retry` queues a failed one
   again a minute later.

Provider calls never follow redirects, have timeouts, and log only the platform, publication ID, HTTP status and a
short code — never tokens, URLs with tokens, or response bodies.

## Open items for the rest of the app

- Maintenance: call `dispatchDue(env)` every minute and `refreshAccounts(env)` daily.
- Swipe review: call `autoSchedule(env, userId, postId)` after a post is approved.
- Accounts page `/app/accounts` reads `?workspace=…&connected=<platform>` or `&error=` with `expired`, `denied`,
  `permissions`, `no_channel`, `unavailable`, `limit` or `failed`.
- Avatar URLs point to the networks' CDNs, which the Content-Security-Policy (`img-src 'self' data: blob:`) blocks:
  show initials, or proxy/allow those hosts.
- TikTok audit UX (privacy level, interaction toggles, commercial content disclosure per account or post) needs a place
  to store the choices; the schema has none yet.
