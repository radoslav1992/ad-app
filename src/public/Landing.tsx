import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowRight, Bookmark, CalendarClock, Check, ChevronDown, Globe, Hand, Heart, MessageCircle, Palette, Repeat, Share2,
  Sparkles, UserRound, Wand2, X,
} from "lucide-react";
import { PRODUCT } from "../../shared/brand";
import type { PostFormatId, formats as Formats } from "../../shared/formats";
import { plans, TRIAL_DAYS } from "../../shared/plans";
import { platforms } from "../../shared/social";
import { useAuth } from "../lib";
import "./public.css";

// The home page. It is part of the entry bundle, so it stays plain: CSS art instead of images, no extra libraries.
// shared/formats carries the post schemas (zod), so its descriptions load in their own chunk after the page shows.

let formatsCache: typeof Formats | null = null;
function useFormats() {
  const [list, setList] = useState(formatsCache);
  useEffect(() => {
    if (list) return;
    let live = true;
    import("../../shared/formats")
      .then((m) => {
        formatsCache = m.formats;
        if (live) setList(m.formats);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [list]);
  return list;
}

/** The website box that starts a sign-up (the address travels to the register page as ?website=). */
export function StartForm({ label = "Start free" }: { label?: string }) {
  const [website, setWebsite] = useState("");
  const navigate = useNavigate();
  const { user } = useAuth();
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = website.trim();
    if (user) navigate("/app");
    else navigate(value ? `/register?website=${encodeURIComponent(value)}` : "/register");
  };
  return (
    <>
      <form className="start-form" onSubmit={submit}>
        <label htmlFor={id} className="sr-only">Your website</label>
        <input
          id={id}
          className="input"
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="yourwebsite.com"
          value={website}
          maxLength={300}
          onChange={(e) => setWebsite(e.target.value)}
        />
        <button className="btn primary" type="submit">
          {user ? "Open app" : label} <ArrowRight size={18} aria-hidden="true" />
        </button>
      </form>
      <p className="start-note">
        <span><Check size={16} aria-hidden="true" /> Free {TRIAL_DAYS}-day trial</span>
        <span><Check size={16} aria-hidden="true" /> No credit card</span>
      </p>
    </>
  );
}

function PhoneMockup() {
  return (
    <div className="hero-visual" role="img" aria-label="Example post: a slideshow with bold on-screen text, waiting for approval and scheduled for Tuesday morning.">
      <div className="ph-back one" />
      <div className="ph-back two" />
      <div className="pub-phone">
        <div className="phone-screen">
          <div className="ph-shape a" />
          <div className="ph-shape b" />
          <div className="ph-progress"><i className="on" /><i /><i /><i /><i /></div>
          <p className="ph-text">
            3 mistakes that keep your shop invisible
            <small>(number 2 hurts)</small>
          </p>
          <div className="ph-rail">
            <span><Heart size={18} /></span>
            <span><MessageCircle size={18} /></span>
            <span><Bookmark size={18} /></span>
            <span><Share2 size={18} /></span>
          </div>
          <p className="ph-caption"><b>@yourbrand</b>Save this before your next launch #smallbusiness</p>
        </div>
      </div>
      <div className="float f1">
        <span className="pub-round no"><X size={16} /></span>
        <span className="pub-round yes"><Check size={16} /></span>
        <span>Swipe to approve<small>Blitz review</small></span>
      </div>
      <div className="float f2">
        <CalendarClock size={22} color="#1e2433" />
        <span>Scheduled · Tue 9:00<small>TikTok · Reels · Shorts</small></span>
      </div>
      <div className="float f3"><Sparkles size={16} color="#65a30d" /> Slideshow</div>
    </div>
  );
}

/** Small CSS pictures of each format (decorative). */
function FormatArt({ id }: { id: PostFormatId }) {
  return (
    <div className={`fmt-art fmt-${id}`} aria-hidden="true">
      {id === "slideshow" && (
        <>
          <div className="dots"><i /><i /><i /><i /></div>
          <b>5 slides, one big idea</b>
        </>
      )}
      {id === "text" && <p>Nobody tells you this when you start: the first version is supposed to be a little embarrassing.</p>}
      {id === "hook_demo" && (
        <>
          <div className="hook">wait for it…</div>
          <div className="demo"><i /><i /><i /><i /></div>
        </>
      )}
      {id === "green_screen" && (
        <>
          <span className="meme">me finding the tool that does it for me</span>
          <div className="shot"><i /><i /><i /></div>
          <div className="person" />
        </>
      )}
      {id === "ugc" && (
        <>
          <div className="person" />
          <span className="cap">this <em>changed</em> how I</span>
        </>
      )}
      {id === "story" && (
        <>
          <div className="sketch"><i /><i /><i /></div>
          <span className="cap">Octopuses Have Three <em>Hearts</em></span>
        </>
      )}
      {id === "clip" && (
        <>
          <div className="wide"><div className="person" /></div>
          <div className="crop" />
          <span className="cap">the part <em>nobody</em> tells you</span>
        </>
      )}
    </div>
  );
}

function FormatCards() {
  const list = useFormats();
  if (!list)
    return (
      <ul className="formats" aria-busy="true">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <li key={i} className="glass format-card skeleton" aria-hidden="true">
            <div className="fmt-art" />
            <div><span className="bar short-bar" /><span className="bar" /></div>
            <span className="bar" />
          </li>
        ))}
      </ul>
    );
  return (
    <ul className="formats">
      {(Object.keys(list) as PostFormatId[]).map((id) => (
        <li key={id} className="glass format-card">
          <FormatArt id={id} />
          <div>
            <span className="short">{list[id].short}</span>
            <h3>
              {list[id].name}
              {list[id].ai && <span className="ai-tag">AI</span>}
            </h3>
          </div>
          <p>{list[id].description}</p>
        </li>
      ))}
    </ul>
  );
}

const steps = [
  { icon: Globe, title: "Paste your website", text: "We read it once to learn what you sell, who it's for, how you sound and your colours. Or describe your product instead." },
  { icon: Sparkles, title: "We make a month of posts", text: "Ideas built on well-known short-form hook patterns, written for your brand and rendered as finished videos and slideshows." },
  { icon: Hand, title: "Swipe, schedule, done", text: "Swipe right to keep a post, left to skip it. Approved posts fill your calendar and publish themselves." },
];

const faqs: { q: string; a: ReactNode }[] = [
  {
    q: `What is ${PRODUCT.name}?`,
    a: (
      <p>
        {PRODUCT.name} turns your website into a steady stream of short-form posts. It learns your product and audience, writes post ideas, and renders them
        as slideshows, text videos, hook-and-demo videos, green screen memes, AI creator videos and narrated videos. You approve the ones you like and they publish on your
        schedule.
      </p>
    ),
  },
  {
    q: "Which platforms can it post to?",
    a: (
      <>
        <p>
          {platforms.tiktok.name}, {platforms.instagram.name} (Reels and carousels on professional accounts), {platforms.youtube.name} Shorts and{" "}
          {platforms.linkedin.name}. Connect the accounts you want; posts go out at the times you choose.
        </p>
        <p>You can also download any post and share it wherever you like.</p>
      </>
    ),
  },
  {
    q: "Do I need to film anything?",
    a: (
      <p>
        No. Posts are built from your website's pictures, our library of clips and music, AI images and AI creators. If you have screen recordings or
        product photos, upload them: the Hook &amp; Demo format shows your own demo after the hook.
      </p>
    ),
  },
  {
    q: "Are AI-generated posts labeled?",
    a: (
      <p>
        Yes. Files that contain AI-generated people, voices or footage carry an AI-generated marker in their metadata, and we turn on the platform's AI
        disclosure when we publish where the platform offers one (TikTok and YouTube). AI content is labeled as the platforms require; where a platform
        asks you to add a label yourself, our{" "}
        <Link to="/terms">terms</Link> ask you to do so.
      </p>
    ),
  },
  {
    q: "Can I edit posts before they go out?",
    a: (
      <p>
        Yes. Change the on-screen text, the script, captions, hashtags, pictures, music and timing of any post. Nothing is published until you approve it,
        and you can move or cancel a scheduled post at any time before it goes out.
      </p>
    ),
  },
  {
    q: "Can I cancel any time?",
    a: (
      <p>
        Yes. Plans are monthly with no contract. Cancel from Billing in the app and your plan keeps working until the end of the period you paid for. The free
        trial needs no card, so there is nothing to cancel.
      </p>
    ),
  },
  {
    q: "What counts as a post, and what are credits?",
    a: (
      <>
        <p>
          A post is one finished video or slideshow we make for you; each plan includes a number of posts a month. Making a post with text, slides, music and
          captions never costs credits.
        </p>
        <p>
          AI credits pay for the AI extras: AI images, AI video clips, AI voices and talking AI creators. The <Link to="/pricing">pricing page</Link> lists
          what each one costs.
        </p>
      </>
    ),
  },
];

export function Landing() {
  const { hash, key } = useLocation();
  // Links such as "/#features" scroll to their section (React Router does not).
  useEffect(() => {
    if (!hash) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (!target) return;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, key]);

  return (
    <>
      <section className="pub-wrap hero" aria-labelledby="hero-title">
        <div>
          <span className="eyebrow"><Sparkles size={14} aria-hidden="true" /> {PRODUCT.tagline}</span>
          <h1 id="hero-title">Never break your <em>posting streak</em></h1>
          <p className="lead">{PRODUCT.pitch}</p>
          <StartForm />
        </div>
        <PhoneMockup />
      </section>

      <section className="pub-section" id="how-it-works" aria-labelledby="how-title" tabIndex={-1}>
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">How it works</span>
            <h2 className="title" id="how-title">From link to schedule in three steps</h2>
          </div>
          <ol className="pub-steps">
            {steps.map((s, i) => (
              <li key={s.title} className="frost tight step">
                <div className="step-top">
                  <span className="pub-icon navy"><s.icon size={22} aria-hidden="true" /></span>
                  <span className="step-num" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
                </div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="pub-section" id="features" aria-labelledby="formats-title" tabIndex={-1}>
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">Seven formats</span>
            <h2 className="title" id="formats-title">The formats that work on short-form, made for you</h2>
            <p className="sub">Mix them freely. Each post comes with its caption, hashtags and title for every network.</p>
          </div>
          <FormatCards />
        </div>
      </section>

      <section className="pub-section" aria-labelledby="blitz-title">
        <div className="pub-wrap split">
          <div className="copy">
            <span className="kicker">Blitz</span>
            <h2 className="title" id="blitz-title">Approve posts with a swipe</h2>
            <p className="sub">
              Blitz shows your new posts one at a time, ready to watch. Keep the good ones, skip the rest, and fix anything in the editor before it goes out.
            </p>
            <ul className="checks on-dark">
              <li>
                <Check size={18} aria-hidden="true" />
                <span>
                  Swipe right (or press <kbd className="kbd">→</kbd>) to approve, left (
                  <kbd className="kbd">←</kbd>) to skip
                </span>
              </li>
              <li><Check size={18} aria-hidden="true" /><span>“Why this content?” explains the idea and the hook it is built on</span></li>
              <li><Check size={18} aria-hidden="true" /><span>Approved posts can drop straight into the next free slot on your calendar</span></li>
              <li><Check size={18} aria-hidden="true" /><span>Tap Edit to change the words, pictures or music before you approve</span></li>
            </ul>
          </div>
          <div className="visual blitz-visual" aria-hidden="true">
            <div className="bz-stack">
              <div className="bz-tags"><span>Slideshow</span><span>Pricing myths</span></div>
              <div className="bz-card c3" />
              <div className="bz-card c2" />
              <div className="bz-card c1">
                <span className="bz-stamp">APPROVE</span>
                <b>Stop paying for features you never use</b>
              </div>
            </div>
            <div className="bz-buttons">
              <span className="big-round no"><X size={24} /></span>
              <span className="edit">Edit</span>
              <span className="big-round yes"><Check size={24} /></span>
            </div>
          </div>
        </div>
      </section>

      <section className="pub-section" aria-labelledby="more-title">
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">Everything around the posts</span>
            <h2 className="title" id="more-title">Set it up once. Keep posting.</h2>
          </div>
          <div className="features">
            <article className="glass feature wide">
              <div className="copy">
                <span className="pub-icon"><CalendarClock size={22} aria-hidden="true" /></span>
                <h3>Calendar and auto-publishing</h3>
                <p>
                  Connect your accounts and pick your posting times. Approved posts are published for you, as videos or as photo carousels where the network
                  supports them. Move anything on the calendar, any time.
                </p>
                <ul className="platform-list" aria-label="Supported platforms">
                  <li>{platforms.tiktok.name}</li>
                  <li>{platforms.instagram.name} Reels</li>
                  <li>{platforms.youtube.name} Shorts</li>
                  <li>{platforms.linkedin.name}</li>
                </ul>
              </div>
              <div className="mini-cal" aria-hidden="true">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => (
                  <div className="day" key={d}>
                    <b>{d}</b>
                    <span className={`slot t${(i % 4) + 1}`} />
                    {i % 3 !== 2 && <span className={`slot t${((i + 2) % 4) + 1}`} />}
                    {i % 2 === 0 && <span className={`slot t${((i + 1) % 4) + 1}`} />}
                  </div>
                ))}
              </div>
            </article>
            <article className="glass feature">
              <span className="pub-icon"><UserRound size={22} aria-hidden="true" /></span>
              <h3>AI UGC creators</h3>
              <p>
                Pick a creator from the library, or make your own from a photo of someone who has agreed to it. They speak your script with a natural AI voice
                and word-by-word captions. Their videos are marked as AI-generated.
              </p>
            </article>
            <article className="glass feature">
              <span className="pub-icon"><Repeat size={22} aria-hidden="true" /></span>
              <h3>Automations</h3>
              <p>
                Turn on daily posts and fresh ones are waiting for you every morning, in the formats you chose. You decide whether automations may spend AI
                credits.
              </p>
            </article>
            <article className="glass feature">
              <span className="pub-icon"><Palette size={22} aria-hidden="true" /></span>
              <h3>Brand profile</h3>
              <p>
                Your product, audience, tone of voice, colours and logo in one place, filled in from your website. Edit it whenever you like; every new post
                follows it.
              </p>
            </article>
            <article className="glass feature">
              <span className="pub-icon"><Wand2 size={22} aria-hidden="true" /></span>
              <h3>AI Studio</h3>
              <p>
                Make AI images for slides and backgrounds and create new AI creators, then use them in any post. Everything you make is yours to use
                commercially.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="pub-section" aria-labelledby="plans-title">
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">Pricing</span>
            <h2 className="title" id="plans-title">Start free. Upgrade when it works for you.</h2>
            <p className="sub">Every plan has every format. Paid plans add more posts, AI credits, workspaces and auto-publishing.</p>
          </div>
          <ul className="plans compact" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {plans.map((p) => (
              <li key={p.id} className="frost tight plan">
                <h3>{p.name}</h3>
                <p className="price">
                  <b>${p.price}</b>
                  <span>{p.price ? "/ month" : `· ${TRIAL_DAYS}-day trial`}</span>
                </p>
                <p className="desc">{p.description}</p>
              </li>
            ))}
          </ul>
          <div className="center-row mt-24">
            <Link className="btn white big" to="/pricing">Compare plans <ArrowRight size={18} aria-hidden="true" /></Link>
          </div>
        </div>
      </section>

      <section className="pub-section" id="faq" aria-labelledby="faq-title" tabIndex={-1}>
        <div className="pub-wrap">
          <div className="pub-section-head center">
            <span className="kicker">FAQ</span>
            <h2 className="title" id="faq-title">Questions, answered</h2>
          </div>
          <div className="faq">
            {faqs.map((f) => (
              <details key={f.q}>
                <summary>
                  {f.q}
                  <ChevronDown size={20} aria-hidden="true" />
                </summary>
                <div className="answer">{f.a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="pub-section" aria-labelledby="cta-title">
        <div className="pub-wrap">
          <div className="gradient-border cta-band">
            <div>
              <h2 id="cta-title">Your next month of posts starts with one link</h2>
              <p>Paste your website and see what your brand looks like on short-form. Keep the posts you like.</p>
              <StartForm label="Make my posts" />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
