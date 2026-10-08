import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CalendarClock, Check, Download, Pencil, RotateCcw, Trash2, X, ExternalLink } from "lucide-react";
import { api, del, errorText, fileUrl, newKey, post, usePoll, type Post } from "../lib";
import { useCurrentWorkspace } from "./workspace";
import { PostPlayer, phaseLabels } from "./PostView";
import { ScheduleDialog } from "./ScheduleDialog";
import { Modal, useToast } from "../ui";
import { Views, plural, usePostStats } from "./stats";
import { formats } from "../../shared/formats";
import { platforms, type PlatformId } from "../../shared/social";
import "./content.css";

// Every post of the workspace: being made, waiting for review, approved (and where it is scheduled), rejected.
const views = { all: "All", blitz: "To review", approved: "Approved", making: "Being made", rejected: "Skipped", failed: "Failed" } as const;
type View = keyof typeof views;
type Counts = { blitz: number; making: number; approved: number; failed: number; total: number };
type Publication = {
  id: string; platform: PlatformId; status: string; scheduledAt: number; url: string | null; error: string | null; accountName: string;
  /** Lifetime counts from the network, once read (null until then, and always on LinkedIn). */
  views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null;
};

export function Content() {
  const workspace = useCurrentWorkspace();
  const toast = useToast();
  const [view, setView] = useState<View>("all");
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [open, setOpen] = useState<Post | null>(null);
  const stats = usePostStats(workspace.id);
  // ?post=<id> (from the analytics page) opens that post.
  const [params, setParams] = useSearchParams();
  const linked = params.get("post");
  useEffect(() => {
    if (!linked) return;
    api<{ post: Post }>(`/posts/${encodeURIComponent(linked)}`).then((r) => setOpen(r.post)).catch(() => toast("That post isn't here anymore.", "bad"));
  }, [linked, toast]);
  const close = () => {
    setOpen(null);
    if (linked) setParams({}, { replace: true });
  };
  const load = useCallback(async () => {
    try {
      const r = await api<{ posts: Post[]; counts: Counts }>(`/posts?workspace=${workspace.id}&view=${view}&limit=100`);
      setPosts(r.posts);
      setCounts(r.counts);
      setOpen((o) => (o ? r.posts.find((p) => p.id === o.id) || o : o));
    } catch (e) {
      toast(errorText(e), "bad");
    }
  }, [workspace.id, view, toast]);
  useEffect(() => { setPosts(null); void load(); }, [load]);
  usePoll(load, 8000, !!counts?.making);
  const count = (v: View) => (v === "all" ? counts?.total : v === "rejected" ? undefined : counts?.[v as keyof Counts]);
  return (
    <main className="page">
      <div className="page-head">
        <div><h1>Content</h1><p>Everything made for {workspace.name}.</p></div>
        <div className="toolbar">
          <Link className="btn" to="/app/blitz">Review in Blitz</Link>
          <Link className="btn primary" to="/app/create">Create a post</Link>
        </div>
      </div>
      <div className="tabs" role="tablist" style={{ marginBottom: 18 }}>
        {(Object.keys(views) as View[]).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}>{views[v]}{count(v) ? ` · ${count(v)}` : ""}</button>
        ))}
      </div>
      {!posts ? <div className="loading-page"><span className="spinner big" /></div> : !posts.length ? (
        <div className="empty card"><p>Nothing here yet.</p><Link className="btn primary" to="/app/blitz">Generate posts</Link></div>
      ) : (
        <div className="content-grid">
          {posts.map((p) => (
            <button key={p.id} className="content-card" onClick={() => setOpen(p)}>
              <div className="thumb">
                {p.renderStatus === "ready" && (p.coverAssetId || p.slides[0]) ? <img src={fileUrl(p.slides[0] || p.coverAssetId)} alt="" loading="lazy" />
                  : <div className="thumb-state">{p.renderStatus === "failed" ? "Failed" : <><span className="spinner" /> {phaseLabels[p.phase || ""] || "Making…"}</>}</div>}
              </div>
              <div className="content-meta">
                <span className="chip">{formats[p.format].name}</span>
                <StatusChip post={p} />
                {stats[p.id]?.views != null && <Views views={stats[p.id].views!} />}
              </div>
              <p className="content-hook">{p.hook}</p>
            </button>
          ))}
        </div>
      )}
      {open && <PostDetail post={open} onClose={close} onChanged={load} />}
    </main>
  );
}
function StatusChip({ post: p }: { post: Post }) {
  if (p.renderStatus === "failed") return <span className="chip red">Failed</span>;
  if (p.renderStatus !== "ready") return <span className="chip">Making</span>;
  if (p.status === "approved") return <span className="chip green">Approved</span>;
  if (p.status === "rejected") return <span className="chip">Skipped</span>;
  return <span className="chip orange">To review</span>;
}

function PostDetail({ post: p, onClose, onChanged }: { post: Post; onClose: () => void; onChanged: () => void }) {
  const workspace = useCurrentWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const [muted, setMuted] = useState(true);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [scheduling, setScheduling] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadPublications = useCallback(async () => {
    try { setPublications((await api<{ publications: Publication[] }>(`/posts/${p.id}/publications`)).publications || []); } catch { setPublications([]); }
  }, [p.id]);
  useEffect(() => { void loadPublications(); }, [loadPublications]);
  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await work();
      if (done) toast(done, "good");
      onChanged();
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const when = (s?: number) => (s ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: workspace.settings.schedule.timezone }).format(s * 1000) : "");
  return (
    <Modal title={p.hook || formats[p.format].name} onClose={onClose} wide>
      <div className="detail-grid">
        <div><PostPlayer post={p} muted={muted} onMute={setMuted} /></div>
        <div className="stack">
          <div className="row wrap"><span className="chip">{formats[p.format].name}</span><StatusChip post={p} />{p.topic && <span className="chip violet">{p.topic}</span>}</div>
          {p.why && <p className="muted small">{p.why}</p>}
          <div>
            <strong className="small">Caption</strong>
            <p className="pre">{p.caption || <span className="muted">No caption</span>}</p>
            {p.hashtags.length > 0 && <p className="tags small">{p.hashtags.join(" ")}</p>}
          </div>
          {p.renderError && <p className="notice bad">{p.renderError}</p>}
          <div className="row wrap">
            {p.renderStatus === "ready" && p.status !== "approved" && <button className="btn" disabled={busy} onClick={() => act(() => post(`/posts/${p.id}/review`, { decision: "approve" }), "Approved.")}><Check size={16} /> Approve</button>}
            {p.renderStatus === "ready" && p.status === "approved" && <button className="btn primary" onClick={() => setScheduling(true)}><CalendarClock size={16} /> Schedule</button>}
            {p.renderStatus === "ready" && p.status === "pending" && <button className="btn" disabled={busy} onClick={() => act(() => post(`/posts/${p.id}/review`, { decision: "reject" }))}><X size={16} /> Skip</button>}
            {p.status !== "pending" && p.renderStatus === "ready" && <button className="btn ghost" disabled={busy} onClick={() => act(() => post(`/posts/${p.id}/review`, { decision: "undo" }), "Moved back to review.")}><RotateCcw size={16} /> Back to review</button>}
            {p.renderStatus !== "queued" && p.renderStatus !== "running" && <button className="btn" onClick={() => navigate(`/app/create?post=${p.id}`)}><Pencil size={16} /> Edit</button>}
            {p.renderStatus === "failed" && <button className="btn" disabled={busy} onClick={() => act(() => post(`/posts/${p.id}/render`, { idempotencyKey: newKey() }), "Trying again.")}><RotateCcw size={16} /> Try again</button>}
            {p.videoAssetId && <a className="btn" href={`${fileUrl(p.videoAssetId)}?download=1`}><Download size={16} /> Video</a>}
            {p.format === "slideshow" && p.slides.map((s, i) => <a key={s} className="btn sm" href={`${fileUrl(s)}?download=1`}>Slide {i + 1}</a>)}
            <button className="btn danger" disabled={busy} onClick={() => { if (confirm("Delete this post and its files?")) void act(() => del(`/posts/${p.id}`), "Deleted.").then(onClose); }}><Trash2 size={16} /> Delete</button>
          </div>
          {publications.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <strong className="small">Publishing</strong>
              {publications.map((x) => (
                <div key={x.id} className="row between pub-row">
                  <span className="row" style={{ gap: 8 }}><i className="pdot" style={{ background: platforms[x.platform]?.color }} />{platforms[x.platform]?.name}{x.accountName ? ` · ${x.accountName}` : ""}</span>
                  <span className="small muted">{x.status} {when(x.scheduledAt)}</span>
                  {x.status === "published" && x.views != null && (
                    <span className="small">{plural(x.views, "view")}{x.likes != null ? ` · ${plural(x.likes, "like")}` : ""}</span>
                  )}
                  {x.error && <span className="small error">{x.error}</span>}
                  {x.url && <a href={x.url} target="_blank" rel="noreferrer" className="btn sm ghost" aria-label="Open the published post"><ExternalLink size={14} /></a>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {scheduling && <ScheduleDialog post={p} workspace={workspace} onClose={() => setScheduling(false)} onScheduled={() => { setScheduling(false); void loadPublications(); onChanged(); }} />}
    </Modal>
  );
}
