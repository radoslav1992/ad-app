import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  BarChart3, Check, CircleDollarSign, Copy, ExternalLink, Eye, Film, Heart, Link2, MessageCircle, MousePointerClick, Repeat2, ShoppingBag,
} from "lucide-react";
import { errorText, fileUrl, number, patch, useApi, type Workspace } from "../lib";
import { Spinner, Switch, useToast } from "../ui";
import { useCurrentWorkspace } from "./workspace";
import { Empty, Tabs, ago, tabPanel } from "./pickers";
import { PlatformIcon } from "./ScheduleDialog";
import { compact, engagementOf, formatMoney, orDash, plural } from "./stats";
import { platforms } from "../../shared/social";
import { PRODUCT } from "../../shared/brand";
import { RATE_HINTS, rates, type AnalyticsResponse, type NetworkRow, type SetupResponse, type TopPost } from "../../shared/analytics";

// How the workspace's posts are doing: lifetime stats from the networks for posts published in the range, clicks on
// tracked links and the sales they led to, per network and per post; and the setup for links and sale tracking.

type Range = "7" | "30";
const RANGE_KEY = "pl-analytics-range";
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dateOf = (day: string) => dayFormat.format(new Date(`${day}T00:00:00Z`));

export function AnalyticsPage() {
  const workspace = useCurrentWorkspace();
  return <AnalyticsScreen key={workspace.id} workspace={workspace} />;
}

function AnalyticsScreen({ workspace }: { workspace: Workspace }) {
  const [range, setRangeState] = useState<Range>(() => { try { return localStorage.getItem(RANGE_KEY) === "7" ? "7" : "30"; } catch { return "30"; } });
  const setRange = (r: Range) => {
    setRangeState(r);
    try { localStorage.setItem(RANGE_KEY, r); } catch { /* private mode */ }
  };
  const q = useApi<AnalyticsResponse>(`/workspaces/${workspace.id}/analytics?days=${range}`);
  const setup = useApi<SetupResponse>(`/workspaces/${workspace.id}/analytics/setup`);
  const a = q.data;
  // Arriving at #tracking (from Home): the setup card renders once its data is in, so scroll to it then.
  const { hash } = useLocation();
  const setupReady = !!setup.data;
  useEffect(() => {
    if (hash === "#tracking" && setupReady) document.getElementById("tracking")?.scrollIntoView({ block: "start" });
  }, [hash, setupReady]);
  const nothing = !!a && !a.totals.posts && !a.totals.clicks && !a.totals.conversions;
  return (
    <main className="page an-page">
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>How {workspace.name}'s posts are doing, and the visits and sales they bring.</p>
        </div>
        <Tabs label="Time range" idBase="an-range" value={range} onChange={setRange}
          items={[{ id: "7", label: "Last 7 days" }, { id: "30", label: "Last 30 days" }]} />
      </div>
      <p className="small muted an-scope">
        {a?.lastUpdated ? `Stats updated ${ago(a.lastUpdated)}. ` : ""}
        Views, likes, comments and shares are lifetime counts for posts published in this period, as the networks report
        them. Clicks and sales count on the day they happen (UTC).
      </p>
      <div {...tabPanel("an-range", range)} className="an-body" aria-busy={q.loading && !!a}>
        {!a ? (
          q.error ? (
            <div className="empty card"><p>{q.error}</p><button type="button" className="btn" onClick={() => void q.reload()}>Try again</button></div>
          ) : <div className="loading-page"><Spinner big label="Loading analytics" /></div>
        ) : nothing ? (
          <Empty icon={<BarChart3 size={24} />} title={`Nothing to count in the last ${range} days yet`}
            action={<div className="row wrap" style={{ justifyContent: "center" }}><Link className="btn primary" to="/app/calendar">Open the calendar</Link><a className="btn" href="#tracking">Set up click tracking</a></div>}>
            Views, likes, comments and shares appear a few hours after your posts go out on TikTok, Instagram or YouTube.
            Clicks and sales appear once people follow your tracked links.
          </Empty>
        ) : (
          <>
            <Totals a={a} />
            <div className="an-grid">
              <ClicksChart a={a} />
              <Networks a={a} />
            </div>
            <TopPosts a={a} />
          </>
        )}
      </div>
      <div style={{ marginTop: 16 }}>
        <Setup workspace={workspace} q={setup} />
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------------------------------------ totals */

function Tile({ icon, label, value, sub, long = false }: { icon: ReactNode; label: string; value: string; sub?: string; long?: boolean }) {
  return (
    <div className="an-tile">
      <span className="label">{icon}{label}</span>
      <strong className={long ? "long" : undefined} title={value === "–" ? "Not reported yet" : undefined}>{value}</strong>
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

function Totals({ a }: { a: AnalyticsResponse }) {
  const t = a.totals;
  const revenue = formatMoney(t.revenue);
  const icon = (I: typeof Eye) => <I size={15} aria-hidden="true" />;
  return (
    <div className="an-kpis">
      <section className="card an-group" aria-labelledby="an-net-title">
        <div className="an-group-head">
          <h2 id="an-net-title">On the networks</h2>
          <p className="small muted">
            {t.posts ? `${t.withStats} of ${plural(t.posts, "post")} published in this period ${t.withStats === 1 ? "has" : "have"} stats so far.` : "No posts were published in this period."}
          </p>
        </div>
        <div className="an-tiles four">
          <Tile icon={icon(Eye)} label="Views" value={orDash(t.views)} />
          <Tile icon={icon(Heart)} label="Likes" value={orDash(t.likes)} />
          <Tile icon={icon(MessageCircle)} label="Comments" value={orDash(t.comments)} />
          <Tile icon={icon(Repeat2)} label="Shares" value={orDash(t.shares)} />
        </div>
      </section>
      <section className="card an-group" aria-labelledby="an-site-title">
        <div className="an-group-head">
          <h2 id="an-site-title">On your site</h2>
          <p className="small muted">From your tracked links and the sales snippet.</p>
        </div>
        <div className="an-tiles three">
          <Tile icon={icon(MousePointerClick)} label="Clicks" value={compact(t.clicks)} />
          <Tile icon={icon(ShoppingBag)} label="Sales" value={compact(t.conversions)}
            sub={a.unattributed.conversions ? `${number(a.unattributed.conversions)} not from a tracked link` : undefined} />
          <Tile icon={icon(CircleDollarSign)} label="Revenue" value={revenue || "–"} long={!!revenue && revenue.length > 9} />
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ clicks per day */

/** A round top for the axis, close above `max`: 1, 2, 3, 4, 5, 6, 8 or 10 × 10ⁿ. */
function niceMax(max: number) {
  if (max <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((v) => v >= max) || 10 * p;
}

function ClicksChart({ a }: { a: AnalyticsResponse }) {
  const days = a.daily;
  const [active, setActive] = useState<number | null>(null);
  const [focus, setFocus] = useState(days.length - 1);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const top = niceMax(Math.max(0, ...days.map((d) => d.clicks)));
  const ticks = top % 2 === 0 ? [top, top / 2] : [top];
  const n = days.length;
  const labelAt = new Set([0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1]);
  const total = days.reduce((s, d) => s + d.clicks, 0);
  const busiest = days.reduce((best, d) => (d.clicks > best.clicks ? d : best), days[0]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const next = e.key === "ArrowRight" ? Math.min(n - 1, i + 1) : e.key === "ArrowLeft" ? Math.max(0, i - 1) : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setFocus(next);
    setActive(next);
    buttons.current[next]?.focus();
  };
  const tip = active === null ? null : days[active];
  const pct = (v: number) => (v / top) * 100;
  return (
    <section className="card an-card" aria-labelledby="an-chart-title">
      <div className="an-card-head">
        <div>
          <h2 id="an-chart-title">Clicks per day</h2>
          <p className="small muted">{total ? `${plural(total, "click")} on your tracked links${busiest.clicks ? `, most on ${dateOf(busiest.day)} (${number(busiest.clicks)})` : ""}.` : "People following your tracked links, by day."}</p>
        </div>
      </div>
      <div className="an-chart">
        <div className="an-plot" role="group" aria-label={`Clicks per day, ${dateOf(days[0].day)} to ${dateOf(days[n - 1].day)}. Use the arrow keys to move between days.`}
          onPointerLeave={() => setActive(null)}>
          {ticks.map((v) => (
            <div key={v} className="an-gridline" style={{ bottom: `${pct(v)}%` }} aria-hidden="true">
              <span className="an-ytick">{compact(v)}</span>
            </div>
          ))}
          <span className="an-ytick" style={{ bottom: 0, transform: "translateY(50%)" }} aria-hidden="true">0</span>
          {days.map((d, i) => (
            <button key={d.day} type="button" ref={(el) => { buttons.current[i] = el; }}
              className={`an-slot${active === i ? " active" : ""}`} tabIndex={i === focus ? 0 : -1}
              aria-label={`${dateOf(d.day)}: ${plural(d.clicks, "click")}, ${plural(d.conversions, "sale")}`}
              onPointerEnter={() => setActive(i)} onFocus={() => { setActive(i); setFocus(i); }} onBlur={() => setActive(null)} onKeyDown={(e) => onKey(e, i)}>
              {d.clicks > 0 && <span className="an-bar" style={{ height: `${pct(d.clicks)}%` }} />}
            </button>
          ))}
          {tip && active !== null && (
            <div className="an-tip" aria-hidden="true" style={{
              left: `${((active + 0.5) / n) * 100}%`, bottom: `calc(${Math.min(pct(tip.clicks), 70)}% + 10px)`,
              transform: `translateX(${active < n * 0.2 ? "-15%" : active > n * 0.8 ? "-85%" : "-50%"})`,
            }}>
              <strong>{plural(tip.clicks, "click")}</strong>
              <span>{plural(tip.conversions, "sale")} · {dateOf(tip.day)}</span>
            </div>
          )}
          {!total && <div className="an-chart-empty"><span>No clicks in this period yet. They show up here once people follow your tracked links.</span></div>}
        </div>
        <div className="an-xaxis" aria-hidden="true">
          {days.map((d, i) => labelAt.has(i) && (
            <span key={d.day} className={i === 0 ? "first" : i === n - 1 ? "last" : undefined} style={{ left: `${((i + (i === 0 ? 0 : i === n - 1 ? 1 : 0.5)) / n) * 100}%` }}>{dateOf(d.day)}</span>
          ))}
        </div>
      </div>
      <details className="an-details">
        <summary>Show the numbers</summary>
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Clicks and sales per day</caption>
            <thead><tr><th scope="col">Day (UTC)</th><th scope="col" className="an-num">Clicks</th><th scope="col" className="an-num">Sales</th></tr></thead>
            <tbody>
              {[...days].reverse().map((d) => (
                <tr key={d.day}><th scope="row" style={{ fontWeight: 500 }}>{dateOf(d.day)}</th><td className="an-num">{number(d.clicks)}</td><td className="an-num">{number(d.conversions)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ networks */

function Networks({ a }: { a: AnalyticsResponse }) {
  const notes = a.networks.flatMap((n) => n.notes.map((note) => ({ ...note, platform: n.platform })));
  const na = <span className="an-na">Not shared</span>;
  const cell = (n: NetworkRow, v: number | null) => (n.statsAvailable ? orDash(v, true) : na);
  return (
    <section className="card an-card" aria-labelledby="an-net-table">
      <div className="an-card-head">
        <div>
          <h2 id="an-net-table">By network</h2>
          <p className="small muted">Posts published in this period, and the clicks and sales each network brought.</p>
        </div>
      </div>
      {a.networks.length ? (
        <div className="table-wrap an-table">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Network</th><th scope="col" className="an-num an-hide-sm">Posts</th><th scope="col" className="an-num">Views</th>
                <th scope="col" className="an-num an-hide-sm" title="Likes, comments and shares">Engagement</th><th scope="col" className="an-num">Clicks</th>
                <th scope="col" className="an-num">Sales</th><th scope="col" className="an-num an-hide-sm">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {a.networks.map((n) => (
                <tr key={n.platform}>
                  <th scope="row"><span className="an-network"><PlatformIcon platform={n.platform} size={22} />{platforms[n.platform].name}</span></th>
                  <td className="an-num an-hide-sm">{number(n.posts)}</td>
                  <td className="an-num">{cell(n, n.views)}</td>
                  <td className="an-num an-hide-sm">{cell(n, engagementOf(n))}</td>
                  <td className="an-num">{number(n.clicks)}</td>
                  <td className="an-num">{number(n.conversions)}</td>
                  <td className="an-num an-hide-sm">{formatMoney(n.revenue) || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted small">Connect an account and publish a post to see each network here.</p>}
      {!!notes.length && (
        <ul className="an-notes">
          {notes.map((note) => (
            <li key={`${note.platform}-${note.text}`} className={`an-note${note.tone === "warn" ? " warn" : ""}`}>
              <PlatformIcon platform={note.platform} size={20} />
              <span className="grow">{note.text}</span>
              {note.action === "reconnect" && <Link to="/app/accounts">Reconnect</Link>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------ top posts */

type SortKey = "views" | "clicks" | "conversions";
const sortLabels: Record<SortKey, string> = { views: "Views", clicks: "Clicks", conversions: "Sales" };

function TopPosts({ a }: { a: AnalyticsResponse }) {
  const [sort, setSort] = useState<SortKey>("views");
  const rows = useMemo(() => {
    const value = (p: TopPost) => (sort === "views" ? p.views ?? -1 : p[sort]);
    return [...a.top].filter((p) => sort === "views" || p[sort] > 0).sort((x, y) => value(y) - value(x)).slice(0, 10);
  }, [a.top, sort]);
  return (
    <section className="card an-card" aria-labelledby="an-top-title">
      <div className="an-card-head">
        <div>
          <h2 id="an-top-title">Top posts</h2>
          <p className="small muted">Each post per network, published in this period or bringing clicks and sales in it.</p>
          <p className="small muted an-rate-note">
            The share and save rates are per view. A rule of thumb from creators: posts shared by {Math.round(RATE_HINTS.shares * 100)}% or saved by{" "}
            {Math.round(RATE_HINTS.saves * 100)}% of their viewers tend to reach many more people (marked in green). A sign, not a promise. Only Instagram reports saves.
          </p>
        </div>
        <div className="an-sort" role="group" aria-label="Sort top posts by">
          {(Object.keys(sortLabels) as SortKey[]).map((k) => (
            <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>{sortLabels[k]}</button>
          ))}
        </div>
      </div>
      {!rows.length ? (
        <p className="muted small">{sort === "views" ? "Posts published in this period show up here, ranked by views." : `No post brought ${sort === "clicks" ? "clicks" : "sales"} in this period yet.`}</p>
      ) : (
        <ol className="an-top">
          {rows.map((p, i) => <TopRow key={`${p.postId}-${p.platform}`} p={p} rank={i + 1} sort={sort} />)}
        </ol>
      )}
    </section>
  );
}

function TopRow({ p, rank, sort }: { p: TopPost; rank: number; sort: SortKey }) {
  const name = platforms[p.platform].name;
  const engagement = engagementOf(p);
  const rate = engagement !== null && p.views ? `${((engagement / p.views) * 100).toFixed(1)}%` : null;
  // Shares and saves per view, marked when they reach the rule of thumb.
  const r = rates(p);
  const share = (n: number | null, of: number | null, hint: number, what: string) => (n === null ? "–" : (
    <>{compact(n)}{of !== null && <small className={of >= hint ? "an-strong" : undefined} title={`${(of * 100).toFixed(1)}% of views ${what}${of >= hint ? ` (${Math.round(hint * 100)}% or more often goes far)` : ""}`}>{(of * 100).toFixed(1)}%</small>}</>
  ));
  const to = `/app/content?post=${p.postId}`;
  const hook = p.deleted ? "Deleted post" : p.hook || "Untitled post";
  const stat = (key: SortKey | "engagement" | "revenue" | "shares" | "saves", label: string, value: ReactNode) => (
    <div className={key === sort ? "sorted" : undefined}><dt>{label}</dt><dd>{value}</dd></div>
  );
  return (
    <li className="an-top-row">
      <span className="an-rank" aria-hidden="true">{rank}</span>
      <span className="an-thumb">{p.thumbAssetId && !p.deleted ? <img src={fileUrl(p.thumbAssetId)} alt="" loading="lazy" className={p.format === "carousel" ? "whole" : undefined} /> : <Film size={18} aria-hidden="true" />}</span>
      <div className="an-top-main">
        {p.deleted ? <span className="an-top-hook">{hook}</span> : <Link to={to} className="an-top-hook">{hook}</Link>}
        <span className="an-top-meta">
          <PlatformIcon platform={p.platform} size={18} /> {name}
          {p.publishedAt ? <> · {new Date(p.publishedAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</> : null}
          {p.url && <> · <a href={p.url} target="_blank" rel="noopener noreferrer">Open on {name} <ExternalLink size={12} aria-hidden="true" /><span className="sr-only"> (opens in a new tab)</span></a></>}
        </span>
      </div>
      <dl className="an-top-stats">
        {stat("views", "Views", p.platform === "linkedin" ? <span className="an-na">Not shared</span> : orDash(p.views))}
        {stat("engagement", "Engagement", engagement === null ? "–" : <>{compact(engagement)}{rate && <small>{rate}</small>}</>)}
        {stat("shares", "Shares", share(p.shares, r.shares, RATE_HINTS.shares, "shared it"))}
        {stat("saves", "Saves", share(p.saves, r.saves, RATE_HINTS.saves, "saved it"))}
        {stat("clicks", "Clicks", compact(p.clicks))}
        {stat("conversions", "Sales", compact(p.conversions))}
        {stat("revenue", "Revenue", formatMoney(p.revenue) || "–")}
      </dl>
    </li>
  );
}

/* ------------------------------------------------------------------------------------------------ setup */

function CopyButton({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(t);
  }, [done]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      toast("Copied.", "good");
    } catch {
      toast("Copying didn't work here. Select the text and copy it yourself.", "bad");
    }
  };
  return (
    <button type="button" className="btn sm" onClick={() => void copy()} aria-label={label}>
      {done ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />} {done ? "Copied" : "Copy"}
    </button>
  );
}

const CONVERSION_CALL = "hookstreak('conversion', {\n  value: 49.90, currency: 'USD', orderId: 'A-1001'\n});";

function Setup({ workspace, q }: { workspace: Workspace; q: ReturnType<typeof useApi<SetupResponse>> }) {
  const toast = useToast();
  const s = q.data;
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setTarget(s?.targetUrl || ""); }, [s?.targetUrl]);
  const save = async (body: { linksEnabled?: boolean; targetUrl?: string | null }, done: string) => {
    setBusy(true);
    try {
      q.setData(await patch<SetupResponse>(`/workspaces/${workspace.id}/analytics/setup`, body));
      setError(null);
      toast(done, "good");
    } catch (e) {
      if ("targetUrl" in body) setError(errorText(e));
      else toast(errorText(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const submitTarget = (e: FormEvent) => {
    e.preventDefault();
    void save({ targetUrl: target.trim() || null }, target.trim() ? "Tracked links now lead there." : "Tracked links now lead to your website.");
  };
  const website = (() => { try { return workspace.website ? new URL(workspace.website).host : null; } catch { return null; } })();
  return (
    <section className="card an-card" id="tracking" aria-labelledby="an-setup-title" style={{ scrollMarginTop: 72 }}>
      <div className="an-card-head">
        <div>
          <h2 id="an-setup-title">Track clicks and sales</h2>
          <p className="small muted">
            Links that count visits to your site, and a snippet that credits each sale to the post that brought it. No cookies and no
            personal data: just counts.
          </p>
        </div>
      </div>
      {!s ? (
        q.error ? <div className="notice bad" role="alert">{q.error} <button type="button" className="link" onClick={() => void q.reload()}>Try again</button></div>
          : <div className="empty"><Spinner label="Loading tracking settings" /></div>
      ) : (
        <div className="an-setup-grid">
          <section className="an-step" aria-labelledby="an-step-1">
            <h3 id="an-step-1"><span className="an-step-num" aria-hidden="true">1</span> Links in captions</h3>
            <div className="an-toggle">
              <div>
                <strong className="small" id="an-links-label">Add a tracked link to YouTube descriptions and LinkedIn posts</strong>
                <p className="small muted">For posts published from now on. Each post gets its own short link.</p>
              </div>
              <Switch checked={s.linksEnabled} label="Add tracked links to YouTube and LinkedIn captions"
                onChange={(v) => { if (!busy) void save({ linksEnabled: v }, v ? "Tracked links will be added to new YouTube and LinkedIn posts." : "Tracked links turned off for new posts."); }} />
            </div>
            <form className="field" onSubmit={submitTarget} noValidate>
              <label htmlFor="an-target" className="label">Where links lead</label>
              <div className="an-target">
                <input id="an-target" className="input" type="url" inputMode="url" value={target} placeholder={workspace.website || "https://yourbrand.com"}
                  onChange={(e) => { setTarget(e.target.value); setError(null); }} aria-invalid={!!error} aria-describedby="an-target-hint" />
                <button type="submit" className="btn" disabled={busy || target.trim() === (s.targetUrl || "")}>{busy ? <Spinner label="Saving" /> : null} Save</button>
              </div>
              <span id="an-target-hint" className={error ? "error small" : "hint"} role={error ? "alert" : undefined}>
                {error || (website ? `Leave empty to use your website (${website}).` : "Your own website. Tracked links add UTM tags, so your site's analytics see where visits came from.")}
              </span>
            </form>
            {!s.target && <p className="notice warn small">Add your website address so tracked links have somewhere to go.</p>}
          </section>

          <section className="an-step" aria-labelledby="an-step-2">
            <h3 id="an-step-2"><span className="an-step-num" aria-hidden="true">2</span> Links for your bio</h3>
            <p className="small muted">TikTok and Instagram captions can't hold clickable links. Put these in your bio: each counts its own clicks.</p>
            {s.bioLinks.map((b) => {
              const name = platforms[b.platform].name;
              return (
                <div key={b.platform} className="an-bio">
                  <div className="an-bio-head">
                    <PlatformIcon platform={b.platform} size={24} />
                    <span className="grow"><strong className="small">{name}</strong> <span className="hint">· {plural(b.clicks, "click")} in 30 days</span></span>
                    <CopyButton text={b.url} label={`Copy the ${name} bio link`} />
                  </div>
                  <code className="an-bio-url">{b.url}</code>
                </div>
              );
            })}
            <p className="small muted"><Link2 size={13} aria-hidden="true" style={{ verticalAlign: -2 }} /> Links add <code>utm_source</code>, <code>utm_medium=social</code>, <code>utm_campaign={PRODUCT.name.toLowerCase()}</code> and <code>hs</code> to your address.</p>
          </section>

          <section className="an-step wide" aria-labelledby="an-step-3">
            <h3 id="an-step-3"><span className="an-step-num" aria-hidden="true">3</span> Count sales</h3>
            <div className="an-step-cols">
              <div>
                <p className="small muted">Add this to every page of your site, inside <code>&lt;head&gt;</code>:</p>
                <div className="an-code"><pre><code>{s.snippet}</code></pre><CopyButton text={s.snippet} label="Copy the site snippet" /></div>
                <p className="small muted">When someone buys or signs up, call:</p>
                <div className="an-code"><pre><code>{CONVERSION_CALL}</code></pre><CopyButton text={CONVERSION_CALL} label="Copy the sale call" /></div>
              </div>
              <div>
                <p className="small muted">
                  From your server (a Stripe or Shopify webhook), POST the same fields as JSON to <code>{s.endpoint}</code>, with <code>code</code> set
                  to what <code>hookstreak('code')</code> returned at checkout.
                </p>
                <p className="small muted">
                  Each sale is credited to the last tracked link clicked in the 30 days before it. The same <code>orderId</code> counts once. The
                  snippet sets no cookies: it keeps that link's code in your site's own browser storage.
                </p>
                <div className="an-test">
                  {s.testedAt ? <span className="chip green"><Check size={13} aria-hidden="true" /> Snippet seen {ago(s.testedAt)}</span> : <span className="chip">Not seen yet</span>}
                  <span className="small muted">
                    To test, open your site and run <code>hookstreak('test')</code> in the browser console, then{" "}
                    <button type="button" className="link" onClick={() => void q.reload()}>check again</button>.
                  </span>
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
