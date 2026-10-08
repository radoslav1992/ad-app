import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown, Info, Minus } from "lucide-react";
import { plans, planIncludes, tariffs, PRICE_NOTE, TRIAL_DAYS, type Plan } from "../../shared/plans";
import { useAuth } from "../lib";
import { usePublicConfig } from "./PublicLayout";
import "./public.css";

// Plans, what every plan includes, what AI work costs, and the questions people ask before paying.

const n = (v: number) => v.toLocaleString("en-US");

function PlanCard({ plan, signedIn }: { plan: Plan; signedIn: boolean }) {
  const free = plan.price === 0;
  const best = plan.id === "growth";
  // Signed-in visitors choose a plan in Billing; everyone else starts with the trial.
  const to = signedIn ? (free ? "/app" : `/app/billing?plan=${plan.id}`) : free ? "/register" : `/register?plan=${plan.id}`;
  const cta = signedIn ? (free ? "Open app" : `Choose ${plan.name}`) : free ? "Start free" : `Start with ${plan.name}`;
  const card = (
    <article className="frost plan">
      {best && <span className="badge-best">Best value</span>}
      <h2>{plan.name}</h2>
      <p className="price">
        <b>${plan.price}</b>
        <span>{free ? `for ${TRIAL_DAYS} days` : "/ month"}</span>
      </p>
      <p className="desc">{plan.description}</p>
      <ul className="checks">
        {plan.features.map((f) => (
          <li key={f}><Check size={17} aria-hidden="true" /><span>{f}</span></li>
        ))}
      </ul>
      <Link className={`btn block${free ? "" : " primary"}`} to={to}>{cta}</Link>
    </article>
  );
  return <li className={`plan-wrap${best ? " featured" : ""}`}>{card}</li>;
}

const yes = (label: string) => <span className="yes"><Check size={18} aria-label={label} /></span>;
const no = (label: string) => <span className="no"><Minus size={18} aria-label={label} /></span>;
const rows: { label: string; value: (p: Plan) => ReactNode }[] = [
  { label: "Price", value: (p) => (p.price ? `$${p.price} / month` : `Free for ${TRIAL_DAYS} days`) },
  { label: "Posts", value: (p) => (p.price ? `${n(p.posts)} a month` : `${n(p.posts)} during the trial`) },
  { label: "AI credits", value: (p) => (p.price ? `${n(p.credits)} a month` : `${n(p.credits)} during the trial`) },
  { label: "Workspaces (brands)", value: (p) => n(p.workspaces) },
  { label: "Connected social accounts", value: (p) => (p.accounts ? `Up to ${n(p.accounts)}` : "Download only") },
  { label: "Auto-publishing and calendar", value: (p) => (p.scheduling ? yes("Included") : no("Not included")) },
  { label: "Storage", value: (p) => `${n(p.storageGb)} GB` },
];

const questions: { q: string; a: ReactNode }[] = [
  {
    q: "What counts as a post?",
    a: (
      <p>
        One finished video or slideshow that we make for you, ready to publish or download. Each plan includes a number of posts per billing month (the trial
        has its own allowance). Rendering a post with its text, slides, music and captions never costs credits.
      </p>
    ),
  },
  {
    q: "What are AI credits for?",
    a: (
      <p>
        The AI extras: AI images, AI video backgrounds, AI voices and talking AI creators. The table above shows what each costs. Automations only spend
        credits if you allow them to.
      </p>
    ),
  },
  {
    q: "Do unused posts or credits roll over?",
    a: <p>No. Your allowance of posts and credits starts fresh with each billing month, and anything unused at the end of the month expires.</p>,
  },
  {
    q: "How does the free trial work?",
    a: (
      <p>
        Sign up without a card and make posts for {TRIAL_DAYS} days, within the trial's allowance of {n(plans[0].posts)} posts and {n(plans[0].credits)} AI credits.
        Posts you made stay in your account and can be downloaded. Auto-publishing starts with a paid plan.
      </p>
    ),
  },
  {
    q: "Can I change plans or cancel?",
    a: (
      <p>
        Yes, any time from Billing in the app. If you cancel, your plan keeps working until the end of the month you paid for and is not renewed.
      </p>
    ),
  },
  {
    q: "How do I pay?",
    a: <p>By card through Stripe, billed monthly in US dollars. We never see or store your full card number.</p>,
  },
];

export function Pricing() {
  const { user } = useAuth();
  const { config } = usePublicConfig();
  return (
    <>
      <div className="wrap">
        <header className="pub-head center">
          <span className="kicker">Pricing</span>
          <h1>Plans for every posting pace</h1>
          <p className="lead">Start with a free {TRIAL_DAYS}-day trial, no credit card needed. Pick a plan when you want to publish every day.</p>
        </header>
        {config && !config.billingEnabled && (
          <p className="stage-note" style={{ maxWidth: 760, margin: "0 auto 28px" }}>
            <Info size={18} aria-hidden="true" />
            <span>Paid plans open soon. You can start the free trial today and upgrade as soon as they do.</span>
          </p>
        )}
        <ul className="plans" style={{ listStyle: "none", padding: 0, margin: 0 }} aria-label="Plans">
          {plans.map((p) => <PlanCard key={p.id} plan={p} signedIn={!!user} />)}
        </ul>
        <p className="price-note">{PRICE_NOTE}</p>
      </div>

      <section className="pub-section tight" aria-labelledby="includes-title">
        <div className="wrap split">
          <div className="copy">
            <span className="kicker">In every plan</span>
            <h2 className="title" id="includes-title">Every plan includes</h2>
            <p className="sub">Every format and every way of making posts comes with every plan, the trial included.</p>
          </div>
          <div className="frost tight">
            <ul className="checks" style={{ fontSize: 16 }}>
              {planIncludes.map((item) => (
                <li key={item}><Check size={18} aria-hidden="true" /><span>{item}</span></li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="pub-section tight" aria-labelledby="compare-title">
        <div className="wrap">
          <div className="pub-section-head">
            <span className="kicker">Compare</span>
            <h2 className="title" id="compare-title">Plans side by side</h2>
          </div>
          <div className="table-scroll">
            <table className="pub-table compare">
              <thead>
                <tr>
                  <td />
                  {plans.map((p) => <th key={p.id} scope="col">{p.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <th scope="row">{r.label}</th>
                    {plans.map((p) => <td key={p.id}>{r.value(p)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="pub-section tight" aria-labelledby="credits-title">
        <div className="wrap">
          <div className="pub-section-head">
            <span className="kicker">AI credits</span>
            <h2 className="title" id="credits-title">What AI work costs</h2>
            <p className="sub">Credits come with your plan each month. Posts without AI extras cost no credits at all.</p>
          </div>
          <div className="table-scroll">
            <table className="pub-table fit">
              <thead>
                <tr>
                  <th scope="col">What you make</th>
                  <th scope="col">Price</th>
                </tr>
              </thead>
              <tbody>
                {tariffs.map((t) => (
                  <tr key={t.name}>
                    <th scope="row">{t.name}</th>
                    <td>{t.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="pub-section tight" aria-labelledby="pricing-faq-title">
        <div className="wrap">
          <div className="pub-section-head center">
            <span className="kicker">FAQ</span>
            <h2 className="title" id="pricing-faq-title">Posts, credits and the trial</h2>
          </div>
          <div className="faq">
            {questions.map((f) => (
              <details key={f.q}>
                <summary>
                  {f.q}
                  <ChevronDown size={20} aria-hidden="true" />
                </summary>
                <div className="answer">{f.a}</div>
              </details>
            ))}
          </div>
          <p className="center mt-32" style={{ color: "#c9ccd3" }}>
            Still deciding? <Link className="text-link" to="/contact">Ask us anything</Link>.
          </p>
        </div>
      </section>
    </>
  );
}
