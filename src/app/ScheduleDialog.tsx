/**
 * ScheduleDialog: a modal that schedules ONE post to the workspace's connected social accounts.
 *
 *   <ScheduleDialog post={post} workspace={workspace} onClose={() => setPost(null)} onScheduled={(r) => reload()} />
 *
 * Props
 *   post          Post        The post to schedule. A list item is enough: the dialog loads the full post (its spec, for
 *                             saving caption edits) and the post's existing publications itself.
 *   workspace     Workspace   The post's workspace: time zone, posting schedule and default accounts come from
 *                             `workspace.settings.schedule`.
 *   onClose       () => void  Closes the dialog: ✕, Cancel, Escape, the backdrop, and after a successful schedule.
 *                             It may be an inline arrow function (the dialog keeps a stable wrapper).
 *   onScheduled?  (result: ScheduleResult) => void
 *                             Called after POST /api/posts/:id/schedule succeeded, before onClose, with the server's
 *                             `{ scheduledAt, publications }`.
 *   at?           number      Preselects "Pick a date & time" with this moment (unix seconds), e.g. a clicked slot.
 *   accountIds?   string[]    Preselects these accounts instead of the workspace's default accounts.
 *
 * Steps ("<step> · Step N of 3"): 1 accounts → 2 content details (caption, hashtags and YouTube title; saved with
 * PUT /api/posts/:id when changed) → 3 when (the next free slot, or a date and time in the workspace time zone).
 * On a plan without scheduling (free) it shows an upgrade notice and download links instead of the steps.
 *
 * The file also exports small helpers the Calendar and Accounts pages share: social account and publication types,
 * platform icons, initials avatars (network avatar URLs are blocked by our CSP), status chips and time-zone formatting.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, Ban, CalendarClock, CircleAlert, CircleCheck, Clock, Download, Instagram, Linkedin, Music2, Plus, Sparkles, X, Youtube,
  type LucideIcon,
} from "lucide-react";
import { ApiError, errorText, newKey, post as send, put, useApi, useAuth, type Post, type Workspace } from "../lib";
import { Modal, Spinner, useToast } from "../ui";
import { platforms, postsAsPhotos, type PlatformId } from "../../shared/social";
import { validZone, zonedTime } from "../../shared/schedule";
import { planById } from "../../shared/plans";
import { formats } from "../../shared/formats";
import "./schedule.css";

/* ------------------------------------------------------------------------------------------------------------------ */
/* Shared types (server/accounts.ts, server/publishing.ts)                                                            */

export type AccountStatus = "active" | "expired" | "revoked";
export type SocialAccount = {
  id: string; platform: PlatformId; name: string; handle: string | null; avatarUrl: string | null; status: AccountStatus; createdAt: number;
};
export type AccountsResponse = {
  accounts: SocialAccount[];
  platforms: { id: PlatformId; name: string; configured: boolean }[];
  /** Accounts the plan allows and those connected, across all the user's workspaces. */
  limit: { max: number; used: number };
};
export type PublicationStatus = "scheduled" | "publishing" | "published" | "failed" | "canceled";
export type Publication = {
  id: string; postId: string; accountId: string; platform: PlatformId; scheduledAt: number; status: PublicationStatus; attempts: number;
  url: string | null; externalId: string | null; error: string | null; publishedAt: number | null; accountName: string; accountHandle: string | null;
  /** Calendar rows only. */
  hook?: string; format?: string; coverAsset?: string | null;
};
export type CalendarResponse = { publications: Publication[]; slots: number[]; timezone: string };
export type ScheduleResult = { scheduledAt: number; publications: Publication[] };
export type ScheduleDialogProps = {
  post: Post;
  workspace: Workspace;
  onClose: () => void;
  onScheduled?: (result: ScheduleResult) => void;
  at?: number;
  accountIds?: string[];
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Time zones                                                                                                         */

const pad = (n: number) => String(n).padStart(2, "0");
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string, options: Intl.DateTimeFormatOptions, locale?: string) {
  const key = `${locale || ""}|${tz}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone: tz });
    formatters.set(key, f);
  }
  return f;
}
/** The workspace's posting time zone (UTC when it is unset or unknown to this browser). */
export function zoneOf(workspace: Workspace) {
  const tz = workspace.settings?.schedule?.timezone;
  return tz && validZone(tz) ? tz : "UTC";
}
export const DATE_TIME: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
/** A moment (unix seconds) as people read it, in a time zone. */
export const formatAt = (at: number, tz: string, options: Intl.DateTimeFormatOptions = DATE_TIME) => formatter(tz, options).format(new Date(at * 1000));
export const formatTime = (at: number, tz: string) => formatAt(at, tz, { hour: "numeric", minute: "2-digit" });
/** The wall-clock date and time of a moment in a time zone. */
export function wallClock(at: number, tz: string) {
  const f = formatter(tz, { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }, "en-US");
  const p = Object.fromEntries(f.formatToParts(new Date(at * 1000)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, min: Number(p.minute) };
}
/** A moment as a `datetime-local` value in a time zone. */
export function toInputValue(at: number, tz: string) {
  const c = wallClock(at, tz);
  return `${c.y}-${pad(c.m)}-${pad(c.d)}T${pad(c.h)}:${pad(c.min)}`;
}
/** A `datetime-local` value read in a time zone (unix seconds), or null. */
export function fromInputValue(value: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  return m ? Math.round(zonedTime(+m[1], +m[2], +m[3], +m[4], +m[5], tz)) : null;
}
/** A short label of the zone, e.g. "Europe/Berlin (GMT+2)". */
export function zoneLabel(tz: string) {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value;
    return name && name !== tz ? `${tz.replace(/_/g, " ")} (${name})` : tz.replace(/_/g, " ");
  } catch {
    return tz;
  }
}
/** The earliest and latest moments the server accepts (a minute from now, 180 days ahead). */
export const LEAD_SECONDS = 60, HORIZON_SECONDS = 180 * 86400;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Platform and status visuals                                                                                        */

export const platformIcons: Record<PlatformId, LucideIcon> = { tiktok: Music2, instagram: Instagram, youtube: Youtube, linkedin: Linkedin };
/** The network's icon in a circle of its colour. */
export function PlatformIcon({ platform, size = 28 }: { platform: PlatformId; size?: number }) {
  const Icon = platformIcons[platform];
  return (
    <span className="sc-picon" style={{ width: size, height: size, background: platforms[platform].color }} aria-hidden="true">
      <Icon size={Math.round(size * 0.55)} color="#fff" />
    </span>
  );
}
export function initials(name: string) {
  const words = name.replace(/^@/, "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2);
  return letters.toUpperCase();
}
export const handleText = (handle: string | null | undefined) => (handle ? (handle.startsWith("@") ? handle : `@${handle}`) : "");
/** The account's initials in a circle of the network's colour, with the network's icon as a badge. */
export function AccountAvatar({ name, platform, size = 38 }: { name: string; platform: PlatformId; size?: number }) {
  const Icon = platformIcons[platform];
  return (
    <span className="sc-avatar" style={{ width: size, height: size, background: platforms[platform].color, fontSize: Math.round(size * 0.36) }} aria-hidden="true">
      {initials(name)}
      <span className="sc-avatar-badge"><Icon size={10} color={platforms[platform].color} /></span>
    </span>
  );
}
export const statusLabels: Record<PublicationStatus, string> = {
  scheduled: "Scheduled", publishing: "Publishing", published: "Published", failed: "Failed", canceled: "Canceled",
};
const statusTone: Record<PublicationStatus, string> = { scheduled: "violet", publishing: "orange", published: "green", failed: "red", canceled: "" };
const statusIcon: Record<PublicationStatus, LucideIcon> = { scheduled: Clock, publishing: Clock, published: CircleCheck, failed: CircleAlert, canceled: Ban };
export function StatusChip({ status, compact = false }: { status: PublicationStatus; compact?: boolean }) {
  const Icon = statusIcon[status];
  return (
    <span className={`chip sc-status ${statusTone[status]}${compact ? " compact" : ""}`}>
      {status === "publishing" ? <span className="spinner sc-mini-spin" aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />}
      {statusLabels[status]}
    </span>
  );
}
const span = (s: number) => (s % 60 === 0 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s} seconds`);
/** Why a post cannot go to a network as it is (mirrors server/social/post.ts `unfit`), or null. */
export function unfitFor(post: Post, platform: PlatformId): string | null {
  const facts = platforms[platform];
  if (postsAsPhotos(post.format, platform)) return post.slides.length ? null : `This post has no slides to send to ${facts.name}.`;
  if (!post.videoAssetId) return `${facts.name} needs a video, and this post has none yet.`;
  const d = Number(post.duration) || 0;
  if (d && d < facts.video.min) return `Too short for ${facts.name}: it needs at least ${span(facts.video.min)}.`;
  if (d > facts.video.max) return `Too long for ${facts.name}: the limit is ${span(facts.video.max)}.`;
  return null;
}
/** How the post goes out on a network, for the account list. */
export function postsAs(post: Post, platform: PlatformId) {
  if (platform === "youtube") return "Posts as a Short";
  return postsAsPhotos(post.format, platform) ? "Posts as a photo carousel" : "Posts as a video";
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const HASHTAG = /^[\p{L}\p{N}_]{1,60}$/u;
const CAPTION_MAX = 2200, TITLE_MAX = 100, HASHTAGS_MAX = 15;
/** Adds typed hashtags ("#a b, c") to a list: "#"-prefixed, without duplicates; or why they can't be added. */
function mergeTags(current: string[], raw: string): { tags: string[] } | { error: string } {
  const words = raw.split(/[\s,]+/).map((w) => w.replace(/^#+/, "")).filter(Boolean);
  const bad = words.find((w) => !HASHTAG.test(w));
  if (bad) return { error: `"${bad}" can't be a hashtag: use letters, numbers and _ only.` };
  const tags = [...current];
  for (const w of words) if (!tags.some((t) => t.toLowerCase() === `#${w}`.toLowerCase())) tags.push(`#${w}`);
  if (tags.length > HASHTAGS_MAX) return { error: `Up to ${HASHTAGS_MAX} hashtags.` };
  return { tags };
}
/** A stable wrapper around a callback prop, so the modal does not re-run its focus effect on every render. */
function useStable<A extends unknown[]>(fn: (...args: A) => void) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; }, [fn]);
  return useCallback((...args: A) => ref.current(...args), []);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The dialog                                                                                                         */

export function ScheduleDialog(props: ScheduleDialogProps) {
  const { user } = useAuth();
  const close = useStable(props.onClose);
  if (!planById(user?.plan).scheduling) return <UpgradeInstead post={props.post} close={close} />;
  return <ScheduleSteps {...props} close={close} />;
}

/** Free plan: an upgrade notice and the files to post by hand. */
function UpgradeInstead({ post, close }: { post: Post; close: () => void }) {
  const slides = post.format === "slideshow" ? post.slides : [];
  const download = (id: string) => `/api/media/${id}/file?download=1`;
  return (
    <Modal title="Schedule post" onClose={close} footer={<><span /><button type="button" className="btn" onClick={close}>Close</button></>}>
      <div className="stack">
        <div className="notice warn sc-upgrade">
          <Sparkles size={18} aria-hidden="true" />
          <div>
            <strong>Scheduling is part of the paid plans.</strong> Upgrade to publish to TikTok, Instagram, YouTube and LinkedIn
            automatically: pick a time on the calendar, or let approved posts drop into your next free slot.
          </div>
        </div>
        <div><Link to="/app/billing" className="btn primary" onClick={close}>See plans</Link></div>
        <h3 className="sc-subhead">Or download it and post it yourself</h3>
        {post.renderStatus !== "ready" ? (
          <p className="muted small">This post is still being made. Its files can be downloaded when it's ready.</p>
        ) : (
          <div className="row wrap">
            {post.videoAssetId && (
              <a className="btn" href={download(post.videoAssetId)} download><Download size={16} aria-hidden="true" /> Download video</a>
            )}
            {slides.map((id, i) => (
              <a key={id} className="btn sm" href={download(id)} download aria-label={`Download slide ${i + 1} of ${slides.length}`}>
                <Download size={14} aria-hidden="true" /> Slide {i + 1}
              </a>
            ))}
            {!post.videoAssetId && !slides.length && <p className="muted small">This post has no files to download.</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

const stepNames = ["Accounts", "Content details", "When"] as const;

function ScheduleSteps({ post: initial, workspace, close, onScheduled, at, accountIds }: ScheduleDialogProps & { close: () => void }) {
  const toast = useToast();
  const tz = zoneOf(workspace);
  const schedule = workspace.settings.schedule;
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; billing: boolean } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    heading.current?.focus();
  }, [step]);

  const accountsQ = useApi<AccountsResponse>(`/accounts?workspace=${workspace.id}`);
  const fullQ = useApi<{ post: Post }>(`/posts/${initial.id}`);
  const pubsQ = useApi<{ publications: Publication[] }>(`/posts/${initial.id}/publications`);
  const slotsQ = useApi<CalendarResponse>(`/workspaces/${workspace.id}/calendar`);
  const current = fullQ.data?.post ?? initial;
  const fail = (e: unknown) => {
    setProblem({ text: errorText(e), billing: e instanceof ApiError && e.status === 402 });
    toast(errorText(e), "bad");
  };

  /* Step 1: accounts */
  const taken = useMemo(() => {
    const m = new Map<string, PublicationStatus>();
    for (const p of pubsQ.data?.publications || []) if (p.status === "scheduled" || p.status === "publishing" || p.status === "published") m.set(p.accountId, p.status);
    return m;
  }, [pubsQ.data]);
  const accounts = useMemo(() => accountsQ.data?.accounts || [], [accountsQ.data]);
  const blocked = useCallback((a: SocialAccount): string | null => {
    if (a.status !== "active") return "The connection expired. Reconnect it in Accounts.";
    const live = taken.get(a.id);
    if (live === "published") return "Already published on this account.";
    if (live === "publishing") return "Being published on this account now.";
    if (live === "scheduled") return "Already scheduled on this account.";
    return unfitFor(current, a.platform);
  }, [taken, current]);
  const selectable = useMemo(() => accounts.filter((a) => !blocked(a)).map((a) => a.id), [accounts, blocked]);
  const defaults = useMemo(() => {
    const wanted = (accountIds ?? schedule.accounts).filter((id) => selectable.includes(id));
    return wanted.length ? wanted : selectable.length === 1 ? selectable : [];
  }, [accountIds, schedule.accounts, selectable]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const selected = (chosen ?? defaults).filter((id) => selectable.includes(id));
  const selectedAccounts = accounts.filter((a) => selected.includes(a.id));
  const chosenPlatforms = [...new Set(selectedAccounts.map((a) => a.platform))];
  const toggle = (id: string) => setChosen(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const notReady = current.status !== "approved" ? "Approve this post before scheduling it."
    : current.renderStatus !== "ready" ? "This post is still being made. Schedule it when it's ready." : null;

  /* Step 2: content details */
  const spec = fullQ.data?.post.spec;
  const base = {
    caption: spec?.caption ?? current.caption ?? "",
    hashtags: spec?.hashtags ?? current.hashtags ?? [],
    title: spec?.title ?? current.title ?? "",
  };
  const [captionEdit, setCaption] = useState<string | null>(null);
  const [tagsEdit, setTags] = useState<string[] | null>(null);
  const [titleEdit, setTitle] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const caption = captionEdit ?? base.caption;
  const hashtags = tagsEdit ?? base.hashtags;
  const title = titleEdit ?? base.title;
  const changed = caption.trim() !== base.caption.trim() || title.trim() !== base.title.trim() || hashtags.join(" ") !== base.hashtags.join(" ") || !!tagInput.trim();
  const saveKey = useRef<string | null>(null);
  const addTags = (raw: string) => {
    const r = mergeTags(hashtags, raw);
    if ("error" in r) { setTagError(r.error); return null; }
    setTags(r.tags);
    setTagInput("");
    setTagError(null);
    return r.tags;
  };
  const tagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (tagInput.trim()) addTags(tagInput); }
    else if (e.key === "Backspace" && !tagInput && hashtags.length) setTags(hashtags.slice(0, -1));
  };
  const tagsText = hashtags.join(" ");
  const textLength = (platform: PlatformId) => {
    const c = caption.trim().length;
    return c + (tagsText ? (c ? 2 : 0) + tagsText.length : 0) + (platform === "youtube" ? 8 : 0);
  };
  async function saveContent(tags: string[]) {
    if (caption.trim() === base.caption.trim() && title.trim() === base.title.trim() && tags.join(" ") === base.hashtags.join(" ")) return true;
    if (!spec) { fail(new Error("The post is still loading. Try again in a moment.")); return false; }
    saveKey.current ??= newKey();
    const r = await put<{ post: Post; rendering: boolean }>(`/posts/${current.id}`, {
      spec: { ...spec, caption: caption.trim(), hashtags: tags, title: title.trim() }, idempotencyKey: saveKey.current,
    });
    saveKey.current = null;
    fullQ.setData({ post: r.post });
    setCaption(null); setTags(null); setTitle(null);
    toast("Content details saved.", "good");
    return true;
  }

  /* Step 3: when */
  const noRhythm = !schedule.times.length || !schedule.days.length;
  const [mode, setMode] = useState<"next" | "pick">(at || noRhythm ? "pick" : "next");
  const [pickEdit, setPick] = useState<string | null>(at ? toInputValue(at, tz) : null);
  const [fallbackPick] = useState(() => Math.ceil(Date.now() / 3_600_000) * 3600 + 3600);
  const freeSlots = slotsQ.data?.slots || [];
  const pick = pickEdit ?? toInputValue(freeSlots[0] ?? fallbackPick, tz);
  const [bounds] = useState(() => ({ min: Date.now() / 1000 + LEAD_SECONDS + 60, max: Date.now() / 1000 + HORIZON_SECONDS - 3600 }));

  async function next() {
    setProblem(null);
    if (step === 0) { setStep(1); return; }
    if (step === 1) {
      const tags = tagInput.trim() ? addTags(tagInput) : hashtags;
      if (!tags) return;
      setBusy(true);
      try {
        if (await saveContent(tags)) setStep(2);
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
      return;
    }
    let when: number | undefined;
    if (mode === "pick") {
      const v = fromInputValue(pick, tz);
      const now = Date.now() / 1000;
      if (v === null) { fail(new Error("Choose a date and time.")); return; }
      if (v < now + LEAD_SECONDS) { fail(new Error("Pick a time at least a minute from now.")); return; }
      if (v > now + HORIZON_SECONDS) { fail(new Error("Pick a time within the next 180 days.")); return; }
      when = v;
    }
    setBusy(true);
    try {
      const r = await send<ScheduleResult>(`/posts/${current.id}/schedule`, { accountIds: selected, ...(when !== undefined && { at: when }) });
      toast(`Scheduled for ${formatAt(r.scheduledAt, tz)} on ${plural(r.publications.length || selected.length, "account")}.`, "good");
      onScheduled?.(r);
      close();
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); if (!busy) void next(); };
  const loadingAccounts = accountsQ.loading || pubsQ.loading;
  const canNext = step === 0 ? !notReady && !loadingAccounts && selected.length > 0
    : step === 1 ? !changed || !!spec
    : selected.length > 0 && (mode === "pick" ? !!pick : !noRhythm);
  const formId = `sc-form-${initial.id}`;

  const footer = (
    <>
      {step === 0
        ? <button type="button" className="btn ghost" onClick={close}>Cancel</button>
        : <button type="button" className="btn ghost" onClick={() => { setProblem(null); setStep(step - 1); }} disabled={busy}><ArrowLeft size={16} aria-hidden="true" /> Back</button>}
      <button type="submit" form={formId} className="btn primary" disabled={!canNext || busy}>
        {busy && <Spinner label="Working" />}
        {step === 2 ? <><CalendarClock size={16} aria-hidden="true" /> Schedule</> : step === 1 && changed ? <>Save &amp; continue <ArrowRight size={16} aria-hidden="true" /></> : <>Next <ArrowRight size={16} aria-hidden="true" /></>}
      </button>
    </>
  );

  return (
    <Modal title={`${stepNames[step]} · Step ${step + 1} of 3`} onClose={close} footer={footer}>
      <form id={formId} onSubmit={submit} className="stack sc-dialog" noValidate>
        <div className="sc-steps" aria-hidden="true">{stepNames.map((n, i) => <span key={n} className={i <= step ? "on" : ""} />)}</div>
        <p className="small muted sc-post-line">
          <span className="chip">{formats[current.format]?.name || current.format}</span>
          <span className="sc-ellipsis">{current.hook || "Untitled post"}</span>
        </p>

        {step === 0 && (
          <fieldset className="sc-fieldset">
            <legend><h3 ref={heading} tabIndex={-1}>Where should it go?</h3></legend>
            {notReady && <div className="notice warn" role="alert">{notReady}</div>}
            {loadingAccounts ? (
              <div className="empty"><Spinner label="Loading accounts" /></div>
            ) : accountsQ.error ? (
              <div className="notice bad" role="alert">{accountsQ.error} <button type="button" className="link" onClick={() => void accountsQ.reload()}>Try again</button></div>
            ) : !accounts.length ? (
              <div className="empty">
                <p>No social accounts are connected to {workspace.name} yet.</p>
                <Link to="/app/accounts" className="btn primary" onClick={close}><Plus size={16} aria-hidden="true" /> Connect an account</Link>
              </div>
            ) : (
              <div className="sc-account-list">
                {accounts.map((a) => {
                  const reason = blocked(a);
                  const id = `sc-acc-${a.id}`;
                  return (
                    <div key={a.id} className={`sc-account${reason ? " disabled" : ""}${selected.includes(a.id) ? " on" : ""}`}>
                      <input type="checkbox" id={id} checked={selected.includes(a.id)} disabled={!!reason} onChange={() => toggle(a.id)}
                        aria-describedby={`${id}-note`} />
                      <AccountAvatar name={a.name} platform={a.platform} />
                      <label htmlFor={id} className="grow sc-account-text">
                        <strong>{a.name}</strong>{a.handle && <span className="muted"> {handleText(a.handle)}</span>}
                        <span className="small muted" id={`${id}-note`}>
                          {platforms[a.platform].name} · {reason || postsAs(current, a.platform)}
                        </span>
                      </label>
                      {a.status !== "active" && <Link to="/app/accounts" className="btn sm" onClick={close}>Reconnect</Link>}
                    </div>
                  );
                })}
              </div>
            )}
            {!!accounts.length && <p className="hint">Default accounts for auto-scheduling are chosen in <Link to="/app/accounts" onClick={close}>Accounts</Link>.</p>}
          </fieldset>
        )}

        {step === 1 && (
          <div className="stack">
            <h3 ref={heading} tabIndex={-1}>What people will read</h3>
            {fullQ.loading && !spec && <p className="small muted"><Spinner label="Loading the post" /> Loading the post…</p>}
            {fullQ.error && <div className="notice bad" role="alert">{fullQ.error} <button type="button" className="link" onClick={() => void fullQ.reload()}>Try again</button></div>}
            <div className="field">
              <span className="row between">
                <label htmlFor="sc-caption">{chosenPlatforms.includes("youtube") ? "Caption / description" : "Caption"}</label>
                <span className={`small ${caption.length >= CAPTION_MAX ? "error" : "muted"}`} aria-live="polite">{caption.length.toLocaleString()} / {CAPTION_MAX.toLocaleString()}</span>
              </span>
              <textarea id="sc-caption" className="textarea" rows={5} maxLength={CAPTION_MAX} value={caption} onChange={(e) => setCaption(e.target.value)}
                aria-describedby="sc-caption-limits" />
              <div id="sc-caption-limits" className="sc-counters">
                {chosenPlatforms.map((p) => {
                  const n = textLength(p), max = platforms[p].captionMax;
                  return (
                    <span key={p} className={`chip${n > max ? " red" : ""}`}>
                      <PlatformIcon platform={p} size={16} /> {platforms[p].name} {n.toLocaleString()} / {max.toLocaleString()}
                    </span>
                  );
                })}
                <span className="hint">With hashtags{chosenPlatforms.includes("youtube") ? " (and #Shorts on YouTube)" : ""}. Text that doesn't fit is shortened; hashtags are kept.</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="sc-tag" className="label">Hashtags <span className="muted small">{hashtags.length} / {HASHTAGS_MAX}</span></label>
              {!!hashtags.length && (
                <ul className="sc-tags" aria-label="Hashtags">
                  {hashtags.map((t) => (
                    <li key={t} className="chip">
                      {t}
                      <button type="button" className="sc-tag-remove" onClick={() => setTags(hashtags.filter((x) => x !== t))} aria-label={`Remove ${t}`}><X size={12} /></button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="row">
                <input id="sc-tag" className="input" value={tagInput} placeholder="#startup" onChange={(e) => { setTagInput(e.target.value); setTagError(null); }}
                  onKeyDown={tagKey} disabled={hashtags.length >= HASHTAGS_MAX} aria-describedby="sc-tag-hint" aria-invalid={!!tagError} />
                <button type="button" className="btn" onClick={() => { addTags(tagInput); }} disabled={!tagInput.trim()}><Plus size={16} aria-hidden="true" /> Add</button>
              </div>
              <span id="sc-tag-hint" className={tagError ? "error" : "hint"} role={tagError ? "alert" : undefined}>
                {tagError || "Press Enter to add. Letters, numbers and _ only."}
              </span>
            </div>
            {chosenPlatforms.includes("youtube") && (
              <div className="field">
                <span className="row between">
                  <label htmlFor="sc-title">YouTube title</label>
                  <span className="small muted">{title.length} / {TITLE_MAX}</span>
                </span>
                <input id="sc-title" className="input" maxLength={TITLE_MAX} value={title} onChange={(e) => setTitle(e.target.value)}
                  placeholder={(caption.split("\n").find((l) => l.trim()) || current.hook || "").slice(0, TITLE_MAX)} aria-describedby="sc-title-hint" />
                <span id="sc-title-hint" className="hint">Empty: the first line of the caption is used.</span>
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <fieldset className="sc-fieldset">
            <legend><h3 ref={heading} tabIndex={-1}>When should it go out?</h3></legend>
            <label className={`sc-option${mode === "next" ? " on" : ""}${noRhythm ? " disabled" : ""}`}>
              <input type="radio" name="sc-when" checked={mode === "next"} disabled={noRhythm} onChange={() => setMode("next")} />
              <strong>Next free slot</strong>
              <span className="small muted">
                {noRhythm ? "Your posting schedule has no times yet. Add some on the Calendar page, or pick a time."
                  : slotsQ.loading ? "Finding the next free slot…"
                  : freeSlots[0] ? `${formatAt(freeSlots[0], tz)}, from your posting schedule`
                  : "The first free time in your posting schedule."}
              </span>
            </label>
            <label className={`sc-option${mode === "pick" ? " on" : ""}`}>
              <input type="radio" name="sc-when" checked={mode === "pick"} onChange={() => setMode("pick")} />
              <strong>Pick a date &amp; time</strong>
              <span className="small muted">Any time in the next 180 days.</span>
            </label>
            {mode === "pick" && (
              <div className="field sc-pick">
                <label htmlFor="sc-at" className="label">Date and time</label>
                <input id="sc-at" type="datetime-local" className="input" value={pick} onChange={(e) => setPick(e.target.value)}
                  min={toInputValue(bounds.min, tz)} max={toInputValue(bounds.max, tz)} aria-describedby="sc-at-hint" />
                <span id="sc-at-hint" className="hint"><Clock size={13} aria-hidden="true" /> In {zoneLabel(tz)}, the workspace time zone.</span>
                {freeSlots.length > 1 && (
                  <div className="row wrap sc-slot-chips" role="group" aria-label="Free slots">
                    {freeSlots.slice(0, 6).map((s) => (
                      <button key={s} type="button" className="chip button" aria-pressed={pick === toInputValue(s, tz)} onClick={() => setPick(toInputValue(s, tz))}>
                        {formatAt(s, tz)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="sc-summary small">
              <span className="muted">Posting to</span>
              {selectedAccounts.map((a) => <span key={a.id} className="chip"><PlatformIcon platform={a.platform} size={16} /> {a.name}</span>)}
            </div>
          </fieldset>
        )}

        {problem && (
          <div className="notice bad" role="alert">
            {problem.text}
            {problem.billing && <> <Link to="/app/billing" onClick={close}>See plans</Link></>}
          </div>
        )}
      </form>
    </Modal>
  );
}

/** Coloured dots for the networks of a calendar item, with their names for screen readers. */
export function PlatformDots({ list }: { list: PlatformId[] }) {
  return (
    <span className="sc-dots">
      {list.map((p, i) => <span key={`${p}-${i}`} className="sc-dot" style={{ background: platforms[p].color }} aria-hidden="true" />)}
      <span className="sr-only">{[...new Set(list)].map((p) => platforms[p].name).join(", ")}</span>
    </span>
  );
}
