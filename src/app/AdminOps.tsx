import { useState, type FormEvent } from "react";
import { Activity, Gift, RefreshCw, Undo2 } from "lucide-react";
import { Spinner, useToast } from "../ui";
import { api, del, errorText, number, post, useApi } from "../lib";
import { paidPlans, planById } from "../../shared/plans";
import { WITHDRAWAL_DAYS } from "../../shared/withdrawal";
import { ConfirmDialog, Empty, ago, formatDate } from "./pickers";
import "./admin.css";

// Administrators: the operations view (ported from rech-bg's OperationsAdmin) and the billing tools — withdrawals
// within 14 days (WithdrawalAdmin) and free months of a plan (PlanGrants).

/* ------------------------------------------------------------------------------------------------ operations */

type Operations = {
  now: number;
  maintenance: { startedAt: number; finishedAt: number; failed: string[] } | null;
  stages: { name: string; at: number }[];
  failures: { area: string; code: string; count: number }[];
  active: { runs: number; publishing: number; overdue: number };
  accounts: { platform: string; total: number; recent: number }[];
  cleanup: { pending: number; overdue: number; oldest: number | null };
  stripe: { reconciliation: { at: number; checked: number; updated: number; failed: number } | null; renewalsOverdue: number; grants: number; lastWebhook: number | null };
  reviews: { area: "runs" | "cleanup"; ref: string; requestId: string | null; reason: string; createdAt: number }[];
};
const platformNames: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", linkedin: "LinkedIn" };
const serviceNames: Record<string, string> = { heygen: "HeyGen", fal: "fal", elevenlabs: "ElevenLabs", renderer: "Renderer", other: "Runs (other)", speech: "Transcription" };
/** "publish:tiktok" → "Publishing · TikTok"; a service area → its name. */
function areaName(area: string) {
  const [kind, platform] = area.split(":");
  if (platform) return `${kind === "publish" ? "Publishing" : "Post stats"} · ${platformNames[platform] || platform}`;
  return serviceNames[area] || area;
}
const reasonNames: Record<string, string> = {
  timeout: "timed out; the provider may still finish and bill", uncertain: "the request's answer was lost; it may have been accepted",
  failed: "failed while the provider was working", refused: "outside the media and library folders; nothing was deleted",
};

/** What needs attention, without the logs: the same data as the hourly summary e-mail, in more detail. */
export function OperationsTab() {
  const { data, loading, error, reload } = useApi<Operations>("/admin/operations");
  if (loading && !data) return <div className="skeleton" style={{ height: 320 }} aria-busy="true" />;
  if (error || !data) return <div className="notice bad" role="alert">{error || "Not available."} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>;
  const run = data.maintenance;
  const stale = !run || run.finishedAt < data.now - 2 * 3600;
  const recentStages = data.stages.filter((s) => s.at > data.now - 86400);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row between wrap">
        <div>
          <h2 style={{ fontSize: 20 }}><Activity size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />Operations</h2>
          <p className="muted small" style={{ marginTop: 4 }}>
            Last hourly maintenance: <strong>{run ? `${ago(run.finishedAt)} (${formatDate(run.finishedAt, true)})` : "no record yet"}</strong>
            {run && run.failed.length > 0 && <> · failed stages: <strong>{run.failed.join(", ")}</strong></>}
          </p>
        </div>
        <button type="button" className="btn sm" onClick={() => void reload()} disabled={loading}>{loading ? <Spinner label="Refreshing" /> : <RefreshCw size={14} aria-hidden="true" />}Refresh</button>
      </div>
      {stale && <div className="notice bad" role="alert">The hourly maintenance hasn't finished in the last 2 hours. Check the Worker's Cron Trigger and Workers Logs.</div>}
      {recentStages.length > 0 && (
        <div className="notice warn" role="note">
          Stages that failed in the last 24 hours: {recentStages.map((s) => `${s.name} (${ago(s.at)})`).join(", ")}. Search Workers Logs for “Maintenance stage failed”.
        </div>
      )}

      <div className="grid four ops-stats">
        <Stat label="Runs open over 1 hour" value={data.active.runs} sub="AI or render work; failed and refunded at 3 hours" />
        <Stat label="Publishing over 1 hour" value={data.active.publishing} sub="Given up at 2 hours" />
        <Stat label="Overdue scheduled posts" value={data.active.overdue} sub="Due over 15 minutes ago" />
        <Stat label="Cleanup waiting over 1 day" value={data.cleanup.overdue} sub={`${number(data.cleanup.pending)} waiting${data.cleanup.oldest ? ` · oldest ${ago(data.cleanup.oldest)}` : ""}`} />
      </div>

      <section className="card" aria-labelledby="ops-failures">
        <h3 id="ops-failures" className="ops-title">Failures in the last 24 hours</h3>
        {data.failures.length ? (
          <ul className="list-plain ops-rows" aria-label="Failures in the last 24 hours, most frequent first">
            {data.failures.map((f) => (
              <li key={f.area + f.code}>
                <span className="ops-what">
                  <span className="ops-area">{areaName(f.area)}</span>
                  {/^[A-Z][A-Z0-9_]+$|^[a-z_]+$/.test(f.code) ? <code className="ops-code">{f.code}</code> : <span className="small">{f.code}</span>}
                </span>
                <strong className="ops-count">{number(f.count)}</strong>
              </li>
            ))}
          </ul>
        ) : <p className="muted">None.</p>}
        <p className="hint" style={{ marginTop: 10 }}>Runs show our own codes (AVATAR_ is HeyGen, GENERATION_ is fal, VOICE_ is ElevenLabs); failed runs are refunded. Publishing shows what people read.</p>
      </section>

      <div className="grid two">
        <section className="card" aria-labelledby="ops-accounts">
          <h3 id="ops-accounts" className="ops-title">Accounts to reconnect</h3>
          {data.accounts.length ? (
            <ul className="list-plain ops-list">
              {data.accounts.map((a) => <li key={a.platform}><span>{platformNames[a.platform] || a.platform}</span><span><strong>{number(a.total)}</strong>{a.recent > 0 && <span className="muted"> · {number(a.recent)} in the last 24 h</span>}</span></li>)}
            </ul>
          ) : <p className="muted">None.</p>}
          <p className="hint" style={{ marginTop: 10 }}>Many in one day usually means a network revoked tokens or the app's credentials changed (docs/SOCIAL.md).</p>
        </section>
        <section className="card" aria-labelledby="ops-stripe">
          <h3 id="ops-stripe" className="ops-title">Stripe</h3>
          <ul className="list-plain ops-list">
            <li>
              <span>Nightly reconciliation</span>
              <span>{data.stripe.reconciliation
                ? <>{ago(data.stripe.reconciliation.at)} · {number(data.stripe.reconciliation.checked)} checked · {number(data.stripe.reconciliation.updated)} updated{data.stripe.reconciliation.failed > 0 && <strong className="ops-bad"> · {number(data.stripe.reconciliation.failed)} failed</strong>}</>
                : <span className="muted">No record yet</span>}</span>
            </li>
            <li><span>Renewals overdue by over 4 days</span><strong className={data.stripe.renewalsOverdue ? "ops-bad" : undefined}>{number(data.stripe.renewalsOverdue)}</strong></li>
            <li><span>Last webhook event</span><span>{data.stripe.lastWebhook ? ago(data.stripe.lastWebhook) : <span className="muted">None in 90 days</span>}</span></li>
            <li><span>Free months running</span><strong>{number(data.stripe.grants)}</strong></li>
          </ul>
        </section>
      </div>

      <section className="card" aria-labelledby="ops-reviews">
        <h3 id="ops-reviews" className="ops-title">Set aside for a manual check (last 7 days)</h3>
        {data.reviews.length ? (
          <ul className="list-plain ops-rows" aria-label="Work set aside for a manual check, newest first">
            {data.reviews.map((r) => (
              <li key={r.area + r.ref}>
                <span className="ops-what col">
                  <span className="ops-area">{r.area === "runs" ? "Provider work of a failed run" : "Storage cleanup"}</span>
                  <code className="ops-code">{r.ref}</code>
                  {r.requestId && <span className="small">{r.requestId}</span>}
                  <span className="small muted">{reasonNames[r.reason] || r.reason}</span>
                </span>
                <span className="small muted ops-count" title={formatDate(r.createdAt, true)}>{ago(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted">None.</p>}
        <p className="hint" style={{ marginTop: 10 }}>
          The person's credits were already refunded. Find the request in the provider's dashboard and cancel it, or note what it billed. Summary e-mails go to
          ADMIN_EMAILS when something needs a look, at most every 6 hours for the same state (docs/OPERATIONS.md).
        </p>
      </section>
    </div>
  );
}
function Stat({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className={`card stat-card${value > 0 ? " bad" : ""}`}>
      <span className="label">{label}</span>
      <strong>{number(value)}</strong>
      <span className="sub">{sub}</span>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ billing */

export function BillingTab() {
  return (
    <div className="stack" style={{ gap: 20 }}>
      <WithdrawalCard />
      <GrantsCard />
    </div>
  );
}

type Quote = {
  email: string; plan: string | null; status: string; startedAt: number; deadline: number; open: boolean; paid: number; currency: string;
  used: number; quota: number; postsUsed: number; postsQuota: number; meter: "credits" | "posts"; refund: number;
  withdrawal: { refund: number; refunded: number; status: string; error: string | null; created_at: number } | null;
};
type WithdrawalRow = { id: string; email: string | null; currency: string; paid: number; refund: number; refunded: number; status: string; error: string | null; created_at: number };
const money = (cents: number, currency = "usd") => (cents / 100).toLocaleString("en-US", { style: "currency", currency: currency.toUpperCase() });
const percent = (used: number, quota: number) => (quota > 0 ? `${Math.round((Math.min(used, quota) / quota) * 100)}%` : "–");
const statusNames: Record<string, string> = { completed: "Refunded", refund_failed: "Refund by hand", started: "In progress" };
const subscriptionNames: Record<string, string> = { active: "active", past_due: "payment failed", unpaid: "unpaid", canceled: "cancelled", incomplete: "checkout not finished", trialing: "trial" };

/**
 * Withdrawal within 14 days: the plan ends at once (no further charges, posts and credits stop) and what was paid comes
 * back less the share used. The administrator checks the amount first; one action then does both, recorded.
 */
function WithdrawalCard() {
  const toast = useToast();
  const list = useApi<{ withdrawals: WithdrawalRow[] }>("/admin/withdrawals");
  const [email, setEmail] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState<"check" | "run" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const check = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("check"); setProblem(null); setQuote(null); setRequested(false);
    try { setQuote(await api<Quote>(`/admin/withdrawals/quote?email=${encodeURIComponent(email.trim())}`)); }
    catch (err) { setProblem(errorText(err)); }
    finally { setBusy(null); }
  };
  const run = async () => {
    if (!quote) return;
    setBusy("run"); setProblem(null);
    try {
      const { withdrawal: w } = await post<{ withdrawal: { refund: number; refunded: number; currency: string; status: string; error: string | null } }>("/admin/withdrawals", { email: email.trim(), refund: quote.refund });
      if (w.status === "completed") toast(`The plan ended and ${money(w.refunded, w.currency)} was refunded.`, "good");
      else setProblem(`The plan ended, but only ${money(w.refunded, w.currency)} of ${money(w.refund, w.currency)} was refunded. ${w.error || ""}`);
      setQuote(null); setEmail("");
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(null);
      void list.reload();
    }
  };
  const usedLine = (q: Quote) => `${number(q.used)} of ${number(q.quota)} AI credits (${percent(q.used, q.quota)}) · ${number(q.postsUsed)} of ${number(q.postsQuota)} posts (${percent(q.postsUsed, q.postsQuota)})`;
  return (
    <section className="card" aria-labelledby="withdrawal-title">
      <div className="card-head">
        <div>
          <h2 id="withdrawal-title"><Undo2 size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />Withdrawal within {WITHDRAWAL_DAYS} days</h2>
          <p>
            When a customer withdraws in time: the plan ends now, its posts and AI credits stop, and we refund what was paid less the share used — the larger of the
            posts share and the AI credits share. A full refund or a dispute in Stripe also ends the plan by itself.
          </p>
        </div>
      </div>
      <form className="field-row" onSubmit={check}>
        <label className="grow">
          <span className="sr-only">Customer's email</span>
          <input className="input" type="email" required maxLength={254} value={email} placeholder="Customer's email" autoComplete="off"
            onChange={(e) => { setEmail(e.target.value); setQuote(null); setProblem(null); }} />
        </label>
        <button type="submit" className="btn" disabled={!email.trim() || !!busy}>{busy === "check" && <Spinner label="Checking" />}Check</button>
      </form>
      {problem && <div className="notice bad" role="alert" style={{ marginTop: 12 }}>{problem}</div>}
      {quote && (
        <div className="ops-quote" aria-live="polite">
          <dl className="ops-dl">
            <div><dt>Plan</dt><dd>{quote.plan || "—"} · {subscriptionNames[quote.status] || quote.status}</dd></div>
            <div><dt>Subscribed</dt><dd>{formatDate(quote.startedAt)} · can withdraw until {formatDate(quote.deadline)}</dd></div>
            <div><dt>Paid</dt><dd>{money(quote.paid, quote.currency)}</dd></div>
            <div><dt>Used this period</dt><dd>{usedLine(quote)}</dd></div>
            <div><dt>To refund</dt><dd><strong>{money(quote.refund, quote.currency)}</strong> <span className="muted">(by the {quote.meter === "posts" ? "posts" : "AI credits"} share)</span></dd></div>
          </dl>
          {quote.withdrawal ? (
            <div className="notice" role="status">
              Already handled on {formatDate(quote.withdrawal.created_at)}: {statusNames[quote.withdrawal.status] || quote.withdrawal.status},{" "}
              {money(quote.withdrawal.refunded, quote.currency)} of {money(quote.withdrawal.refund, quote.currency)}.
            </div>
          ) : !quote.open ? (
            <div className="notice warn" role="status">The withdrawal period ended on {formatDate(quote.deadline)}. The customer can still cancel, without a refund.</div>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              <label className="check">
                <input type="checkbox" checked={requested} onChange={(e) => setRequested(e.target.checked)} />
                <span>The customer told us within the {WITHDRAWAL_DAYS} days that they withdraw (contact form, email or the model form).</span>
              </label>
              <button type="button" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={!requested || !!busy} onClick={() => void run()}>
                {busy === "run" && <Spinner label="Working" />}End the plan and refund {money(quote.refund, quote.currency)}
              </button>
            </div>
          )}
        </div>
      )}
      {!!list.data?.withdrawals.length && (
        <div style={{ marginTop: 18 }}>
          <h3 className="ops-title">Recent withdrawals</h3>
          <ul className="list-plain ops-rows wrap" aria-label="Recent withdrawals, newest first">
            {list.data.withdrawals.map((w) => (
              <li key={w.id}>
                <span className="ops-what col">
                  <span className="ops-area">{w.email || <span className="muted">Deleted account</span>}</span>
                  <span className="small muted">
                    {formatDate(w.created_at)} · paid {money(w.paid, w.currency)} · refunded {money(w.refunded, w.currency)}
                    {w.refunded < w.refund && ` of ${money(w.refund, w.currency)}`}
                  </span>
                </span>
                <span className={`chip ${w.status === "completed" ? "green" : w.status === "refund_failed" ? "red" : ""}`}>{statusNames[w.status] || w.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

type Grant = { id: string; plan: string; start: number; end: number; email: string; name: string; used: number; postsUsed: number };
/** A paid plan for one month without payment (testers, partners), with the running grants. */
function GrantsCard() {
  const toast = useToast();
  const { data, error, reload } = useApi<{ grants: Grant[]; now: number }>("/admin/grants");
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState<string>("growth");
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renewing, setRenewing] = useState<Grant | null>(null);
  const [ending, setEnding] = useState<Grant | null>(null);
  const grant = async (to: string, chosen: string, key: string) => {
    setBusy(key); setProblem(null); setNotice(null);
    try {
      const r = await post<{ end: number; paidPlan: string | null }>("/admin/grants", { email: to, plan: chosen });
      toast(`${to} has ${planById(chosen).name} until ${formatDate(r.end)}.`, "good");
      if (r.paidPlan) setNotice(`${to} also pays for ${planById(r.paidPlan).name} in Stripe. That subscription keeps billing while the free month runs.`);
      if (key === "grant") setEmail("");
      await reload();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const running = data?.grants.filter((g) => g.end > data.now) || [], ended = data?.grants.filter((g) => g.end <= data.now) || [];
  return (
    <section className="card" aria-labelledby="grants-title">
      <div className="card-head">
        <div>
          <h2 id="grants-title"><Gift size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />Free month of a plan</h2>
          <p>
            For testers and partners: the plan with all its posts and AI credits for 30 days, without payment. Afterwards the person goes back to their paid plan
            or the free plan. Giving it again starts a new month with a full plan. Stripe never sees it.
          </p>
        </div>
      </div>
      <form className="field-row wrap" onSubmit={(e) => { e.preventDefault(); void grant(email.trim(), plan, "grant"); }}>
        <label className="grow ops-email">
          <span className="sr-only">Person's email</span>
          <input className="input" type="email" required maxLength={254} value={email} placeholder="Person's email (they need an account)" autoComplete="off" onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="ops-plan">
          <span className="sr-only">Plan</span>
          <select className="select" value={plan} onChange={(e) => setPlan(e.target.value)}>
            {paidPlans.map((id) => { const p = planById(id); return <option key={id} value={id}>{p.name} · {number(p.posts)} posts · {number(p.credits)} credits</option>; })}
          </select>
        </label>
        <button type="submit" className="btn primary" disabled={!email.trim() || !!busy}>{busy === "grant" && <Spinner label="Giving" />}Give for 1 month</button>
      </form>
      {problem && <div className="notice bad" role="alert" style={{ marginTop: 12 }}>{problem}</div>}
      {notice && <div className="notice warn" role="status" style={{ marginTop: 12 }}>{notice}</div>}
      {error && <div className="notice bad" role="alert" style={{ marginTop: 12 }}>{error}</div>}
      {data && (running.length ? (
        <ul className="list-plain ops-rows wrap" style={{ marginTop: 12 }} aria-label="Running free months">
          {running.map((g) => (
            <li key={g.id}>
              <span className="ops-what col">
                <span className="ops-area">{g.email}{g.name && <span className="muted" style={{ fontWeight: 400 }}> · {g.name}</span>}</span>
                <span className="small muted">{planById(g.plan).name} until {formatDate(g.end)} · used {number(g.postsUsed)} posts and {number(g.used)} credits</span>
              </span>
              <span className="row" style={{ gap: 6, flex: "none" }}>
                <button type="button" className="btn sm" disabled={!!busy} onClick={() => setRenewing(g)}>{busy === `renew:${g.id}` && <Spinner label="Renewing" />}New month</button>
                <button type="button" className="btn sm ghost danger" disabled={!!busy} onClick={() => setEnding(g)}>End now</button>
              </span>
            </li>
          ))}
        </ul>
      ) : <Empty icon={<Gift size={24} />} title="No free months running">Give one above.</Empty>)}
      {ended.length > 0 && <p className="hint" style={{ marginTop: 12 }}>Ended in the last 90 days: {ended.map((g) => `${g.email} (${planById(g.plan).name}, until ${formatDate(g.end)})`).join(", ")}.</p>}
      {renewing && (
        <ConfirmDialog title="Start a new month?" confirmLabel="Start a new month" danger={false} onClose={() => setRenewing(null)} onConfirm={async () => {
          const g = renewing;
          setRenewing(null);
          await grant(g.email, g.plan, `renew:${g.id}`);
        }}>
          <p>{renewing.email} gets a new month of {planById(renewing.plan).name} from today, with all its posts and credits.</p>
        </ConfirmDialog>
      )}
      {ending && (
        <ConfirmDialog title="End this free month now?" confirmLabel="End now" onClose={() => setEnding(null)} onConfirm={async () => {
          await del(`/admin/grants/${ending.id}`);
          toast("The free month ended.", "good");
          await reload();
        }}>
          <p>{ending.email} goes back to their paid plan or the free plan straight away.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
