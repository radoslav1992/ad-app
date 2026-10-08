import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import { Link } from "react-router-dom";
import {
  CalendarPlus, ChevronLeft, ChevronRight, Clock, ExternalLink, Film, Inbox, Plus, RotateCcw, Save, Trash2, X,
} from "lucide-react";
import { api, del, errorText, fileUrl, patch, post as send, useApi, useAuth, usePoll, type Post, type Workspace } from "../lib";
import { Modal, Spinner, Switch, useToast } from "../ui";
import { useCurrentWorkspace, useWorkspace } from "./workspace";
import { PostPlayer } from "./PostView";
import {
  AccountAvatar, DATE_TIME, HORIZON_SECONDS, LEAD_SECONDS, PlatformDots, ScheduleDialog, StatusChip, formatAt, formatTime, fromInputValue, handleText,
  statusLabels, toInputValue, wallClock, zoneLabel, zoneOf,
  type AccountsResponse, type CalendarResponse, type Publication, type PublicationStatus, type ScheduleResult,
} from "./ScheduleDialog";
import { platforms } from "../../shared/social";
import { zonedTime, type Schedule } from "../../shared/schedule";
import { planById } from "../../shared/plans";
import { formats } from "../../shared/formats";
import "./schedule.css";

// The workspace's publications on a month or week calendar, the approved posts still waiting for a time, and the
// posting schedule (time zone, daily times, weekdays, auto-scheduling). Times show in the workspace's time zone.

type View = "month" | "week";
type Civil = { y: number; m: number; d: number };
const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const civilAt = (ms: number): Civil => { const x = new Date(ms); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() }; };
const utcOf = (c: Civil) => Date.UTC(c.y, c.m - 1, c.d);
const addDays = (c: Civil, n: number) => civilAt(Date.UTC(c.y, c.m - 1, c.d + n));
const keyOf = (c: Civil) => `${c.y}-${pad(c.m)}-${pad(c.d)}`;
const mondayOf = (c: Civil) => addDays(c, -((new Date(utcOf(c)).getUTCDay() + 6) % 7));
const civilFormat = (c: Civil, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(new Date(utcOf(c)));
const todayIn = (tz: string): Civil => { const w = wallClock(Date.now() / 1000, tz); return { y: w.y, m: w.m, d: w.d }; };
/** Monday-first weekday names (2024-01-01 was a Monday). */
const weekdayNames = (style: "short" | "long") => Array.from({ length: 7 }, (_, i) => civilFormat({ y: 2024, m: 1, d: 1 + i }, { weekday: style }));
/** The weekday values of the schedule (0 = Sunday) in Monday-first order. */
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** The days a view shows around `anchor`: a week, or the whole weeks that hold the month. */
function viewDays(view: View, anchor: Civil) {
  if (view === "week") { const start = mondayOf(anchor); return Array.from({ length: 7 }, (_, i) => addDays(start, i)); }
  const start = mondayOf({ y: anchor.y, m: anchor.m, d: 1 });
  const end = addDays(mondayOf(addDays({ y: anchor.y, m: anchor.m + 1, d: 1 }, -1)), 7);
  return Array.from({ length: Math.round((utcOf(end) - utcOf(start)) / DAY_MS) }, (_, i) => addDays(start, i));
}

/** One post at one time on the calendar (its publications to several accounts together). */
type Item = { key: string; postId: string; at: number; hook: string; format: string; pubs: Publication[]; status: PublicationStatus };
const rank: PublicationStatus[] = ["failed", "publishing", "scheduled", "published", "canceled"];
const combined = (pubs: Publication[]) => rank.find((s) => pubs.some((p) => p.status === s)) || "scheduled";
/** Whether a publication changes soon on its own (publishing now, or due within the next minutes). */
const moving = (p: Publication) => p.status === "publishing" || (p.status === "scheduled" && p.scheduledAt * 1000 < Date.now() + 120_000);

export function CalendarPage() {
  const workspace = useCurrentWorkspace();
  return <CalendarScreen key={workspace.id} workspace={workspace} />;
}

function CalendarScreen({ workspace }: { workspace: Workspace }) {
  const { user } = useAuth();
  const toast = useToast();
  const tz = zoneOf(workspace);
  const canSchedule = planById(user?.plan).scheduling;
  const [view, setViewState] = useState<View>(() => { try { return localStorage.getItem("pl-calendar-view") === "week" ? "week" : "month"; } catch { return "month"; } });
  const setView = (v: View) => {
    setViewState(v);
    try { localStorage.setItem("pl-calendar-view", v); } catch { /* private mode */ }
  };
  const [anchor, setAnchor] = useState<Civil>(() => todayIn(tz));
  const days = useMemo(() => viewDays(view, anchor), [view, anchor]);
  const from = Math.round(zonedTime(days[0].y, days[0].m, days[0].d, 0, 0, tz));
  const last = addDays(days[days.length - 1], 1);
  const to = Math.round(zonedTime(last.y, last.m, last.d, 0, 0, tz));
  const calendar = useApi<CalendarResponse>(`/workspaces/${workspace.id}/calendar?from=${from}&to=${to}`);
  // The next ~100 days, to know which approved posts already have a time (the visible range may be elsewhere).
  const [upcomingRange] = useState(() => { const t = Math.floor(Date.now() / 1000); return { from: t - 30 * 86400, to: t + 69 * 86400 }; });
  const upcoming = useApi<CalendarResponse>(`/workspaces/${workspace.id}/calendar?from=${upcomingRange.from}&to=${upcomingRange.to}`);
  const accounts = useApi<AccountsResponse>(`/accounts?workspace=${workspace.id}`);
  const [detail, setDetail] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<Post | null>(null);
  const [scheduledIds, setScheduledIds] = useState<Set<string>>(() => new Set());
  const [trayVersion, setTrayVersion] = useState(0);

  const { reload: reloadCalendar } = calendar, { reload: reloadUpcoming } = upcoming;
  const reloadAll = useCallback(() => {
    void reloadCalendar();
    void reloadUpcoming();
  }, [reloadCalendar, reloadUpcoming]);
  const changed = useCallback(() => {
    reloadAll();
    setTrayVersion((v) => v + 1);
  }, [reloadAll]);
  useEffect(() => { if (calendar.error) toast(calendar.error, "bad"); }, [calendar.error, toast]);
  const live = !!calendar.data?.publications.some(moving);
  usePoll(reloadAll, 30_000, live);

  const today = keyOf(todayIn(tz));
  const items = useMemo(() => {
    const byDay = new Map<string, Item[]>();
    const groups = new Map<string, Item>();
    for (const p of calendar.data?.publications || []) {
      const k = `${p.postId}|${p.scheduledAt}`;
      let item = groups.get(k);
      if (!item) {
        item = { key: k, postId: p.postId, at: p.scheduledAt, hook: p.hook || "", format: p.format || "", pubs: [], status: "scheduled" };
        groups.set(k, item);
        const w = wallClock(p.scheduledAt, tz);
        const dk = keyOf(w);
        if (!byDay.has(dk)) byDay.set(dk, []);
        byDay.get(dk)!.push(item);
      }
      item.pubs.push(p);
    }
    for (const item of groups.values()) item.status = combined(item.pubs);
    for (const list of byDay.values()) list.sort((a, b) => a.at - b.at);
    return byDay;
  }, [calendar.data, tz]);
  const slotsByDay = useMemo(() => {
    const m = new Map<string, number[]>();
    for (const s of calendar.data?.slots || []) {
      const k = keyOf(wallClock(s, tz));
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return m;
  }, [calendar.data, tz]);
  const known = useMemo(() => {
    const s = new Set(scheduledIds);
    for (const p of [...(calendar.data?.publications || []), ...(upcoming.data?.publications || [])]) s.add(p.postId);
    return s;
  }, [calendar.data, upcoming.data, scheduledIds]);

  const move = (n: number) => {
    if (view === "week") return setAnchor(addDays(anchor, 7 * n));
    const m0 = anchor.m - 1 + n;
    setAnchor({ y: anchor.y + Math.floor(m0 / 12), m: (((m0 % 12) + 12) % 12) + 1, d: 1 });
  };
  const label = view === "month"
    ? civilFormat({ ...anchor, d: 1 }, { month: "long", year: "numeric" })
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).formatRange(new Date(utcOf(days[0])), new Date(utcOf(days[6])));
  const tabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next: View = view === "month" ? "week" : "month";
    setView(next);
    document.getElementById(`sc-tab-${next}`)?.focus();
  };
  const closeDetail = useCallback(() => setDetail(null), []);
  const closeScheduling = useCallback(() => setScheduling(null), []);
  const onScheduled = useCallback((r: ScheduleResult) => {
    setScheduledIds((s) => new Set(s).add(r.publications[0]?.postId ?? ""));
    changed();
  }, [changed]);
  const openItem = (item: Item) => setDetail(item.postId);
  const expired = (accounts.data?.accounts || []).filter((a) => a.status !== "active");

  const itemButton = (item: Item, compact: boolean) => (
    <button key={item.key} type="button" className={`sc-item ${item.status}`} onClick={() => openItem(item)}
      aria-label={`${formatTime(item.at, tz)}, ${[...new Set(item.pubs.map((p) => platforms[p.platform]?.name))].join(", ")}, ${statusLabels[item.status]}: ${item.hook || "Untitled post"}`}>
      <span className="sc-item-top">
        <PlatformDots list={item.pubs.map((p) => p.platform)} />
        <time dateTime={new Date(item.at * 1000).toISOString()}>{formatTime(item.at, tz)}</time>
        <StatusChip status={item.status} compact={compact} />
      </span>
      <span className="sc-hook">{item.hook || "Untitled post"}</span>
    </button>
  );

  return (
    <main className="page sc-page">
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p>Scheduled and published posts for {workspace.name}. Times are in {zoneLabel(tz)}.</p>
        </div>
      </div>

      {!canSchedule && (
        <div className="notice warn sc-notice">
          Scheduling and auto-publishing are part of the paid plans. You can still set up your posting times. <Link to="/app/billing">See plans</Link>
        </div>
      )}
      {canSchedule && accounts.data && !accounts.data.accounts.length && (
        <div className="notice sc-notice">
          Connect TikTok, Instagram, YouTube or LinkedIn to start publishing. <Link to="/app/accounts">Connect accounts</Link>
        </div>
      )}
      {!!expired.length && (
        <div className="notice bad sc-notice">
          {expired.length === 1 ? `Your ${platforms[expired[0].platform].name} account ${expired[0].name} needs reconnecting.` : `${expired.length} accounts need reconnecting.`}{" "}
          Posts to {expired.length === 1 ? "it" : "them"} can't go out until then. <Link to="/app/accounts">Reconnect</Link>
        </div>
      )}

      <section className="card sc-cal" aria-labelledby="sc-range">
        <div className="sc-cal-bar">
          <div className="tabs" role="tablist" aria-label="Calendar view">
            {(["month", "week"] as const).map((v) => (
              <button key={v} id={`sc-tab-${v}`} type="button" role="tab" aria-selected={view === v} aria-controls="sc-cal-panel" tabIndex={view === v ? 0 : -1}
                onClick={() => setView(v)} onKeyDown={tabKey}>
                {v === "month" ? "Month" : "Week"}
              </button>
            ))}
          </div>
          <div className="row sc-nav">
            <button type="button" className="btn icon" onClick={() => move(-1)} aria-label={view === "month" ? "Previous month" : "Previous week"}><ChevronLeft size={18} /></button>
            <button type="button" className="btn sm" onClick={() => setAnchor(todayIn(tz))}>Today</button>
            <button type="button" className="btn icon" onClick={() => move(1)} aria-label={view === "month" ? "Next month" : "Next week"}><ChevronRight size={18} /></button>
          </div>
          <h2 id="sc-range" className="sc-range" aria-live="polite">{label}</h2>
          {calendar.loading && <Spinner label="Loading the calendar" />}
        </div>

        <div id="sc-cal-panel" role="tabpanel" aria-labelledby={`sc-tab-${view}`}>
          {calendar.error && !calendar.data ? (
            <div className="empty">
              <p>{calendar.error}</p>
              <button type="button" className="btn" onClick={() => void calendar.reload()}>Try again</button>
            </div>
          ) : view === "month" ? (
            <MonthGrid days={days} month={anchor.m} today={today} items={items} itemButton={itemButton}
              onMore={(c) => { setAnchor(c); setView("week"); }} />
          ) : (
            <WeekGrid days={days} today={today} items={items} slots={slotsByDay} tz={tz} itemButton={itemButton} />
          )}
          {calendar.data && !calendar.data.publications.length && !calendar.loading && (
            <p className="small muted sc-cal-empty">Nothing scheduled {view === "month" ? "this month" : "this week"}. Schedule an approved post below, or turn on auto-scheduling.</p>
          )}
        </div>
      </section>

      <div className="grid two sc-below">
        <ApprovedTray workspace={workspace} known={known} version={trayVersion} onSchedule={setScheduling} />
        <ScheduleSettings workspace={workspace} accounts={accounts.data} canSchedule={canSchedule} onSaved={changed} />
      </div>

      {detail && !scheduling && (
        <PostPanel postId={detail} tz={tz} onClose={closeDetail} onChanged={changed} onScheduleMore={setScheduling} />
      )}
      {scheduling && (
        <ScheduleDialog post={scheduling} workspace={workspace} onClose={closeScheduling} onScheduled={onScheduled} />
      )}
    </main>
  );
}

type ItemButton = (item: Item, compact: boolean) => ReactElement;

function MonthGrid({ days, month, today, items, itemButton, onMore }: {
  days: Civil[]; month: number; today: string; items: Map<string, Item[]>; itemButton: ItemButton; onMore: (c: Civil) => void;
}) {
  const names = weekdayNames("short");
  return (
    <div className="sc-month">
      <div className="sc-weekdays" aria-hidden="true">{names.map((n) => <span key={n}>{n}</span>)}</div>
      <ol className="sc-month-grid">
        {days.map((c) => {
          const k = keyOf(c), list = items.get(k) || [];
          const shown = list.slice(0, 3), more = list.length - shown.length;
          return (
            <li key={k} className={`sc-day${c.m !== month ? " out" : ""}${k === today ? " today" : ""}`}>
              <span className="sc-daynum" aria-hidden="true">{c.d}</span>
              <span className="sr-only">{civilFormat(c, { weekday: "long", month: "long", day: "numeric" })}{k === today ? " (today)" : ""}{list.length ? `, ${list.length} posts` : ""}</span>
              {shown.map((item) => itemButton(item, true))}
              {more > 0 && (
                <button type="button" className="sc-more" onClick={() => onMore(c)} aria-label={`${more} more on ${civilFormat(c, { month: "long", day: "numeric" })}: show the week`}>
                  +{more} more
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function WeekGrid({ days, today, items, slots, tz, itemButton }: {
  days: Civil[]; today: string; items: Map<string, Item[]>; slots: Map<string, number[]>; tz: string; itemButton: ItemButton;
}) {
  return (
    <ol className="sc-week">
      {days.map((c) => {
        const k = keyOf(c);
        const list = items.get(k) || [];
        const free = (slots.get(k) || []).filter((s) => !list.some((i) => Math.abs(i.at - s) < 600));
        const entries = [
          ...list.map((item) => ({ at: item.at, item })),
          ...free.map((at) => ({ at, item: null as Item | null })),
        ].sort((a, b) => a.at - b.at);
        return (
          <li key={k} className={`sc-week-day${k === today ? " today" : ""}`}>
            <h3 className="sc-week-head">
              <span className="sc-week-name">{civilFormat(c, { weekday: "short" })}</span>
              <span className="sc-daynum">{c.d}</span>
              <span className="sr-only">{civilFormat(c, { month: "long" })}{k === today ? " (today)" : ""}</span>
            </h3>
            <div className="sc-week-list">
              {entries.map((e) => e.item ? itemButton(e.item, false) : (
                <div key={`slot-${e.at}`} className="sc-slot" title="A free time in your posting schedule">
                  <Clock size={12} aria-hidden="true" /> <time dateTime={new Date(e.at * 1000).toISOString()}>{formatTime(e.at, tz)}</time> <span>Free slot</span>
                </div>
              ))}
              {!entries.length && <span className="sc-week-empty" aria-hidden="true">—</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* A post's publications: preview, move, cancel, retry, open                                                          */

function PostPanel({ postId, tz, onClose, onChanged, onScheduleMore }: {
  postId: string; tz: string; onClose: () => void; onChanged: () => void; onScheduleMore: (post: Post) => void;
}) {
  const toast = useToast();
  const postQ = useApi<{ post: Post }>(`/posts/${postId}`);
  const pubsQ = useApi<{ publications: Publication[] }>(`/posts/${postId}/publications`);
  const [muted, setMuted] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const pubs = useMemo(() => {
    const order = (p: Publication) => (p.status === "canceled" ? 1 : 0);
    return [...(pubsQ.data?.publications || [])].sort((a, b) => order(a) - order(b) || a.scheduledAt - b.scheduledAt);
  }, [pubsQ.data]);
  usePoll(() => void pubsQ.reload(), 30_000, pubs.some(moving));
  const post = postQ.data?.post;
  const act = async (id: string, run: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await run();
      toast(done, "good");
      await pubsQ.reload();
      onChanged();
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(null);
    }
  };
  const canMore = !!post && post.status === "approved" && post.renderStatus === "ready";
  return (
    <Modal wide title="Post details" onClose={onClose}
      footer={<>
        <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        <button type="button" className="btn primary" disabled={!canMore} onClick={() => post && onScheduleMore(post)}
          title={post && !canMore ? "Only approved, finished posts can be scheduled." : undefined}>
          <CalendarPlus size={16} aria-hidden="true" /> Schedule to more accounts
        </button>
      </>}>
      <div className="sc-panel">
        <div className="sc-panel-player">
          {post ? <PostPlayer post={post} muted={muted} onMute={setMuted} /> : postQ.error ? <div className="notice bad">{postQ.error}</div> : <div className="phone-frame placeholder"><Spinner big label="Loading the post" /></div>}
        </div>
        <div className="stack sc-panel-side">
          {post && (
            <div className="stack sc-panel-text">
              <span className="chip">{formats[post.format]?.name || post.format}</span>
              <p className="sc-panel-hook">{post.hook || "Untitled post"}</p>
              {post.caption && <p className="small muted sc-clamp-3">{post.caption}</p>}
            </div>
          )}
          <h3>Publications</h3>
          {pubsQ.loading && !pubsQ.data ? <Spinner label="Loading publications" />
            : pubsQ.error ? <div className="notice bad" role="alert">{pubsQ.error} <button type="button" className="link" onClick={() => void pubsQ.reload()}>Try again</button></div>
            : !pubs.length ? <p className="muted small">This post isn't scheduled anywhere yet.</p>
            : (
              <ul className="sc-pubs">
                {pubs.map((p) => (
                  <PublicationRow key={`${p.id}-${p.scheduledAt}-${p.status}`} pub={p} tz={tz} busy={busy === p.id} disabled={!!busy}
                    onMove={(at) => act(p.id, () => patch(`/publications/${p.id}`, { at }), `Moved to ${formatAt(at, tz)}.`)}
                    onCancel={() => act(p.id, () => del(`/publications/${p.id}`), `Canceled on ${p.accountName}.`)}
                    onRetry={() => act(p.id, () => send(`/publications/${p.id}/retry`), "Trying again in about a minute.")} />
                ))}
              </ul>
            )}
        </div>
      </div>
    </Modal>
  );
}

function PublicationRow({ pub, tz, busy, disabled, onMove, onCancel, onRetry }: {
  pub: Publication; tz: string; busy: boolean; disabled: boolean; onMove: (at: number) => void; onCancel: () => void; onRetry: () => void;
}) {
  const original = toInputValue(pub.scheduledAt, tz);
  const [value, setValue] = useState(original);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bounds] = useState(() => ({ min: Date.now() / 1000 + LEAD_SECONDS + 60, max: Date.now() / 1000 + HORIZON_SECONDS - 3600 }));
  const name = platforms[pub.platform]?.name || "the network";
  const inputId = `sc-move-${pub.id}`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const at = fromInputValue(value, tz), now = Date.now() / 1000;
    if (at === null) return setError("Choose a date and time.");
    if (at < now + LEAD_SECONDS || at > now + HORIZON_SECONDS) return setError("Pick a time at least a minute from now and within the next 180 days.");
    setError(null);
    onMove(at);
  };
  const safeUrl = pub.url && /^https:\/\//.test(pub.url) ? pub.url : null;
  return (
    <li className={`sc-pub ${pub.status}`}>
      <div className="row">
        <AccountAvatar name={pub.accountName} platform={pub.platform} size={34} />
        <div className="grow">
          <strong>{pub.accountName}</strong> {pub.accountHandle && <span className="muted small">{handleText(pub.accountHandle)}</span>}
          <div className="small muted">
            {name} · {pub.status === "published" && pub.publishedAt ? `Published ${formatAt(pub.publishedAt, tz)}` : formatAt(pub.scheduledAt, tz, DATE_TIME)}
          </div>
        </div>
        <StatusChip status={pub.status} />
      </div>
      {pub.status === "failed" && pub.error && <p className="notice bad small">{pub.error}</p>}
      {pub.status === "publishing" && <p className="small muted">Sending it to {name} now. This usually takes a minute or two.</p>}
      {pub.status === "published" && !safeUrl && <p className="small muted">Published. {name} didn't share a link (private posts get none).</p>}

      {pub.status === "scheduled" && !confirming && (
        <form className="sc-move" onSubmit={submit}>
          <label htmlFor={inputId} className="small">Move to</label>
          <input id={inputId} type="datetime-local" className="input sc-move-input" value={value} onChange={(e) => setValue(e.target.value)}
            min={toInputValue(bounds.min, tz)} max={toInputValue(bounds.max, tz)} aria-describedby={error ? `${inputId}-error` : undefined} aria-invalid={!!error} />
          <button type="submit" className="btn sm" disabled={disabled || value === original}>{busy ? <Spinner label="Moving" /> : <Clock size={14} aria-hidden="true" />} Move</button>
          <button type="button" className="btn sm danger" disabled={disabled} onClick={() => setConfirming(true)}><X size={14} aria-hidden="true" /> Cancel post</button>
          {error && <span id={`${inputId}-error`} className="error small" role="alert">{error}</span>}
        </form>
      )}
      {pub.status === "scheduled" && confirming && (
        <div className="notice warn sc-confirm" role="alertdialog" aria-label="Cancel this post?">
          <span>Cancel this post on {pub.accountName}? It won't be published there.</span>
          <span className="row">
            <button type="button" className="btn sm" onClick={() => setConfirming(false)} autoFocus>Keep it</button>
            <button type="button" className="btn sm danger" disabled={disabled} onClick={onCancel}>{busy ? <Spinner label="Canceling" /> : <Trash2 size={14} aria-hidden="true" />} Cancel post</button>
          </span>
        </div>
      )}
      {(pub.status === "failed" || safeUrl) && (
        <div className="row wrap">
          {pub.status === "failed" && (
            <button type="button" className="btn sm" disabled={disabled} onClick={onRetry}>{busy ? <Spinner label="Retrying" /> : <RotateCcw size={14} aria-hidden="true" />} Retry</button>
          )}
          {safeUrl && (
            <a className="btn sm" href={safeUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} aria-hidden="true" /> Open on {name}<span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Approved posts without a time                                                                                      */

function ApprovedTray({ workspace, known, version, onSchedule }: { workspace: Workspace; known: Set<string>; version: number; onSchedule: (post: Post) => void }) {
  const postsQ = useApi<{ posts: Post[] }>(`/posts?workspace=${workspace.id}&view=approved&limit=50`);
  // Posts outside the loaded calendar ranges are checked one by one (whether any publication exists).
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const inflight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const first = useRef(true);
  const { reload } = postsQ;
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setChecked({});
    void reload();
  }, [version, reload]);
  const posts = postsQ.data?.posts || [];
  const candidates = posts.filter((p) => !known.has(p.id));
  const pending = candidates.filter((p) => checked[p.id] === undefined).map((p) => p.id);
  const pendingKey = pending.join(",");
  useEffect(() => {
    const queue = pendingKey ? pendingKey.split(",").filter((id) => !inflight.current.has(id)) : [];
    if (!queue.length) return;
    queue.forEach((id) => inflight.current.add(id));
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        let has = false;
        try {
          const r = await api<{ publications: Publication[] }>(`/posts/${id}/publications`);
          has = r.publications.some((p) => p.status !== "canceled");
        } catch { /* shown in the tray; scheduling twice is refused by the server */ }
        inflight.current.delete(id);
        if (mounted.current) setChecked((c) => ({ ...c, [id]: has }));
      }
    };
    void Promise.all([worker(), worker(), worker()]);
  }, [pendingKey]);
  const waiting = candidates.filter((p) => checked[p.id] === false);
  return (
    <section className="card sc-tray" aria-labelledby="sc-tray-title">
      <div className="row between">
        <h2 id="sc-tray-title"><Inbox size={18} aria-hidden="true" /> Approved, not scheduled</h2>
        {!!waiting.length && <span className="chip">{waiting.length}</span>}
      </div>
      {postsQ.loading && !postsQ.data ? (
        <div className="empty"><Spinner label="Loading approved posts" /></div>
      ) : postsQ.error ? (
        <div className="notice bad" role="alert">{postsQ.error} <button type="button" className="link" onClick={() => void postsQ.reload()}>Try again</button></div>
      ) : (
        <>
          {!!waiting.length && (
            <ul className="sc-tray-list">
              {waiting.map((p) => {
                const thumb = p.coverAssetId || p.slides[0];
                return (
                  <li key={p.id} className="sc-tray-item">
                    <span className="sc-thumb">{thumb ? <img src={fileUrl(thumb)} alt="" loading="lazy" /> : <Film size={18} aria-hidden="true" />}</span>
                    <span className="grow">
                      <span className="sc-clamp-2">{p.hook || "Untitled post"}</span>
                      <span className="small muted">{formats[p.format]?.name || p.format}{p.renderStatus !== "ready" ? " · still being made" : ""}</span>
                    </span>
                    <button type="button" className="btn sm" onClick={() => onSchedule(p)} disabled={p.renderStatus !== "ready"}
                      aria-label={`Schedule: ${p.hook || "untitled post"}`}>
                      <CalendarPlus size={14} aria-hidden="true" /> Schedule
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {pending.length > 0 && <p className="small muted row"><Spinner label="Checking" /> Checking {pending.length} more…</p>}
          {!waiting.length && !pending.length && (
            <div className="empty sc-tray-empty">
              <p>Every approved post has a time.</p>
              <Link to="/app/blitz" className="btn sm">Approve more in Blitz</Link>
            </div>
          )}
          {posts.length >= 50 && <p className="hint">Showing your 50 most recent approved posts. Older ones are in <Link to="/app/content">Content</Link>.</p>}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Posting schedule settings                                                                                          */

const FALLBACK_ZONES = [
  "UTC", "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Amsterdam",
  "Europe/Brussels", "Europe/Zurich", "Europe/Vienna", "Europe/Stockholm", "Europe/Oslo", "Europe/Copenhagen", "Europe/Warsaw", "Europe/Prague",
  "Europe/Budapest", "Europe/Bucharest", "Europe/Sofia", "Europe/Athens", "Europe/Helsinki", "Europe/Kyiv", "Europe/Istanbul", "Europe/Moscow",
  "Africa/Casablanca", "Africa/Lagos", "Africa/Cairo", "Africa/Nairobi", "Africa/Johannesburg", "Asia/Jerusalem", "Asia/Riyadh", "Asia/Dubai",
  "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka", "Asia/Bangkok", "Asia/Jakarta", "Asia/Singapore", "Asia/Manila", "Asia/Hong_Kong", "Asia/Shanghai",
  "Asia/Taipei", "Asia/Seoul", "Asia/Tokyo", "Australia/Perth", "Australia/Adelaide", "Australia/Brisbane", "Australia/Sydney", "Pacific/Auckland",
  "America/St_Johns", "America/Halifax", "America/Sao_Paulo", "America/Argentina/Buenos_Aires", "America/Santiago", "America/Bogota", "America/Lima",
  "America/Mexico_City", "America/New_York", "America/Toronto", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Vancouver", "America/Anchorage", "Pacific/Honolulu",
];
function timeZones(current: string) {
  let list: string[] = [];
  try { list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []; } catch { list = []; }
  if (!list.length) list = FALLBACK_ZONES;
  let browser = "";
  try { browser = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* unknown */ }
  return [...new Set(["UTC", current, browser, ...list].filter(Boolean))].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));
}
const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function ScheduleSettings({ workspace, accounts, canSchedule, onSaved }: { workspace: Workspace; accounts: AccountsResponse | null; canSchedule: boolean; onSaved: () => void }) {
  const { update } = useWorkspace();
  const toast = useToast();
  const saved = workspace.settings.schedule;
  const [timezone, setTimezone] = useState(saved.timezone);
  const [times, setTimes] = useState([...saved.times].sort());
  const [days, setDays] = useState(saved.days);
  const [autoSchedule, setAuto] = useState(saved.autoSchedule);
  const [newTime, setNewTime] = useState("");
  const [timeError, setTimeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => timeZones(saved.timezone), [saved.timezone]);
  const browserZone = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; } }, []);
  const dirty = timezone !== saved.timezone || !sameList(times, [...saved.times].sort()) || !sameList([...days].sort(), [...saved.days].sort()) || autoSchedule !== saved.autoSchedule;
  const names = weekdayNames("short"), longNames = weekdayNames("long");
  const defaults = (accounts?.accounts || []).filter((a) => saved.accounts.includes(a.id));
  const addTime = (e?: FormEvent) => {
    e?.preventDefault();
    const t = newTime.slice(0, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return setTimeError("Enter a time like 09:30.");
    if (times.includes(t)) return setTimeError(`${t} is already in the list.`);
    if (times.length >= 12) return setTimeError("Up to 12 times a day.");
    setTimes([...times, t].sort());
    setNewTime("");
    setTimeError(null);
  };
  const toggleDay = (d: number) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort());
  const reset = () => { setTimezone(saved.timezone); setTimes([...saved.times].sort()); setDays(saved.days); setAuto(saved.autoSchedule); setTimeError(null); };
  const save = async () => {
    setBusy(true);
    try {
      // The whole schedule is sent; default accounts that were disconnected are dropped (the server refuses them).
      const kept = accounts ? saved.accounts.filter((id) => accounts.accounts.some((a) => a.id === id)) : saved.accounts;
      const schedule: Schedule = { ...saved, timezone, times, days, autoSchedule, accounts: kept };
      const r = await patch<{ workspace: Workspace }>(`/workspaces/${workspace.id}`, { settings: { schedule } });
      update(r.workspace);
      toast("Posting schedule saved.", "good");
      onSaved();
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card sc-settings" aria-labelledby="sc-settings-title">
      <h2 id="sc-settings-title">Posting schedule</h2>
      <p className="small muted">The times "Next free slot" and auto-scheduling use. Each time takes one post.</p>
      <div className="stack">
        <div className="field">
          <label htmlFor="sc-tz" className="label">Time zone</label>
          <select id="sc-tz" className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)} aria-describedby="sc-tz-hint">
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, " ")}</option>)}
          </select>
          <span id="sc-tz-hint" className="hint">
            {zoneLabel(timezone)}.{" "}
            {browserZone && browserZone !== timezone && (
              <button type="button" className="link" onClick={() => setTimezone(browserZone)}>Use {browserZone.replace(/_/g, " ")}</button>
            )}
          </span>
        </div>

        <div className="field">
          <span className="label" id="sc-times-label">Posting times</span>
          {times.length ? (
            <ul className="sc-tags" aria-labelledby="sc-times-label">
              {times.map((t) => (
                <li key={t} className="chip">
                  {t}
                  <button type="button" className="sc-tag-remove" onClick={() => setTimes(times.filter((x) => x !== t))} aria-label={`Remove ${t}`}><X size={12} /></button>
                </li>
              ))}
            </ul>
          ) : <p className="small muted">No times yet: nothing goes out on its own.</p>}
          <form className="row" onSubmit={addTime}>
            <label htmlFor="sc-new-time" className="sr-only">New posting time</label>
            <input id="sc-new-time" type="time" className="input sc-time-input" value={newTime} step={60}
              onChange={(e) => { setNewTime(e.target.value); setTimeError(null); }} aria-invalid={!!timeError} aria-describedby="sc-time-hint" />
            <button type="submit" className="btn" disabled={!newTime || times.length >= 12}><Plus size={16} aria-hidden="true" /> Add time</button>
          </form>
          <span id="sc-time-hint" className={timeError ? "error" : "hint"} role={timeError ? "alert" : undefined}>{timeError || "24-hour, in the time zone above. Up to 12 a day."}</span>
        </div>

        <div className="field">
          <span className="label" id="sc-days-label">Days</span>
          <div className="sc-days" role="group" aria-labelledby="sc-days-label">
            {MONDAY_FIRST.map((d, i) => (
              <button key={d} type="button" className="sc-day-toggle" aria-pressed={days.includes(d)} aria-label={longNames[i]} onClick={() => toggleDay(d)}>{names[i]}</button>
            ))}
          </div>
          {!days.length && <span className="hint">Choose at least one day.</span>}
        </div>

        <div className="sc-auto">
          <div className="grow">
            <strong id="sc-auto-label">Auto-schedule</strong>
            <p className="small muted">Approving a post in Blitz schedules it in the next free slot.</p>
          </div>
          {canSchedule ? <Switch checked={autoSchedule} onChange={setAuto} label="Auto-schedule approved posts" /> : <Link to="/app/billing" className="btn sm">Upgrade</Link>}
        </div>
        {canSchedule && autoSchedule && (
          accounts && !defaults.length ? (
            <div className="notice warn small">No default accounts yet, so approved posts won't be scheduled. <Link to="/app/accounts">Choose them in Accounts</Link>.</div>
          ) : accounts ? (
            <p className="small muted">Goes to {defaults.map((a) => a.name).join(", ")}. <Link to="/app/accounts">Change</Link></p>
          ) : null
        )}

        <div className="row between sc-settings-foot">
          <button type="button" className="btn ghost sm" onClick={reset} disabled={!dirty || busy}>Undo changes</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={!dirty || busy}>
            {busy ? <Spinner label="Saving" /> : <Save size={16} aria-hidden="true" />} Save schedule
          </button>
        </div>
      </div>
    </section>
  );
}
