# Design

The product follows the flow and feel of the reference app the owner shared (screenshots of its onboarding and
dashboard), with its own name, logo and wording. No third-party branding, testimonials or metrics are copied.

## Look

- Dark canvas (#121212) with a warm brown/orange glow at the top edge and a faint diagonal line texture.
- Big, bold, white headings (Bricolage Grotesque); body text Inter.
- Content sits on a frosted light-grey card (rounded 24px, soft white rim/shadow).
- Choices are white rounded "pill" tiles; the selected tile turns dark navy (#1e2433) with white text.
  Multi-select tiles toggle the same way. Icon tiles (e.g. sources) show a line icon above the label.
- Primary button: full-width dark navy, rounded 18px, disabled = grey/blue-grey. Secondary links: "← Back".
- Info banners with a gradient (orange → rainbow) border.
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

The reference has a testimonials step ("Loved by founders like you"). We show **How it works** instead until there
are real customer quotes (never invented ones).

## Dashboard

- Left sidebar: workspace switcher (logo + name), collapse button; Home, Blitz, Inspiration, Automations, AI Studio,
  Characters (AI UGC creators), Content, Library, Calendar; then Upgrade, Brand, Settings.
- Top bar: "Free trial · 6d 23h left" (or the plan and credits) and an **Upgrade** pill.
- **Blitz**: one post card in the centre (9:16 video or slideshow, mute toggle), stacked behind it the next ones;
  above it tags (format, topic) and **Why this content?**; left panel "Built on" shows the hook pattern; bottom
  buttons ✕ (reject, ←), **Edit**, ✓ (accept, →); an Accept/Reject stamp while dragging; first-visit tutorial
  overlay with a hand and **Got it**. Top right: **Configure** (formats, auto-schedule).
