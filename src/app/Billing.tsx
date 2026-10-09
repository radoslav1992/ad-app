import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, ArrowRight, Check, Clock, CreditCard, ExternalLink, Gift, Sparkles, Undo2 } from "lucide-react";
import { Modal, Spinner, useToast } from "../ui";
import { errorText, number, post, timeLeft, useApi, useAuth } from "../lib";
import { PRICE_NOTE, paidPlans, planById, planIncludes, plans, tariffs, type PaidPlanId } from "../../shared/plans";
import { IMMEDIATE_START_TEXT, WITHDRAWAL_DAYS } from "../../shared/withdrawal";
import { PRODUCT } from "../../shared/brand";
import { formatDate, useSignedInUser } from "./pickers";
import "./pages.css";

const rank = (id: string) => plans.findIndex((p) => p.id === id);
/** The register page remembers the plan someone picked on the pricing page under this key. */
const SIGNUP_PLAN = "pl-signup-plan";
const isPaidPlan = (id: string | null): id is PaidPlanId => !!id && (paidPlans as readonly string[]).includes(id);

/** Plans & billing: the current plan and usage, plan changes through Stripe Checkout / Customer Portal, AI prices. */
export function BillingPage() {
  const user = useSignedInUser();
  const { refresh } = useAuth();
  const toast = useToast();
  const config = useApi<{ billingEnabled: boolean }>("/public/config");
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  // A first checkout asks for the express request to start at once (the server refuses checkout without it).
  const [confirming, setConfirming] = useState<PaidPlanId | null>(null);

  // A plan picked on the pricing page (?plan=, or remembered through sign-up): highlight it, never start checkout.
  const [wanted] = useState<PaidPlanId | null>(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(SIGNUP_PLAN); } catch { /* storage unavailable */ }
    const pick = params.get("plan");
    return isPaidPlan(pick) ? pick : isPaidPlan(stored) ? stored : null;
  });
  const highlight = wanted && wanted !== user.plan ? wanted : null;
  const wantedCard = useRef<HTMLElement>(null);
  useEffect(() => {
    try { localStorage.removeItem(SIGNUP_PLAN); } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    if (!highlight) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    wantedCard.current?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  }, [highlight]);

  // Back from Stripe: re-read the subscription, then the account (once, even in development's double effects).
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    const success = params.get("success") === "1", portal = params.get("portal") === "1", cancelled = params.get("cancelled") === "1";
    if (!success && !portal && !cancelled) return;
    handled.current = true;
    setParams({}, { replace: true });
    if (cancelled) {
      toast("Checkout cancelled. Nothing was charged.");
      return;
    }
    setSyncing(true);
    void (async () => {
      try {
        await post("/billing/sync");
        await refresh();
        toast(success ? "Thank you! Your plan is active." : "Your billing details are up to date.", "good");
      } catch {
        await refresh();
        toast("We're confirming your payment with the bank. Your plan updates within a minute.", "info");
      } finally {
        setSyncing(false);
      }
    })();
  }, [params, setParams, refresh, toast]);

  const enabled = config.data?.billingEnabled ?? false;
  const plan = planById(user.plan);
  const free = user.plan === "free";
  const go = async (key: string, request: () => Promise<{ url: string }>) => {
    setBusy(key);
    try {
      const { url } = await request();
      window.location.assign(url);
    } catch (e) {
      toast(errorText(e), "bad");
      setBusy(null);
    }
  };
  const portal = (target?: PaidPlanId) => go(target ? `portal-${target}` : "portal", () => post<{ url: string }>("/billing/portal", target ? { plan: target } : {}));
  const choose = (target: PaidPlanId) => (user.hasSubscription ? portal(target) : setConfirming(target));
  const checkout = (target: PaidPlanId) => go(target, () => post<{ url: string }>("/billing/checkout", { plan: target, immediateStart: true }));
  const granted = !!user.granted && !!user.periodEnd;
  const creditsShare = user.limit ? Math.min(1, user.used / user.limit) : 0;
  const postsShare = user.postsLimit ? Math.min(1, user.postsUsed / user.postsLimit) : 0;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Plans & billing</h1>
          <p>Your plan, what's left this period, and what AI work costs.</p>
        </div>
        <div className="toolbar">
          {syncing && <span className="chip" role="status"><Spinner label="Updating" />Updating your plan…</span>}
          {user.hasSubscription && (
            <button type="button" className="btn" onClick={() => void portal()} disabled={!!busy}>
              {busy === "portal" ? <Spinner label="Opening" /> : <CreditCard size={16} aria-hidden="true" />}Manage billing
            </button>
          )}
        </div>
      </div>

      {user.paymentIssue && (
        <div className="notice bad row wrap" role="alert" style={{ marginBottom: 16 }}>
          <AlertTriangle size={18} aria-hidden="true" />
          <span className="grow">Your last payment didn't go through. Update your card to keep your plan; we'll retry it automatically.</span>
          {user.hasSubscription && <button type="button" className="btn sm" onClick={() => void portal()} disabled={!!busy}>Update payment method</button>}
        </div>
      )}
      {granted && (
        <div className="notice good row wrap" role="note" style={{ marginBottom: 16 }}>
          <Gift size={18} aria-hidden="true" />
          <span className="grow">
            You have <strong>{plan.name}</strong> free until {formatDate(user.periodEnd!)}, from the {PRODUCT.name} team. No payment is needed. After that you go
            back to {user.hasSubscription ? "your paid plan" : "the free plan"} unless you choose a plan.
          </span>
        </div>
      )}
      {!config.loading && !enabled && (
        <div className="notice warn" role="note" style={{ marginBottom: 16 }}>
          <strong>Payments open soon.</strong> Paid plans aren't available yet; keep using your free trial meanwhile.
        </div>
      )}
      {enabled && !user.verified && (
        <div className="notice warn" role="note" style={{ marginBottom: 16 }}>Confirm your email before subscribing. We sent you a link when you signed up.</div>
      )}

      <section className="card" aria-labelledby="current-plan">
        <div className="card-head">
          <div>
            <span className="small muted">Current plan</span>
            <h2 id="current-plan" style={{ fontSize: 26, marginTop: 2 }}>{plan.name}{!free && <span className="muted" style={{ fontSize: 16, fontWeight: 500, fontFamily: "var(--font)" }}> · {granted ? "free month" : `$${plan.price}/month`}</span>}</h2>
            <p>
              {free
                ? user.trialEnded || !user.trialEndsAt
                  ? "Your free trial has ended. Your posts are still here; upgrade to keep creating."
                  : <><Clock size={14} aria-hidden="true" style={{ verticalAlign: -2 }} /> Free trial · {timeLeft(user.trialEndsAt)} (until {formatDate(user.trialEndsAt)})</>
                : granted
                  ? `Free until ${formatDate(user.periodEnd!)}. These credits and posts are for that month.`
                  : user.periodEnd
                    ? `This period ends on ${formatDate(user.periodEnd)}. Credits and posts reset then.`
                    : plan.description}
            </p>
          </div>
          {free && user.trialEnded && <span className="chip red">Trial ended</span>}
          {granted && <span className="chip green">Free month</span>}
        </div>
        <div className="usage">
          <Usage label="AI credits" used={user.used} limit={user.limit} share={creditsShare} />
          <Usage label="Posts" used={user.postsUsed} limit={user.postsLimit} share={postsShare} />
          <div className="stack" style={{ gap: 6 }}>
            <div className="usage-label"><span>Workspaces</span><span>{plan.workspaces}</span></div>
            <div className="usage-label"><span>Social accounts</span><span>{plan.accounts || "None"}</span></div>
            <div className="usage-label"><span>Storage</span><span>{plan.storageGb} GB</span></div>
            <div className="usage-label"><span>Auto-publishing</span><span>{plan.scheduling ? "Included" : "Not included"}</span></div>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="plans-title">
        <div className="section-head">
          <div>
            <h2 id="plans-title">{free ? "Choose a plan" : "Change plan"}</h2>
            <p>{PRICE_NOTE} Cancel any time.</p>
            {highlight && <p role="status" style={{ color: "var(--text)" }}>You picked <strong>{planById(highlight).name}</strong>. Check the details below and continue when you're ready.</p>}
          </div>
        </div>
        <div className="plan-grid">
          {paidPlans.map((id) => {
            const p = planById(id);
            const current = p.id === user.plan;
            const up = rank(p.id) > rank(user.plan);
            const label = !enabled ? "Payments open soon" : current ? "Current plan" : up || !user.hasSubscription ? `Upgrade to ${p.name}` : `Switch to ${p.name}`;
            const working = busy === p.id || busy === `portal-${p.id}`;
            return (
              <article key={p.id} ref={p.id === highlight ? wantedCard : undefined} aria-labelledby={`plan-${p.id}`}
                className={`card plan-card${current ? " current" : ""}${p.id === "growth" ? " popular" : ""}${p.id === highlight ? " wanted" : ""}`}>
                <div className="row between">
                  <h3 id={`plan-${p.id}`} style={{ fontSize: 20 }}>{p.name}</h3>
                  {current ? <span className="chip green">Your plan</span> : p.id === highlight ? <span className="chip violet">Your pick</span> : p.id === "growth" ? <span className="chip brand">Most popular</span> : null}
                </div>
                <div className="plan-price">${p.price}<small> /month</small></div>
                <p className="muted small">{p.description}</p>
                <ul className="list-plain plan-features">
                  {p.features.map((f) => <li key={f}><Check size={16} aria-hidden="true" />{f}</li>)}
                </ul>
                <button type="button" className={`btn block ${current ? "" : "primary"}`} disabled={!enabled || current || !user.verified || !!busy}
                  onClick={() => void choose(p.id as PaidPlanId)} aria-label={current ? `${p.name} is your current plan` : undefined}>
                  {working && <Spinner label="Opening checkout" />}{label}
                </button>
              </article>
            );
          })}
        </div>
        {user.hasSubscription && enabled && (
          <p className="hint" style={{ marginTop: 12 }}>
            Plan changes open the secure billing portal to confirm. Upgrades apply right away; you get the unused share of the extra credits for this period.
            {" "}<button type="button" className="link" onClick={() => void portal()} disabled={!!busy}>Open billing portal <ExternalLink size={12} aria-hidden="true" /></button>
          </p>
        )}
        {granted && !user.hasSubscription && enabled && (
          <p className="hint" style={{ marginTop: 12 }}>
            A paid plan starts when you subscribe. A higher plan than your free one applies straight away; otherwise it applies when the free month ends.
          </p>
        )}
      </section>

      {user.hasSubscription && (
        <section className="section card row wrap" aria-labelledby="withdraw-title" style={{ alignItems: "center", gap: 16 }}>
          <Undo2 size={22} aria-hidden="true" style={{ color: "var(--muted)", flex: "none" }} />
          <div className="grow" style={{ minWidth: 220 }}>
            <h2 id="withdraw-title" style={{ fontSize: 18 }}>Changed your mind?</h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              Within {WITHDRAWAL_DAYS} days of subscribing you can withdraw: we end the plan and refund what you paid, less the share of the plan you used.
              {" "}<Link to="/terms#withdrawal" className="link">How it works</Link>
            </p>
          </div>
          <Link to="/contact?topic=withdrawal" className="btn">Ask to withdraw<ArrowRight size={16} aria-hidden="true" /></Link>
        </section>
      )}

      <section className="section card" aria-labelledby="includes-title">
        <h2 id="includes-title" style={{ marginBottom: 14 }}>Every plan includes</h2>
        <ul className="list-plain includes">
          {planIncludes.map((f) => <li key={f}><Check size={16} aria-hidden="true" />{f}</li>)}
        </ul>
      </section>

      <section className="section" aria-labelledby="tariffs-title">
        <div className="section-head">
          <div>
            <h2 id="tariffs-title"><Sparkles size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />What AI work costs</h2>
            <p>{PRODUCT.name} plans come with AI credits each period. Making posts never costs credits, and AI work that fails is refunded.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">AI credit prices</caption>
            <thead><tr><th scope="col">What</th><th scope="col">Price</th></tr></thead>
            <tbody>
              {tariffs.map((t) => <tr key={t.name}><th scope="row" style={{ color: "var(--text)", textTransform: "none", letterSpacing: 0, fontSize: 14 }}>{t.name}</th><td>{t.text}</td></tr>)}
            </tbody>
          </table>
        </div>
      </section>
      {confirming && (
        <CheckoutConfirm plan={confirming} busy={busy === confirming} onClose={() => { if (!busy) setConfirming(null); }} onConfirm={() => void checkout(confirming)} />
      )}
    </main>
  );
}

/**
 * Before a first checkout: the plan, its price and renewal, and the consumer's express request for the plan to start
 * at once (required; the server records it, repeats it on Stripe's page and confirms it by email).
 */
function CheckoutConfirm({ plan, busy, onClose, onConfirm }: { plan: PaidPlanId; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const [agreed, setAgreed] = useState(false);
  const p = planById(plan);
  return (
    <Modal title={`${p.name} · $${p.price} a month`} onClose={onClose} footer={
      <>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Back</button>
        <button type="button" className="btn primary" onClick={onConfirm} disabled={!agreed || busy}>{busy && <Spinner label="Opening checkout" />}Continue to payment<ArrowRight size={16} aria-hidden="true" /></button>
      </>
    }>
      <div className="stack">
        <p>{PRICE_NOTE} The plan renews every month until you cancel it here in Billing. You pay on Stripe's secure page.</p>
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>{IMMEDIATE_START_TEXT}</span>
        </label>
        <p className="small muted">
          More: <Link to="/terms#withdrawal" className="link" target="_blank" rel="noopener">your right to withdraw</Link> ·{" "}
          <Link to="/terms" className="link" target="_blank" rel="noopener">Terms of Service</Link>
        </p>
      </div>
    </Modal>
  );
}

function Usage({ label, used, limit, share }: { label: string; used: number; limit: number; share: number }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="usage-label"><span><strong>{label}</strong></span><span>{number(Math.max(0, limit - used))} left</span></div>
      <div className={`meter${share >= 1 ? " bad" : share > 0.85 ? " warn" : ""}`} role="progressbar" aria-label={`${label} used`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)}>
        <span style={{ width: `${Math.max(used ? 2 : 0, share * 100)}%` }} />
      </div>
      <span className="small muted">{number(used)} of {number(limit)} used</span>
    </div>
  );
}
