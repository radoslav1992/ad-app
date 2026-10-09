import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, Rocket, PenSquare, Share2, Zap, Building2, CalendarDays } from "lucide-react";
import { api, fileUrl, number, useApi, useAuth, type Post } from "../lib";
import { useCurrentWorkspace } from "./workspace";
import { compact, engagementOf, formatMoney, orDash } from "./stats";
import { planById } from "../../shared/plans";
import { formats } from "../../shared/formats";
import type { AnalyticsResponse } from "../../shared/analytics";

// The dashboard home: what is waiting, what is left in the plan, and the next steps to get publishing.
type Counts = { blitz: number; making: number; approved: number; failed: number; total: number };
export function Home() {
  const workspace = useCurrentWorkspace();
  const { user } = useAuth();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [recent, setRecent] = useState<Post[]>([]);
  const [accounts, setAccounts] = useState<number | null>(null);
  useEffect(() => {
    void api<{ posts: Post[]; counts: Counts }>(`/posts?workspace=${workspace.id}&view=all&limit=8`).then((r) => { setCounts(r.counts); setRecent(r.posts); }).catch(() => {});
    void api<{ accounts: unknown[] }>(`/accounts?workspace=${workspace.id}`).then((r) => setAccounts(r.accounts?.length || 0)).catch(() => setAccounts(0));
  }, [workspace.id]);
  if (!user) return null;
  const plan = planById(user.plan);
  const steps = [
    { done: workspace.scan.status === "ready" && !!workspace.profile.product, label: "Brand profile ready", to: "/app/brand" },
    { done: (counts?.total || 0) > 0, label: "Make your first posts", to: "/app/blitz" },
    { done: (counts?.approved || 0) > 0, label: "Approve a post in Blitz", to: "/app/blitz" },
    { done: (accounts || 0) > 0, label: "Connect TikTok, Instagram, YouTube or LinkedIn", to: "/app/accounts" },
    { done: workspace.settings.schedule.autoSchedule, label: "Turn on auto-scheduling", to: "/app/calendar" },
    { done: workspace.settings.automation.enabled, label: "Get fresh posts every day", to: "/app/automations" },
  ];
  const first = user.name.split(" ")[0];
  return (
    <main className="page">
      <div className="page-head">
        <div><h1>Hi {first}</h1><p>Here's where {workspace.name} stands.</p></div>
        <div className="toolbar">
          <Link className="btn" to="/app/create"><PenSquare size={17} /> Create</Link>
          <Link className="btn primary" to="/app/blitz"><Rocket size={17} /> Open Blitz</Link>
        </div>
      </div>
      <div className="grid four" style={{ marginBottom: 18 }}>
        <Stat label="Ready to review" value={counts?.blitz} to="/app/blitz" />
        <Stat label="Being made" value={counts?.making} to="/app/content" />
        <Stat label="Approved" value={counts?.approved} to="/app/content" />
        <div className="card stat">
          <span className="muted small">{plan.name} plan</span>
          <strong>{number(Math.max(0, user.postsLimit - user.postsUsed))}</strong>
          <span className="small muted">posts left · {number(Math.max(0, user.limit - user.used))} AI credits</span>
        </div>
      </div>
      <AnalyticsSummary workspaceId={workspace.id} />
      <div className="grid two">
        <section className="card stack">
          <h2>Get set up</h2>
          {steps.map((s) => (
            <Link key={s.label} to={s.to} className="row" style={{ textDecoration: "none", color: s.done ? "var(--muted)" : undefined }}>
              {s.done ? <CheckCircle2 size={20} color="var(--green)" /> : <Circle size={20} color="var(--soft)" />}
              <span style={{ textDecoration: s.done ? "line-through" : undefined }}>{s.label}</span>
            </Link>
          ))}
        </section>
        <section className="card stack">
          <div className="row between"><h2>Recent posts</h2><Link to="/app/content" className="small">All content</Link></div>
          {recent.length ? (
            <div className="media-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              {recent.slice(0, 8).map((p) => (
                <Link key={p.id} to="/app/content" className="thumb" title={p.hook}>
                  {p.renderStatus === "ready" && (p.slides[0] || p.coverAssetId) ? <img src={fileUrl(p.slides[0] || p.coverAssetId)} alt={p.hook} loading="lazy" className={p.format === "carousel" ? "whole" : undefined} /> : null}
                  <span className="thumb-label">{formats[p.format].name}</span>
                </Link>
              ))}
            </div>
          ) : <p className="muted">No posts yet. <Link to="/app/blitz">Make your first batch</Link>.</p>}
        </section>
      </div>
      <div className="grid three" style={{ marginTop: 18 }}>
        <Shortcut to="/app/automations" icon={<Zap size={20} />} title="Automations" text="Fresh posts for review every day." />
        <Shortcut to="/app/calendar" icon={<CalendarDays size={20} />} title="Calendar" text="See what goes out when." />
        <Shortcut to="/app/accounts" icon={<Share2 size={20} />} title="Accounts" text="Connect where your posts go." />
        <Shortcut to="/app/brand" icon={<Building2 size={20} />} title="Brand" text="What every post is written from." />
      </div>
    </main>
  );
}
/** The last 30 days in four numbers, from the analytics page's data. */
function AnalyticsSummary({ workspaceId }: { workspaceId: string }) {
  const { data: a } = useApi<AnalyticsResponse>(`/workspaces/${workspaceId}/analytics?days=30`);
  if (!a) return null;
  const t = a.totals;
  const empty = !t.posts && !t.clicks && !t.conversions;
  const revenue = formatMoney(t.revenue);
  return (
    <section className="card stack" style={{ marginBottom: 18 }} aria-labelledby="home-analytics">
      <div className="row between"><h2 id="home-analytics">Last 30 days</h2><Link to="/app/analytics" className="small">Analytics</Link></div>
      {empty ? (
        <p className="muted">
          Views, likes, clicks and sales show up here a few hours after your first posts go out. <Link to="/app/analytics#tracking">Set up click tracking</Link>
        </p>
      ) : (
        <div className="an-home-stats">
          <div><strong>{orDash(t.views)}</strong><span>views</span></div>
          <div><strong>{orDash(engagementOf(t))}</strong><span>likes, comments and shares</span></div>
          <div><strong>{compact(t.clicks)}</strong><span>clicks to your site</span></div>
          <div><strong>{compact(t.conversions)}</strong><span>{t.conversions === 1 ? "sale" : "sales"}{revenue ? ` · ${revenue}` : ""}</span></div>
        </div>
      )}
    </section>
  );
}
function Stat({ label, value, to }: { label: string; value?: number; to: string }) {
  return (
    <Link to={to} className="card stat" style={{ textDecoration: "none" }}>
      <span className="muted small">{label}</span>
      <strong>{value === undefined ? "–" : number(value)}</strong>
    </Link>
  );
}
function Shortcut({ to, icon, title, text }: { to: string; icon: ReactNode; title: string; text: string }) {
  return (
    <Link to={to} className="card row" style={{ textDecoration: "none", alignItems: "flex-start" }}>
      <span className="logo-mark" style={{ background: "var(--navy)", color: "#fff" }}>{icon}</span>
      <span><strong>{title}</strong><br /><span className="muted small">{text}</span></span>
    </Link>
  );
}
