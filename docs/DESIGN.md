# Design

The product follows the flow of the reference app the owner shared (screenshots of its onboarding and dashboard),
with its own name (Hookstreak), logo, colours and wording. No third-party branding, testimonials or metrics are copied.

## Look

- **Brand:** electric lime `#b8f53a` on ink `#0c0d10`. Lime is a fill (with ink text) or a glow, never text on white;
  `--brand-ink` (`#3f6212`) is the lime that reads as text. Violet `#7c5cff` and teal `#2dd4bf` are the supporting
  accents. Amber chips mean "waiting / worth a look"; green and red stay approve and reject.
- **Logo:** a hook whose point turns into an upward arrow (the streak), ink on a lime tile (`public/favicon.svg`,
  `Logo` in `src/ui.tsx`).
- Dark canvas (`#0c0d10`) with a lime glow top left, a violet glow top right and a faint dot grid.
- Big, bold, white headings (Bricolage Grotesque); body text Inter.
- Content sits on a frosted light card (rounded 26px, soft white rim/shadow).
- Choices are white rounded "pill" tiles; the selected tile turns ink with white text and a lime underline.
  Multi-select tiles toggle the same way. Icon tiles (e.g. sources) show a line icon above the label.
- Primary button: full-width ink, rounded 18px, disabled = grey/blue-grey. Secondary links: "← Back".
- Info banners with a lime → teal → violet gradient border.
- Progress dots under the card (current = dark).
- "Log out" ghost button top right during onboarding.
- A "Preparing workspace · Setting up your workspace…" card (top right) with a spinner and step dots
  (Website, Profile) that turn green while the brand scan runs in the background.

## Onboarding (8 steps)

1. **Welcome to {product}** — banner "Everything you enter here will be used directly across the platform."
   Company logo (optional upload, with remove ×), Name, Company name. Note: "Have multiple businesses? You can add
   more workspaces later in Settings › Workspaces." → creates the workspace.
2. **Analyze your website** — tabs *Website* | *Use description instead*. "Website or app store link" (hint: "Have an
   app? Paste its App Store or Google Play link.") → **Analyse website ››** starts the scan in the background.
3. **Tell us about yourself** — team size (Just me, 2–5, 6–10, 11–20, 21–50, 50+), monthly revenue
   (Pre-revenue … $500k+). Link: "Change website or description".
4. **What describes you best?** — role (Founder, Social Media Manager, Marketing Manager, Agency Owner, Freelancer,
   Product Manager, Content Creator, Growth Manager, Other).
5. **What type of business do you run?** — business model B2B / B2C / Both; categories (multi): E-commerce, SaaS,
   Agency, Services, Marketplace, Media/Content, Mobile app, Other.
6. **Why did you sign up?** — one of: I need marketing now / in the future / Just curious; expectations (multi).
7. **How did you hear about us?** — icon tiles (multi): X, LinkedIn, YouTube, TikTok, Instagram, Facebook, Podcast,
   Newsletter, Google, Reddit, ChatGPT, Claude, Gemini, Friend/Referral, Other.
8. **Two ways to create content** — tabs *Blitz mode* (swipe through ready posts) | *Manual creation* (build a post
   yourself), each with a short explainer; **Continue to dashboard**.

The reference also has a testimonials step ("Loved by founders like you"). It is left out until there are real
customer quotes to show (never invented ones); step 8 already explains how content gets made. After step 8 the app
opens Blitz and starts the first batch of posts as soon as the brand analysis is ready.

## Dashboard

- Left sidebar: workspace switcher (logo + name), collapse button; Home, Blitz, Create, Clips, Inspiration, Automations,
  AI Studio, Creators (AI UGC), Content, Library, Calendar; then Upgrade, Brand, Accounts, Settings (and Admin).
- Top bar (light lime): "Free trial · 6d 23h left" (or the plan and credits) and a lime **Upgrade** pill.
- **Blitz**: one post card in the centre (9:16 video or slideshow, mute toggle), stacked behind it the next ones;
  above it tags (format, topic) and **Why this content?**; left panel "Built on" shows the hook pattern; bottom
  buttons ✕ (reject, ←), **Edit**, ✓ (accept, →); an Accept/Reject stamp while dragging; first-visit tutorial
  overlay with a hand and **Got it**. Top right: **Generate more** and **Configure** (formats, AI credits).
  The reference's "Remixed From" panel shows the viral video a post copies; ours shows **Built on**: the proven hook
  pattern (no third-party videos or view counts).
- **Create** (manual creation, from the owner's demo video): format tabs (Slideshow, Wall of Text, Video Hook & Demo,
  Green Screen Meme, AI UGC); left panel with Mode (Create new / Remix), "Mention your business?", media pickers
  (video, audio, creator), style and prompt, **Generate**; right panel with Proven formats / Preview and an
  inspector for the text (preset, weight, size, colour, stroke, box, position, animation), swaps, slides and audio;
  **Save & build**. The preview plays the post's text animation and captions on a canvas, in sync with the video when
  there is a recorded voice or a demo with speech (Hook / Demo switch for hook & demo posts).
  Under the preview: **Captions** for AI UGC, a grid of the twenty caption styles, each a looping live sample; and
  **Subtitles** for a demo (or a wall of text's own clip with its sound kept) with speech: a switch and the same
  grid, or "Find speech" for an upload not yet listened to. Animation choices are small live tiles too. Every grid
  is a radio group (arrow keys move the choice); the chosen tile turns ink with a lime underline. With reduced motion
  the samples and the preview show a still moment. A talking demo also offers **Remove pauses** (and "Filler words
  too"), showing the length before and after; the preview skips the cut parts.
- **Clip** tab of Create: edits a clip post (or a moment opened from the Clips page): the moment (start, length),
  Remove pauses, Follow the speaker, the on-screen title and the caption style. The preview plays the kept parts and,
  once the speaker was found, slides the wide picture as the render crops it.
- **Clips** (`/app/clips`): 1. your long video (choose or upload; its speech is found for free up to 10 minutes, or
  transcribed for the credits shown on the button), 2. the best moments (3, 5 or 8; each with its title, time, why it
  works and what is said; Preview and Edit in Create), 3. make the clips (Remove pauses, Filler words too, Follow the
  speaker, Hook title, caption style), **Send to Blitz**. The focused moment plays in a phone preview on the right
  (on top on phones).
