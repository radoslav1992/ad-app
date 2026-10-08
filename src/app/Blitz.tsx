import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Check, X, Pencil, Info, Settings2, RotateCcw, Sparkles, Hand } from "lucide-react";
import { api, errorText, post, useAuth, usePoll, type Post, type Workspace } from "../lib";
import { useCurrentWorkspace, useWorkspace } from "./workspace";
import { PostPlayer } from "./PostView";
import { Modal, Switch, useToast } from "../ui";
import { formats, formatIds, type FormatId } from "../../shared/formats";
import { hookPatternById } from "../../shared/hooks";
import "./blitz.css";

// Blitz: finished posts one at a time. Swipe (or ←/→) to reject or approve; approved posts can schedule themselves.
type List = { posts: Post[]; counts: { blitz: number; making: number; approved: number; failed: number; total: number } };
const TUTORIAL = "pl-blitz-tutorial";

export function Blitz() {
  const workspace = useCurrentWorkspace();
  const { update } = useWorkspace();
  const { user, refresh: refreshUser } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<List | null>(null);
  const [muted, setMuted] = useState(true);
  const [history, setHistory] = useState<Post[]>([]);
  const [why, setWhy] = useState(false);
  const [configure, setConfigure] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [tutorial, setTutorial] = useState(() => { try { return !localStorage.getItem(TUTORIAL); } catch { return false; } });
  const started = useRef(false);
  const load = useCallback(async () => {
    try { setData(await api<List>(`/posts?workspace=${workspace.id}&view=blitz&limit=20`)); }
    catch (e) { toast(errorText(e), "bad"); }
  }, [workspace.id, toast]);
  useEffect(() => { setData(null); void load(); }, [load]);
  usePoll(load, 6000, !!data && data.counts.making > 0);
  // The workspace's brand analysis may still be running right after onboarding.
  usePoll(async () => {
    try { update((await api<{ workspace: Workspace }>(`/workspaces/${workspace.id}`)).workspace); } catch { /* next poll */ }
  }, 3000, workspace.scan.status === "scanning");

  const generate = useCallback(async (count = 5) => {
    setGenerating(true);
    try {
      const s = workspace.settings;
      const r = await post<{ created: string[]; skipped: string[]; missing: Record<string, string> }>(`/workspaces/${workspace.id}/batch`, {
        count, formats: s.formats, mention: true, useCredits: s.automation.useCredits,
      });
      toast(`Making ${r.created.length} post${r.created.length === 1 ? "" : "s"} — they'll appear here in a minute or two.`, "good");
      if (r.skipped.length) toast(r.skipped[0], "info");
      const missing = Object.values(r.missing || {});
      if (missing.length) toast(missing[0], "info");
      await Promise.all([load(), refreshUser()]);
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setGenerating(false);
    }
  }, [workspace, load, toast, refreshUser]);
  // Right after onboarding: the first batch starts by itself once the brand is ready.
  useEffect(() => {
    if (params.get("first") !== "1" || started.current || !data || workspace.scan.status === "scanning") return;
    started.current = true;
    setParams({}, { replace: true });
    if (data.counts.total === 0 && !user?.trialEnded) void generate(5);
  }, [params, data, workspace.scan.status, generate, setParams, user?.trialEnded]);

  const current = data?.posts[0];
  const review = useCallback(async (decision: "approve" | "reject") => {
    if (!current || !data) return;
    setData({ ...data, posts: data.posts.slice(1), counts: { ...data.counts, blitz: data.counts.blitz - 1 } });
    setHistory((h) => [current, ...h].slice(0, 20));
    try {
      const r = await post<{ scheduled: number }>(`/posts/${current.id}/review`, { decision });
      if (decision === "approve")
        toast(r.scheduled ? `Approved and scheduled on ${r.scheduled} account${r.scheduled === 1 ? "" : "s"}.` : <>Approved. <Link to="/app/calendar">Schedule it</Link> or turn on auto-scheduling.</>, "good");
    } catch (e) {
      toast(errorText(e), "bad");
      void load();
    }
  }, [current, data, toast, load]);
  const undo = useCallback(async () => {
    const [last, ...rest] = history;
    if (!last) return;
    try {
      await post(`/posts/${last.id}/review`, { decision: "undo" });
      setHistory(rest);
      await load();
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }, [history, load, toast]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      if (document.querySelector(".modal-backdrop")) return;
      if (e.key === "ArrowRight") void review("approve");
      else if (e.key === "ArrowLeft") void review("reject");
      else if (e.key.toLowerCase() === "z" || e.key === "Backspace") void undo();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [review, undo]);

  const pattern = hookPatternById(current?.pattern || undefined);
  return (
    <main className="page blitz">
      <div className="blitz-top">
        <div className="toolbar">
          {history.length > 0 && <button className="btn sm" onClick={undo}><RotateCcw size={15} /> Undo</button>}
        </div>
        <div className="toolbar">
          <button className="btn" onClick={() => generate(5)} disabled={generating || user?.trialEnded}>{generating ? <span className="spinner" /> : <Sparkles size={17} />} Generate more</button>
          <button className="btn" onClick={() => setConfigure(true)}><Settings2 size={17} /> Configure</button>
        </div>
      </div>
      <h1 className="sr-only">Blitz</h1>
      {!data ? <div className="loading-page"><span className="spinner big" /></div> : current ? (
        <div className="blitz-stage">
          <aside className="built-on" aria-label="What this post is built on">
            <h2>Built on</h2>
            {pattern ? (
              <>
                <strong>{pattern.name}</strong>
                <p className="template">“{pattern.template}”</p>
                <p className="muted small">{pattern.why}</p>
              </>
            ) : <p className="muted small">A post written for your brand.</p>}
            <Link to="/app/inspiration" className="small">See all proven formats</Link>
          </aside>
          <div className="blitz-center">
            <div className="row" style={{ justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="chip">{formats[current.format].name}</span>
              {current.topic && <span className="chip violet">{current.topic}</span>}
            </div>
            <div className="row" style={{ justifyContent: "center", marginTop: 8 }}>
              <button className="chip orange button" onClick={() => setWhy(true)}><Info size={13} /> Why this content?</button>
            </div>
            <Deck posts={data.posts} muted={muted} onMute={setMuted} onDecide={review} />
            <div className="blitz-actions">
              <div className="stack center" style={{ alignItems: "center", gap: 4 }}>
                <button className="round reject" onClick={() => review("reject")} aria-label="Reject (left arrow)"><X size={30} /></button>
                <kbd>←</kbd>
              </div>
              <button className="btn edit" onClick={() => navigate(`/app/create?post=${current.id}`)}><Pencil size={16} /> Edit</button>
              <div className="stack center" style={{ alignItems: "center", gap: 4 }}>
                <button className="round accept" onClick={() => review("approve")} aria-label="Approve (right arrow)"><Check size={30} /></button>
                <kbd>→</kbd>
              </div>
            </div>
            <p className="center muted small">{data.counts.blitz} to review{data.counts.making ? ` · ${data.counts.making} being made` : ""}</p>
          </div>
          <aside className="post-text" aria-label="Post text">
            <h2>Caption</h2>
            <p>{current.caption || <span className="muted">No caption</span>}</p>
            {current.hashtags.length > 0 && <p className="tags">{current.hashtags.join(" ")}</p>}
          </aside>
        </div>
      ) : (
        <div className="empty blitz-empty">
          {workspace.scan.status === "scanning" ? (
            <><span className="spinner big" /><h2>Reading your brand…</h2><p>Your first posts start as soon as your brand profile is ready.</p></>
          ) : data.counts.making > 0 || generating ? (
            <><span className="spinner big" /><h2>Making {data.counts.making || "your"} posts…</h2><p>Each one is written, rendered and checked. They'll appear here as they finish.</p></>
          ) : (
            <>
              <h2>{data.counts.total ? "You're all caught up" : "Let's make your first posts"}</h2>
              <p>{data.counts.total ? "Generate a fresh batch, or see everything you approved." : "We'll write and render posts for your brand. Swipe right on the ones you like."}</p>
              <div className="row">
                <button className="btn primary" onClick={() => generate(5)} disabled={generating || user?.trialEnded}><Sparkles size={17} /> Generate 5 posts</button>
                {data.counts.approved > 0 && <Link className="btn" to="/app/calendar">Open calendar</Link>}
              </div>
              {user?.trialEnded && <p className="notice warn">Your free trial has ended. <Link to="/app/billing">Upgrade</Link> to make more posts.</p>}
            </>
          )}
        </div>
      )}
      {tutorial && current && (
        <div className="tutorial" role="dialog" aria-label="How Blitz works">
          <div className="tutorial-card">
            <Hand size={44} className="wave" aria-hidden="true" />
            <p><strong>Swipe right</strong> (or press →) to approve a post, <strong>left</strong> (←) to skip it. Press Z to undo.</p>
            <button className="btn white big" onClick={() => { setTutorial(false); try { localStorage.setItem(TUTORIAL, "1"); } catch { /* private mode */ } }}>Got it</button>
          </div>
        </div>
      )}
      {why && current && (
        <Modal title="Why this content?" onClose={() => setWhy(false)}>
          <div className="stack">
            {current.why && <p>{current.why}</p>}
            {pattern && <p className="muted">It uses the <strong>{pattern.name}</strong> pattern: {pattern.why}</p>}
            <p className="muted small">Format: {formats[current.format].name} — {formats[current.format].description}</p>
          </div>
        </Modal>
      )}
      {configure && <Configure workspace={workspace} onClose={() => setConfigure(false)} onSaved={update} />}
    </main>
  );
}

/** The card stack: the top card follows the pointer and decides past a threshold. */
function Deck({ posts, muted, onMute, onDecide }: { posts: Post[]; muted: boolean; onMute: (m: boolean) => void; onDecide: (d: "approve" | "reject") => void }) {
  const [drag, setDrag] = useState<{ x: number; start: number; id: number } | null>(null);
  const width = 340;
  const dx = drag?.x ?? 0;
  const release = () => {
    if (!drag) return;
    if (dx > width * 0.35) onDecide("approve");
    else if (dx < -width * 0.35) onDecide("reject");
    setDrag(null);
  };
  return (
    <div className="deck">
      {posts.slice(0, 3).reverse().map((p, i, all) => {
        const top = i === all.length - 1, depth = all.length - 1 - i;
        return (
          <div key={p.id} className={`deck-card${top ? " top" : ""}`}
            style={top ? { transform: `translateX(${dx}px) rotate(${dx / 18}deg)`, transition: drag ? "none" : "transform 0.25s" } : { transform: `translate(${depth * 10}px, ${depth * 8}px) rotate(${depth * 2}deg)` }}
            onPointerDown={top ? (e) => { if ((e.target as HTMLElement).closest("button")) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag({ x: 0, start: e.clientX, id: e.pointerId }); } : undefined}
            onPointerMove={top && drag ? (e) => setDrag({ ...drag, x: e.clientX - drag.start }) : undefined}
            onPointerUp={top ? release : undefined}
            onPointerCancel={top ? () => setDrag(null) : undefined}>
            {top && dx > 40 && <span className="stamp accept" style={{ opacity: Math.min(1, dx / 120) }}>APPROVE</span>}
            {top && dx < -40 && <span className="stamp reject" style={{ opacity: Math.min(1, -dx / 120) }}>SKIP</span>}
            <PostPlayer post={p} muted={muted} onMute={top ? onMute : undefined} active={top} />
          </div>
        );
      })}
    </div>
  );
}

function Configure({ workspace, onClose, onSaved }: { workspace: Workspace; onClose: () => void; onSaved: (w: Workspace) => void }) {
  const toast = useToast();
  const [selected, setSelected] = useState<FormatId[]>(workspace.settings.formats as FormatId[]);
  const [useCredits, setUseCredits] = useState(workspace.settings.automation.useCredits);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ workspace: Workspace }>(`/workspaces/${workspace.id}`, {
        method: "PATCH", body: JSON.stringify({ settings: { formats: selected, automation: { ...workspace.settings.automation, useCredits } } }),
      });
      onSaved(r.workspace);
      onClose();
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Configure Blitz" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !selected.length} onClick={save}>Save</button></>}>
      <div className="stack">
        <span className="label">Formats to make</span>
        <div className="stack" style={{ gap: 8 }}>
          {formatIds.map((f) => (
            <label key={f} className="check">
              <input type="checkbox" checked={selected.includes(f)} onChange={() => setSelected(selected.includes(f) ? selected.filter((x) => x !== f) : [...selected, f])} />
              <span><strong>{formats[f].name}</strong> — <span className="muted">{formats[f].description}</span>{formats[f].ai && <span className="chip violet" style={{ marginLeft: 6 }}>AI credits</span>}</span>
            </label>
          ))}
        </div>
        <div className="row between card flat">
          <div><strong>Use AI credits</strong><p className="muted small">AI images, clips and talking creators where your own media doesn't fit.</p></div>
          <Switch checked={useCredits} onChange={setUseCredits} label="Use AI credits" />
        </div>
        <p className="muted small">Auto-scheduling of approved posts is set in <Link to="/app/calendar">Calendar</Link>.</p>
      </div>
    </Modal>
  );
}
