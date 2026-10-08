import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PRODUCT } from "../../shared/brand";
import { TRIAL_DAYS } from "../../shared/plans";
import { publicPages } from "../../shared/seo";
import { usePublicConfig } from "./PublicLayout";
import "./public.css";

// Terms of Service and Privacy Policy.
// NOTE FOR THE OPERATOR: have these reviewed by a lawyer before launch (jurisdiction, consumer law, data protection).
// The "last updated" date is the terms version recorded with every sign-up (TERMS_VERSION in server/auth.ts): change
// both together, and the date in shared/seo.ts, whenever the text changes.

/** Who runs the service, from the site configuration (COMPANY_NAME, COMPANY_ADDRESS, CONTACT_EMAIL). */
type Operator = { name: ReactNode; address: string | null; contact: ReactNode };
type Section = { id: string; title: string; body: ReactNode };

const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

function terms(op: Operator): Section[] {
  const name = PRODUCT.name;
  return [
    {
      id: "about",
      title: "About these terms",
      body: (
        <>
          <p>
            These terms are an agreement between you and {op.name}
            {op.address ? `, ${op.address}` : ""} (“we”, “us”), who provides {name} (the “service”). By creating an account or using the service you
            accept these terms and our <Link to="/privacy">Privacy Policy</Link>.
          </p>
          <p>
            If you use {name} for a company or another organisation, you accept these terms on its behalf and confirm that you are allowed to do so. In that
            case “you” means that organisation as well as you.
          </p>
        </>
      ),
    },
    {
      id: "service",
      title: "The service",
      body: (
        <>
          <p>
            {name} reads the website or description you give it, builds a brand profile, writes ideas for short-form posts and makes them as videos and
            slideshows: slideshows, wall of text, video hook &amp; demo, green screen memes and AI UGC with talking AI creators. You review, edit and approve
            posts. Approved posts can be downloaded or published to social accounts you connect, at the times you choose. Automations can make new posts for
            your review every day, and AI Studio lets you make AI images and AI creators.
          </p>
          <p>
            We keep improving {name}, so features may change. If we remove a major feature of a paid plan, we will tell you in advance where we reasonably can.
            Parts of the service depend on other companies (for example AI providers and the social networks), and their services can change or be
            unavailable.
          </p>
        </>
      ),
    },
    {
      id: "account",
      title: "Your account",
      body: (
        <ul>
          <li>You must be at least 16 years old, and old enough to enter into this agreement where you live.</li>
          <li>Give us accurate details and keep your email address up to date; we use it for important messages about your account.</li>
          <li>
            Keep your password secret. You are responsible for what happens in your account. Tell us straight away if you think someone else has access to it.
          </li>
          <li>An account is for one person. Each workspace is one brand; only add brands you are allowed to act for.</li>
        </ul>
      ),
    },
    {
      id: "plans",
      title: "Free trial, plans and payment",
      body: (
        <>
          <h3>Free trial</h3>
          <p>
            New accounts start with a free trial of {TRIAL_DAYS} days that includes a limited number of posts and AI credits. You don't need to give payment
            details. The trial is available once per person and email mailbox; we may decline a trial that we believe is being repeated. Posts made during
            the trial stay in your account.
          </p>
          <h3>Paid plans</h3>
          <p>
            Paid plans are monthly subscriptions, billed in advance in US dollars through our payment provider Stripe. Prices are shown on the{" "}
            <Link to="/pricing">pricing page</Link> and at checkout; taxes may be added where they apply. Your subscription renews automatically each month
            until you cancel it.
          </p>
          <h3>Cancelling</h3>
          <p>
            You can cancel at any time from Billing in the app. Your plan keeps working until the end of the month you have paid for and then is not renewed.
            We don't refund partly used months, except where the law requires it. If a payment is refunded in full or disputed, the paid plan ends at once.
          </p>
          <h3>Posts and AI credits</h3>
          <p>
            Each plan includes a number of posts and AI credits per billing month. A post is one finished video or slideshow made by the service. AI credits
            pay for AI images, AI video clips, AI voices and talking AI creators, at the rates on the pricing page; if AI work fails on our side, its credits
            are returned. Unused posts and credits do not roll over to the next month and have no cash value. If you change plans during a month, your
            allowance for that month is adjusted.
          </p>
          <h3>Late payments and price changes</h3>
          <p>
            If a payment fails, Stripe will try again and we may limit paid features until it succeeds. We will tell you at least 30 days before a price
            change applies to your subscription, and you can cancel before it does.
          </p>
        </>
      ),
    },
    {
      id: "acceptable-use",
      title: "Acceptable use",
      body: (
        <>
          <p>You are responsible for what you create and publish with {name}. You must not use it to:</p>
          <ul>
            <li>impersonate any person, brand or organisation, or suggest an endorsement or affiliation that doesn't exist;</li>
            <li>
              make content that shows, voices or is about a real, identifiable person without their consent — including fake testimonials or reviews
              presented as coming from real customers;
            </li>
            <li>
              create an AI creator from a photo of a real person unless you are that person or have their explicit permission, and the right to use the photo,
              for this purpose;
            </li>
            <li>make sexual content, content involving minors in any sexualised or harmful way, or content that is hateful, harassing, violent or threatening;</li>
            <li>
              make illegal, defamatory or deceptive content, including false or misleading claims about products, health, money or politics, and misleading
              election content;
            </li>
            <li>infringe anyone's copyright, trademark, privacy or other rights;</li>
            <li>send spam, or break the rules of TikTok, Instagram, YouTube, LinkedIn or any other platform you publish to;</li>
            <li>
              disrupt or attack the service, get around its limits or security checks, scrape it, resell it without our permission, or use it to build a
              competing product.
            </li>
          </ul>
          <p>
            We may remove content or suspend accounts that break these rules (see <a href="#termination">Suspension and termination</a>). To report misuse,{" "}
            {op.contact}.
          </p>
        </>
      ),
    },
    {
      id: "ai-content",
      title: "AI-generated content",
      body: (
        <>
          <p>
            {name} uses AI to write ideas, scripts and captions and to make images, video, voices and talking creators. AI output can be wrong, out of date,
            similar to other people's output, or unsuitable for your audience. <strong>Review every post before you approve it</strong>: check facts, claims,
            prices and spelling, and make sure the post is right for your brand. You are responsible for the posts you approve and publish.
          </p>
          <p>
            Media that contains AI-generated people, voices or footage is marked as AI-generated in its file metadata. When we publish to a platform that offers
            an AI-content disclosure through its API (currently TikTok and YouTube), we switch it on for such posts. Where a platform or the law asks you to
            label AI content yourself, you must do so. Don't remove or hide these markers to make AI content look real.
          </p>
        </>
      ),
    },
    {
      id: "social-accounts",
      title: "Connected social accounts",
      body: (
        <>
          <p>
            You can connect TikTok, Instagram, YouTube and LinkedIn accounts through each platform's own sign-in. By connecting an account you allow us to
            publish to it on your behalf and to read the details needed for that (such as the account name and the status of posts we published).
          </p>
          <ul>
            <li>We only publish posts that you approved and scheduled, or that you approved with automatic scheduling switched on.</li>
            <li>You can cancel or move a scheduled post until it starts publishing.</li>
            <li>The access tokens the platforms give us are stored encrypted and used only to provide the service.</li>
            <li>You can disconnect an account at any time in the app or in the platform's own settings.</li>
          </ul>
          <p>
            Each platform's own terms apply to what you publish there. The platforms decide on reach, moderation and account status; we are not responsible
            for their decisions or for posts they reject, delay or remove.
          </p>
        </>
      ),
    },
    {
      id: "ownership",
      title: "Your content and ownership",
      body: (
        <>
          <p>
            You keep all rights to what you put into {name} — your website content, descriptions, logos, uploads and photos (“inputs”). As between you and us,
            you also own the posts, scripts, images and videos the service makes for you (“outputs”), and you may use them commercially. In some countries
            purely AI-generated material may not be protected by copyright, and similar outputs may be made for other users.
          </p>
          <p>
            You give us a worldwide, non-exclusive licence to host, copy, process, change the format of and publish your inputs and outputs only as needed to
            run the service for you — for example to render videos, send work to our AI providers, and publish to the accounts you connect. The licence ends
            when you delete the content or your account, except for posts already published on other platforms and copies we must keep by law.
          </p>
          <p>
            You confirm that you have the rights needed for your inputs, including permission to let us read the website you give us and to use any people,
            music, logos or footage in your uploads.
          </p>
        </>
      ),
    },
    {
      id: "library",
      title: "Library content",
      body: (
        <p>
          {name} includes a library of music, video clips, green-screen clips and AI characters. You may use library items in posts made with the service and
          publish those posts on social networks and elsewhere, including for commercial purposes. You may not download, sell or share library items on their
          own, use them outside posts made with {name}, or use library characters in a way that suggests a real person endorses you. Posts you published
          while your account was active may stay online after you stop using {name}.
        </p>
      ),
    },
    {
      id: "our-rights",
      title: "Our service and brand",
      body: (
        <p>
          The service, its software, design, templates and the {name} name and logo belong to us or our licensors. These terms don't give you any rights to
          them except to use the service as described here. If you send us feedback or ideas, we may use them without any obligation to you.
        </p>
      ),
    },
    {
      id: "termination",
      title: "Suspension and termination",
      body: (
        <>
          <p>
            You can stop using {name} at any time and delete your account in Settings. Deleting your account cancels any paid plan and deletes your data as
            described in the <Link to="/privacy">Privacy Policy</Link>; download anything you want to keep first.
          </p>
          <p>
            We may suspend or close your account, or remove content, if you seriously or repeatedly break these terms, if you don't pay, if the law or a
            platform requires it, or if your use puts other people or the service at risk. Unless the law or the situation prevents it, we will tell you
            why and give you a chance to respond. If we close your account without you being at fault, we will refund the unused part of your current month.
          </p>
        </>
      ),
    },
    {
      id: "disclaimers",
      title: "Disclaimers",
      body: (
        <p>
          We work hard to keep {name} running well, but we provide it “as is” and “as available”. We don't promise that it will always be available or free of
          errors, that AI output will be accurate, or that your posts will reach a particular number of people or bring particular results. Nothing in these
          terms limits rights you have under consumer protection laws that cannot be excluded.
        </p>
      ),
    },
    {
      id: "liability",
      title: "Limitation of liability",
      body: (
        <>
          <p>
            To the extent the law allows, we are not liable for indirect or consequential losses, such as lost profits, revenue, followers, data or goodwill,
            or for the decisions of social networks. Our total liability for all claims relating to the service is limited to the greater of the amounts you
            paid us in the 12 months before the claim arose and 100 US dollars.
          </p>
          <p>
            These limits don't apply to liability that cannot be limited by law, such as for death or personal injury caused by negligence, or for fraud.
          </p>
          <p>
            If someone makes a claim against us because of content you created or published with {name}, or because you broke these terms, you will cover our
            reasonable costs of dealing with that claim, to the extent the law allows.
          </p>
        </>
      ),
    },
    {
      id: "changes",
      title: "Changes to these terms",
      body: (
        <p>
          We may update these terms, for example when we add features or the law changes. For important changes we will tell you by email or in the app at
          least 30 days before they apply. If you keep using {name} after that, the new terms apply; if you don't agree, you can cancel and delete your account
          before then. We record which version of the terms you accepted.
        </p>
      ),
    },
    {
      id: "law",
      title: "Governing law and disputes",
      body: (
        <p>
          These terms are governed by the laws of the country where the operator is established. If you are a consumer, you also keep the protection of the
          mandatory laws of the country where you live and can bring claims in your local courts. Please contact us first — most problems can be solved
          quickly.
        </p>
      ),
    },
    {
      id: "contact",
      title: "Contact",
      body: (
        <p>
          Questions about these terms? Please {op.contact}.
        </p>
      ),
    },
  ];
}

function privacy(op: Operator): Section[] {
  const name = PRODUCT.name;
  return [
    {
      id: "who",
      title: "Who we are",
      body: (
        <>
          <p>
            {name} is provided by {op.name}
            {op.address ? `, ${op.address}` : ""} (“we”, “us”). We are responsible (the “controller”) for the personal data described here. This policy
            explains what we collect, why, who helps us process it, and the choices you have.
          </p>
          <p>
            In short: we use your data to run {name} for you. We don't sell it, we don't show ads, and we don't use advertising or analytics trackers.
          </p>
        </>
      ),
    },
    {
      id: "data",
      title: "The data we process",
      body: (
        <ul>
          <li>
            <strong>Account:</strong> your name, email address, a securely hashed version of your password (never the password itself), whether you confirmed
            your email, and when you accepted our terms.
          </li>
          <li>
            <strong>Workspace and brand:</strong> company name, logo, website or description, the brand profile (product, audience, tone, colours), your
            settings and schedule, and your onboarding answers (such as team size, role, business type and how you heard about us).
          </li>
          <li>
            <strong>Website content:</strong> text and images from the public pages of the website you give us, read to build your brand profile and posts.
          </li>
          <li>
            <strong>Uploads:</strong> images, videos and audio you upload, including photos you use to create your own AI creators.
          </li>
          <li>
            <strong>Generated content:</strong> ideas, scripts, captions, AI images, voices, videos and finished posts, and your reviews of them (approved or
            skipped).
          </li>
          <li>
            <strong>Connected social accounts:</strong> access tokens (stored encrypted), the account's name, ID and picture, and information about posts we
            publish for you (schedule, status, links, error messages, and the views, likes, comments and shares the network reports for them).
          </li>
          <li>
            <strong>Billing:</strong> your plan, subscription status and invoices. Card details are collected and stored by Stripe; we never see your full card
            number.
          </li>
          <li>
            <strong>Messages:</strong> what you send us through the contact form or by email.
          </li>
          <li>
            <strong>Technical and security data:</strong> IP address, browser details, timestamps, sign-in attempts, rate-limit counters, security check results
            and error reports.
          </li>
        </ul>
      ),
    },
    {
      id: "use",
      title: "Why we use it",
      body: (
        <>
          <ul>
            <li>
              <strong>To provide the service</strong> you signed up for — making, storing and publishing your posts, billing and support (necessary to perform
              our contract with you).
            </li>
            <li>
              <strong>To keep {name} safe</strong> — preventing abuse, fraud and repeated free trials, securing accounts and fixing errors (our legitimate
              interests).
            </li>
            <li>
              <strong>To send service emails</strong> — confirming your email, password resets, security alerts and important changes. We don't send
              marketing emails without your consent.
            </li>
            <li>
              <strong>To meet legal obligations</strong> — such as tax and accounting records.
            </li>
          </ul>
          <p>We don't use your data to make decisions about you that have legal or similarly significant effects.</p>
        </>
      ),
    },
    {
      id: "processors",
      title: "Who processes data for us",
      body: (
        <>
          <p>We share data only with providers that help us run {name}, and only what each needs for its job:</p>
          <div className="table-x">
            <table>
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">What for</th>
                  <th scope="col">Data involved</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Cloudflare</th>
                  <td>Hosting, database, file storage, email delivery, the AI text models that write ideas, scripts and captions, and Turnstile security checks</td>
                  <td>All service data; website content, brand profile and prompts for writing; technical data for security checks</td>
                </tr>
                <tr>
                  <th scope="row">Stripe</th>
                  <td>Payments and invoices</td>
                  <td>Name, email, payment details, plan and billing history</td>
                </tr>
                <tr>
                  <th scope="row">fal.ai</th>
                  <td>AI images and AI video clips</td>
                  <td>Prompts and any images needed for the job</td>
                </tr>
                <tr>
                  <th scope="row">ElevenLabs</th>
                  <td>AI voices</td>
                  <td>The text to be spoken</td>
                </tr>
                <tr>
                  <th scope="row">HeyGen</th>
                  <td>Talking AI creator videos</td>
                  <td>The creator's image (including photos you upload for your own creators) and the voice recording</td>
                </tr>
                <tr>
                  <th scope="row">TikTok, Meta (Instagram), Google (YouTube), LinkedIn</th>
                  <td>Publishing and reading your posts' stats — only when you connect an account</td>
                  <td>The posts you schedule, their captions, and the account tokens</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            These providers process data under their own security and privacy commitments. We may also disclose data when the law requires it, to protect
            people's safety or our rights, or to a buyer if our business is sold (you will be told first, and this policy will keep applying).
          </p>
        </>
      ),
    },
    {
      id: "clicks",
      title: "Clicks and sales we count for customers",
      body: (
        <>
          <p>
            When you turn on tracked links or add our sales snippet to your website, we count for you how often each tracked link is followed (a number per
            link and day) and the sales or sign-ups your site reports to us (the amount, the currency and a one-way hash of the order ID, so a repeat counts
            once). We don't keep anything about the people who click or buy: no names, email addresses, IP addresses, cookies or device fingerprints. To keep
            the numbers honest we skip link previews and bots, and use rate-limit counters keyed by a hash of the visitor's IP address that expire within the
            hour.
          </p>
          <p>
            The snippet sets no cookies. It keeps the code of the last tracked link a visitor arrived from in your website's own browser storage for 30 days,
            so a later sale can be credited to the post that brought them. Counts are kept for 13 months. For these counts we act on your behalf, and you
            should mention them in your own website's privacy notice.
          </p>
        </>
      ),
    },
    {
      id: "transfers",
      title: "International transfers",
      body: (
        <p>
          Our providers operate worldwide, so your data may be processed outside the country where you live, including in the United States. Where data
          protection law requires it, we rely on safeguards such as the European Commission's standard contractual clauses or an adequacy decision.
        </p>
      ),
    },
    {
      id: "retention",
      title: "How long we keep data",
      body: (
        <ul>
          <li>Account, workspace and content data: for as long as you have an account. You can delete posts, uploads and workspaces at any time.</li>
          <li>
            When you delete your account (Settings › Delete account), we cancel any paid plan and delete your account, workspaces, posts and social connections
            straight away; stored files are removed by our clean-up job shortly after.
          </li>
          <li>
            We keep a one-way hash of your email address with your trial usage after deletion, so the free trial can't be restarted with the same mailbox.
          </li>
          <li>Billing records: as long as tax and accounting law requires. Stripe keeps its own records under its policies.</li>
          <li>Contact messages: as long as needed to answer you and handle any follow-up.</li>
          <li>Security data such as sign-in attempts and rate-limit counters expires automatically, usually within hours to days.</li>
          <li>Daily click counts and reported sales from tracked links: 13 months.</li>
          <li>Posts you published stay on the social networks until you remove them there.</li>
        </ul>
      ),
    },
    {
      id: "rights",
      title: "Your rights",
      body: (
        <>
          <p>Depending on where you live, you can ask us to:</p>
          <ul>
            <li>give you a copy of your personal data (access), and download your content in a portable format (export);</li>
            <li>correct data that is wrong;</li>
            <li>delete your data — you can delete your account yourself in Settings;</li>
            <li>restrict or object to some processing, such as processing based on our legitimate interests;</li>
            <li>withdraw consent where we rely on it.</li>
          </ul>
          <p>
            You can download your posts from the app at any time. For anything else, {op.contact}; we answer within one month. You can also complain to your
            data protection authority.
          </p>
        </>
      ),
    },
    {
      id: "cookies",
      title: "Cookies and local storage",
      body: (
        <>
          <p>
            We use a single cookie: a session cookie that keeps you signed in (it lasts up to 30 days, or until you log out). We don't use advertising
            cookies, analytics trackers or third-party pixels, so there is no cookie banner.
          </p>
          <p>
            The app also saves a few preferences in your browser's local storage, such as the workspace you last opened, whether the sidebar is collapsed, and
            the website you entered before signing up. Cloudflare Turnstile may run a short check in your browser to tell people from bots on our forms.
          </p>
        </>
      ),
    },
    {
      id: "security",
      title: "Security",
      body: (
        <p>
          We protect your data with encryption in transit, hashed passwords, encrypted social account tokens, limits on sign-in attempts and access only for
          those who need it. No system is perfectly secure; if a breach affects your data, we will tell you and the authorities as the law requires.
        </p>
      ),
    },
    {
      id: "children",
      title: "Children",
      body: <p>{name} is for people aged 16 and over. We don't knowingly collect data from children; if you think a child has signed up, please tell us and we will delete the account.</p>,
    },
    {
      id: "changes",
      title: "Changes to this policy",
      body: <p>If we change this policy in a way that matters, we will tell you by email or in the app before the change applies. The date at the top shows the latest version.</p>,
    },
    {
      id: "contact",
      title: "Contact",
      body: <p>For privacy questions or requests, {op.contact}.</p>,
    },
  ];
}

export function Legal({ page }: { page: "terms" | "privacy" }) {
  const { config } = usePublicConfig();
  const company = config?.company;
  const op: Operator = {
    name: company?.name ? <strong>{company.name}</strong> : `the operator of ${PRODUCT.name}`,
    address: company?.address || null,
    contact: company?.email ? (
      <>write to <a href={`mailto:${company.email}`}>{company.email}</a> or use our <Link to="/contact">contact form</Link></>
    ) : (
      <>use our <Link to="/contact">contact form</Link></>
    ),
  };
  const isTerms = page === "terms";
  const sections = isTerms ? terms(op) : privacy(op);
  const updated = formatDate(publicPages[isTerms ? "/terms" : "/privacy"].updated);
  return (
    <div className="wrap narrow">
      <header className="pub-head">
        <span className="kicker">Legal</span>
        <h1>{isTerms ? "Terms of Service" : "Privacy Policy"}</h1>
        <p className="lead">Last updated {updated}</p>
        <nav className="legal-switch" aria-label="Legal documents">
          <Link to="/terms" aria-current={isTerms ? "page" : undefined}>Terms of Service</Link>
          <Link to="/privacy" aria-current={!isTerms ? "page" : undefined}>Privacy Policy</Link>
        </nav>
      </header>
      {/* Have these reviewed by a lawyer before launch. */}
      <article className="legal-doc" aria-label={isTerms ? "Terms of Service" : "Privacy Policy"}>
        <div className="summary">
          {isTerms ? (
            <p>
              <strong>The short version:</strong> you own what you put in and what you make. Review posts before they go out — you are responsible for what you
              publish. Don't use {PRODUCT.name} to deceive people or to show real people without their consent. Plans are monthly and you can cancel any
              time.
            </p>
          ) : (
            <p>
              <strong>The short version:</strong> we use your data to make and publish your posts, and for nothing else. We don't sell it, show ads or use
              tracking cookies. You can export your posts and delete your account at any time.
            </p>
          )}
        </div>
        <nav className="toc" aria-labelledby="toc-title">
          <h2 id="toc-title">Contents</h2>
          <ol>
            {sections.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}
          </ol>
        </nav>
        {sections.map((s, i) => (
          <section key={s.id} aria-labelledby={s.id}>
            <h2 id={s.id}>{i + 1}. {s.title}</h2>
            {s.body}
          </section>
        ))}
      </article>
    </div>
  );
}
