import { useEffect, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  House, Rocket, Lightbulb, Zap, Wand2, UserRound, Clapperboard, Images, CalendarDays, BarChart3, CircleDollarSign, Building2, Share2,
  Settings, Shield, PanelLeftClose, PanelLeftOpen, Clock, Menu, ChevronDown, Plus, PenSquare, LogOut, Scissors,
} from "lucide-react";
import { post, timeLeft, useAuth, fileUrl, number } from "../lib";
import { useWorkspace } from "./workspace";
import { planById } from "../../shared/plans";
import { useToast } from "../ui";
import "./app.css";

/** The dashboard: sidebar, plan bar and the current page. Sends people without a finished onboarding there. */
export function AppLayout() {
  const { user, refresh } = useAuth();
  const { workspaces, workspace, loading, select } = useWorkspace();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("pl-nav") === "collapsed"; } catch { return false; } });
  const [open, setOpen] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  if (!user) return null;
  if (loading) return <div className="loading-page" role="status">Loading…</div>;
  if (!workspaces.length || !user.onboarding.completedAt) return <Navigate to="/app/onboarding" replace />;
  const plan = planById(user.plan);
  const free = user.plan === "free";
  const ready = workspace?.ready || 0;
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem("pl-nav", collapsed ? "open" : "collapsed"); } catch { /* private mode */ }
  };
  const item = (to: string, Icon: typeof House, label: string, extra: { badge?: number; dot?: boolean; className?: string; end?: boolean } = {}) => (
    <NavLink to={to} end={extra.end} className={({ isActive }) => `nav-item${isActive ? " active" : ""}${extra.className ? " " + extra.className : ""}`} title={collapsed ? label : undefined}>
      <Icon size={20} aria-hidden="true" />
      <span className="text">{label}</span>
      {!!extra.badge && <span className="badge" aria-label={`${extra.badge} ready`}>{extra.badge > 99 ? "99+" : extra.badge}</span>}
      {extra.dot && <span className="dot" style={{ marginLeft: "auto" }} aria-label="Needs attention" />}
    </NavLink>
  );
  const logout = async () => {
    await post("/auth/logout").catch(() => {});
    await refresh();
    navigate("/");
  };
  const brandNeedsWork = !!workspace && (workspace.scan.status === "failed" || (!workspace.profile.product && workspace.scan.status !== "scanning"));
  return (
    <div className={`app-shell${collapsed ? " collapsed" : ""}`}>
      <aside className={`sidebar${open ? " open" : ""}`} aria-label="Main">
        <div className="sidebar-head">
          <button className="ws-switch" onClick={() => setSwitcher(!switcher)} aria-expanded={switcher} aria-haspopup="menu">
            {workspace?.logoAssetId ? <img className="ws-logo" src={fileUrl(workspace.logoAssetId)} alt="" /> : <span className="ws-logo">{workspace?.name.slice(0, 1).toUpperCase()}</span>}
            <span className="ws-name">{workspace?.name}</span>
            {!collapsed && <ChevronDown size={16} aria-hidden="true" />}
          </button>
          <button className="btn icon ghost" onClick={toggle} aria-label={collapsed ? "Expand the menu" : "Collapse the menu"}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        {switcher && (
          <div className="card flat" role="menu" style={{ padding: 8, marginBottom: 8 }}>
            {workspaces.map((w) => (
              <button key={w.id} role="menuitemradio" aria-checked={w.id === workspace?.id} className="nav-item" style={{ width: "100%", background: w.id === workspace?.id ? "#eceef2" : "none", border: 0, cursor: "pointer" }}
                onClick={() => { select(w.id); setSwitcher(false); }}>
                <span className="text">{w.name}</span>
              </button>
            ))}
            <Link className="nav-item" to="/app/settings#workspaces" onClick={() => setSwitcher(false)}><Plus size={16} /><span className="text">Add workspace</span></Link>
          </div>
        )}
        {item("/app", House, "Home", { end: true })}
        {item("/app/blitz", Rocket, "Blitz")}
        {item("/app/create", PenSquare, "Create")}
        {item("/app/clips", Scissors, "Clips")}
        {item("/app/inspiration", Lightbulb, "Inspiration")}
        {item("/app/automations", Zap, "Automations", { className: "highlight" })}
        {item("/app/studio", Wand2, "AI Studio")}
        {item("/app/characters", UserRound, "Creators")}
        {item("/app/content", Clapperboard, "Content", { badge: ready })}
        {item("/app/library", Images, "Library")}
        {item("/app/calendar", CalendarDays, "Calendar")}
        {item("/app/analytics", BarChart3, "Analytics")}
        <div className="nav-sep" />
        {(free || user.plan === "starter") && item("/app/billing", CircleDollarSign, "Upgrade", { className: "upgrade" })}
        {item("/app/brand", Building2, "Brand", { dot: brandNeedsWork })}
        {item("/app/accounts", Share2, "Accounts")}
        {item("/app/settings", Settings, "Settings")}
        {user.admin && item("/app/admin", Shield, "Admin")}
        <div style={{ flex: 1 }} />
        <button className="nav-item" style={{ background: "none", border: 0, cursor: "pointer", width: "100%" }} onClick={logout}><LogOut size={20} /><span className="text">Log out</span></button>
      </aside>
      {open && <div className="sidebar-scrim" role="presentation" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className={`topbar${free ? "" : " plain"}`}>
          <div className="row">
            <button className="btn icon ghost mobile-only" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open} style={{ display: "none" }}><Menu size={20} /></button>
            {free ? (
              <span className="trial"><Clock size={18} aria-hidden="true" /> Free trial <span className="muted">· {user.trialEnded || !user.trialEndsAt ? "ended" : timeLeft(user.trialEndsAt)}</span></span>
            ) : (
              <span className="small muted"><strong style={{ color: "var(--text)" }}>{plan.name}</strong> · {number(user.limit - user.used)} credits · {number(user.postsLimit - user.postsUsed)} posts left</span>
            )}
          </div>
          <Link to="/app/billing" className="upgrade-pill">{free ? "Upgrade" : "Plan"}</Link>
        </header>
        {!user.verified && (
          <div className="banner">
            Confirm your email to use AI credits and subscribe. <button className="link" onClick={() => post("/auth/resend").then(() => toast("We sent the link again.", "good")).catch((e) => toast(e.message, "bad"))}>Send the link again</button>
          </div>
        )}
        {user.paymentIssue && <div className="banner bad">Your last payment didn't go through. <Link to="/app/billing">Update your card</Link> to keep your plan.</div>}
        {user.trialEnded && <div className="banner bad">Your free trial has ended. Your posts are still here — <Link to="/app/billing">upgrade</Link> to keep creating.</div>}
        <Outlet />
      </div>
      <style>{`@media (max-width: 860px) { .mobile-only { display: inline-flex !important; } }`}</style>
    </div>
  );
}
