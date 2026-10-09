import { useRef, useState, type FormEvent } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Download, Eye, Film, Mail, Music, Pencil, RefreshCw, Search, Trash2, Upload as UploadIcon, UserRound } from "lucide-react";
import { Modal, Spinner, Switch, useToast } from "../ui";
import { ApiError, bytes, del, errorText, number, patch, post, seconds, useApi, useAuth, type LibraryItem } from "../lib";
import { ConfirmDialog, Empty, Tabs, ago, formatDate, tabPanel, useStableCallback } from "./pickers";
import { LoadMore, useDebounced, usePaged } from "./creators";
import { BULK_PASTE, parseLookIds, type LookImport } from "../../shared/creators";
import { BillingTab, OperationsTab } from "./AdminOps";
import { BrowseHeyGen } from "./HeyGenBrowse";
import "./pages.css";

type Kind = LibraryItem["kind"];
type Overview = {
  users: number; newUsers: number; paying: number; granted: number; posts: number; failedRuns: number; activeRuns: number; published: number; failedPublications: number;
  config: Record<string, boolean>;
};
type AdminItem = LibraryItem & { active: boolean; rawTags: string };
type AdminCharacter = { id: string; name: string; description: string; gender: string; look_id: string | null; engines: string; active: number; created_at: number; updated_at: number };
type Message = { id: string; name: string; email: string; topic: string; message: string; created_at: number };
type Tab = "overview" | "operations" | "billing" | "library" | "creators" | "messages";
const tabIds: Tab[] = ["overview", "operations", "billing", "library", "creators", "messages"];
const kindNames: Record<Kind, string> = { clip: "Clip", greenscreen: "Green screen", music: "Music" };
const genderNames: Record<string, string> = { female: "Female", male: "Male", "": "Not specified" };
const topics: Record<string, string> = { question: "Question", billing: "Billing", withdrawal: "Withdrawal (14 days)", partnership: "Partnership", abuse: "Report abuse", other: "Other" };
const flagNames: Record<string, string> = {
  media: "Media pipeline", fal: "fal.ai (AI images & clips)", elevenlabs: "ElevenLabs (voices)", heygen: "HeyGen (talking creators)", stripe: "Stripe keys",
  billing: "Billing open", tokens: "Token encryption", tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", linkedin: "LinkedIn",
};
const clipTagIdeas = ["activity", "neutral/filler", "reaction", "man", "woman"];
const MB = 1024 * 1024;

/** Administration (admins only): health, operations, billing tools, the shared library, library creators and contact messages. */
export function AdminPage() {
  const { user } = useAuth();
  if (!user?.admin) return <Navigate to="/app" replace />;
  return <AdminConsole />;
}

function AdminConsole() {
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab") as Tab | null;
  const tab: Tab = requested && tabIds.includes(requested) ? requested : "overview";
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Admin</h1>
          <p>Service health and operations, withdrawals and free months, the shared library, library creators and contact messages.</p>
        </div>
      </div>
      <div style={{ marginBottom: 20 }}>
        <Tabs label="Admin sections" idBase="admin" value={tab} onChange={(t) => setParams(t === "overview" ? {} : { tab: t }, { replace: true })} items={[
          { id: "overview", label: "Overview" }, { id: "operations", label: "Operations" }, { id: "billing", label: "Billing" },
          { id: "library", label: "Library" }, { id: "creators", label: "Creators" }, { id: "messages", label: "Messages" },
        ]} />
      </div>
      <div {...tabPanel("admin", tab)}>
        {tab === "overview" && <OverviewTab />}
        {tab === "operations" && <OperationsTab />}
        {tab === "billing" && <BillingTab />}
        {tab === "library" && <LibraryTab />}
        {tab === "creators" && <CreatorsTab />}
        {tab === "messages" && <MessagesTab />}
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------------------------------------ helpers */

/** PUTs a file as the raw request body, reporting upload progress (fetch can't). */
function sendFile<T = unknown>(path: string, body: Blob, type: string, onProgress?: (share: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("PUT", "/api" + path);
    x.setRequestHeader("Content-Type", type);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    x.onload = () => {
      let data: any = {};
      try { data = JSON.parse(x.responseText); } catch { data = { error: "Unexpected answer from the server. Please try again." }; }
      if (x.status >= 200 && x.status < 300) resolve(data as T);
      else reject(new ApiError(data.error || "Something went wrong. Please try again.", x.status, data));
    };
    x.onerror = () => reject(new TypeError("We can't reach the server. Check your connection and try again."));
    x.send(body);
  });
}
const extensionTypes: Record<string, string> = {
  mov: "video/quicktime", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/x-m4a", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
};
const mimeOf = (file: File) => file.type || extensionTypes[file.name.split(".").pop()?.toLowerCase() || ""] || "";
const baseName = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 120);
const splitTags = (raw: string) => raw.split(",").map((t) => t.trim()).filter((t) => t && !t.startsWith("chroma:"));

function waitFor(el: HTMLMediaElement, event: string, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("The browser couldn't read this file in time.")); }, ms);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("The browser can't play this file. Try an MP4 (H.264) video or an MP3 track.")); };
    const cleanup = () => { clearTimeout(timer); el.removeEventListener(event, done); el.removeEventListener("error", fail); };
    el.addEventListener(event, done);
    el.addEventListener("error", fail);
  });
}
/** Duration and size from the browser's own player, plus a poster frame (JPEG) for videos. */
async function measure(file: File, video: boolean) {
  const url = URL.createObjectURL(file);
  try {
    const el = document.createElement(video ? "video" : "audio");
    el.preload = "metadata";
    el.muted = true;
    if (el instanceof HTMLVideoElement) el.playsInline = true;
    const loaded = waitFor(el, "loadedmetadata", 20000);
    el.src = url;
    await loaded;
    let duration = el.duration;
    if (!Number.isFinite(duration)) {
      // Some recordings (WebM) report no duration until the player seeks to the end.
      const changed = waitFor(el, "durationchange", 10000);
      el.currentTime = 1e7;
      await changed.catch(() => {});
      duration = el.duration;
    }
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("We couldn't read the length of this file.");
    if (!(el instanceof HTMLVideoElement)) return { duration, width: 0, height: 0, poster: null as Blob | null };
    const width = el.videoWidth, height = el.videoHeight;
    let poster: Blob | null = null;
    try {
      const seeked = waitFor(el, "seeked", 15000);
      el.currentTime = Math.min(1, duration / 3);
      await seeked;
      const scale = Math.min(1, 720 / Math.max(width, height, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d")?.drawImage(el, 0, 0, canvas.width, canvas.height);
      poster = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    } catch {
      poster = null;
    }
    return { duration, width, height, poster };
  } finally {
    URL.revokeObjectURL(url);
  }
}
function Loading() {
  return <div className="stack" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton" style={{ height: 64 }} />)}</div>;
}
function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={retry}>Try again</button></div>;
}
function GenderSelect({ id, value, onChange, label = "Gender" }: { id: string; value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not specified</option>
        <option value="female">Female</option>
        <option value="male">Male</option>
      </select>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ overview */

function OverviewTab() {
  const { data, loading, error, reload } = useApi<Overview>("/admin/overview");
  if (loading) return <Loading />;
  if (error || !data) return <LoadError error={error || "Not available."} retry={() => void reload()} />;
  const stats: { label: string; value: number; sub?: string; bad?: boolean }[] = [
    { label: "Users", value: data.users, sub: `+${number(data.newUsers)} in the last 24 h` },
    { label: "Paying", value: data.paying, sub: `Active subscriptions${data.granted ? ` · ${number(data.granted)} free month${data.granted === 1 ? "" : "s"}` : ""}` },
    { label: "Posts made", value: data.posts, sub: "Last 24 h" },
    { label: "Runs in progress", value: data.activeRuns, sub: "Queued or running" },
    { label: "Failed runs", value: data.failedRuns, sub: "Last 24 h", bad: data.failedRuns > 0 },
    { label: "Published", value: data.published, sub: "Last 24 h" },
    { label: "Failed publications", value: data.failedPublications, sub: "Last 24 h", bad: data.failedPublications > 0 },
  ];
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row between">
        <h2 style={{ fontSize: 20 }}>Activity</h2>
        <button type="button" className="btn sm" onClick={() => void reload()}><RefreshCw size={14} aria-hidden="true" />Refresh</button>
      </div>
      <div className="grid four">
        {stats.map((s) => (
          <div key={s.label} className={`card stat-card${s.bad ? " bad" : ""}`}>
            <span className="label">{s.label}</span>
            <strong>{number(s.value)}</strong>
            {s.sub && <span className="sub">{s.sub}</span>}
          </div>
        ))}
      </div>
      <section className="card" aria-labelledby="config-title">
        <h2 id="config-title" style={{ marginBottom: 12 }}>Configuration</h2>
        <ul className="list-plain flag-grid">
          {Object.entries(data.config).map(([key, on]) => (
            <li key={key} className={`chip ${on ? "green" : "red"}`}>{on ? "On" : "Off"} · {flagNames[key] || key}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ library */

function LibraryTab() {
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<{ items: AdminItem[] }>("/admin/library");
  const [kind, setKind] = useState<"all" | Kind>("all");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<AdminItem | null>(null);
  const [editing, setEditing] = useState<AdminItem | null>(null);
  const [deleting, setDeleting] = useState<AdminItem | null>(null);
  const items = data?.items || [];
  const q = query.trim().toLowerCase();
  const shown = items.filter((i) => (kind === "all" || i.kind === kind) && (!q || i.name.toLowerCase().includes(q) || i.rawTags.toLowerCase().includes(q)));
  const change = (id: string, c: Partial<AdminItem>) => setData((d) => (d ? { items: d.items.map((i) => (i.id === id ? { ...i, ...c } : i)) } : d));
  const setActive = async (item: AdminItem, active: boolean) => {
    change(item.id, { active });
    try {
      await patch(`/admin/library/${item.id}`, { active });
    } catch (e) {
      change(item.id, { active: item.active });
      toast(errorText(e), "bad");
    }
  };
  const counts = { all: items.length, clip: 0, greenscreen: 0, music: 0 };
  for (const i of items) counts[i.kind]++;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <LibraryUpload onUploaded={() => void reload()} />
      <section aria-labelledby="library-list-title">
        <div className="section-head">
          <h2 id="library-list-title">Library items</h2>
          <div className="toolbar">
            <label className="search" style={{ width: 220 }}>
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search by name or tag</span>
              <input className="input" type="search" placeholder="Name or tag" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <div className="tag-filter" role="group" aria-label="Kind" style={{ margin: 0 }}>
              {(["all", "clip", "greenscreen", "music"] as const).map((k) => (
                <button key={k} type="button" className="chip button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k === "all" ? "All" : kindNames[k]} · {counts[k]}
                </button>
              ))}
            </div>
          </div>
        </div>
        {loading ? <Loading /> : error ? <LoadError error={error} retry={() => void reload()} /> : !items.length ? (
          <Empty icon={<Film size={24} />} title="The library is empty">Upload clips, green-screen creators and music above.</Empty>
        ) : !shown.length ? (
          <p className="muted center" style={{ padding: 24 }}>Nothing matches.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Library items</caption>
              <thead><tr><th scope="col">Preview</th><th scope="col">Name</th><th scope="col">Tags</th><th scope="col">Length</th><th scope="col">Active</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <button type="button" className="adm-thumb" style={{ border: 0, padding: 0, cursor: "pointer" }} onClick={() => setPreview(i)} aria-label={`Preview ${i.name}`}>
                        {i.kind === "music" ? <Music size={20} aria-hidden="true" /> : i.thumb ? <img src={i.thumb} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = "none"; }} /> : <Film size={20} aria-hidden="true" />}
                      </button>
                    </td>
                    <td>
                      <span className="clip" style={{ fontWeight: 600 }} title={i.name}>{i.name}</span>
                      <span className="small muted">{kindNames[i.kind]}{i.width ? ` · ${i.width}×${i.height}` : ""}</span>
                    </td>
                    <td><span className="clip small" title={i.rawTags}>{i.rawTags || <span className="muted">No tags</span>}</span></td>
                    <td className="small">{seconds(i.duration)}</td>
                    <td><Switch checked={i.active} onChange={(v) => void setActive(i, v)} label={`${i.name} is active`} /></td>
                    <td>
                      <div className="icon-actions">
                        <button type="button" className="btn icon ghost" onClick={() => setPreview(i)} aria-label={`Preview ${i.name}`} title="Preview"><Eye size={16} /></button>
                        <button type="button" className="btn icon ghost" onClick={() => setEditing(i)} aria-label={`Edit ${i.name}`} title="Edit"><Pencil size={16} /></button>
                        <button type="button" className="btn icon ghost danger" onClick={() => setDeleting(i)} aria-label={`Delete ${i.name}`} title="Delete"><Trash2 size={16} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {preview && <PreviewModal item={preview} onClose={() => setPreview(null)} />}
      {editing && <EditItemModal item={editing} onClose={() => setEditing(null)} onSaved={(c) => { change(editing.id, c); setEditing(null); }} />}
      {deleting && (
        <ConfirmDialog title="Delete this library item?" onClose={() => setDeleting(null)} onConfirm={async () => {
          await del(`/admin/library/${deleting.id}`);
          setData((d) => (d ? { items: d.items.filter((x) => x.id !== deleting.id) } : d));
          toast("Deleted.", "good");
        }}>
          <p><strong>{deleting.name}</strong> disappears from the library. Posts already rendered with it keep their video; to hide it only, switch it off instead.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function LibraryUpload({ onUploaded }: { onUploaded: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>("clip");
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [keyed, setKeyed] = useState(false);
  const [chroma, setChroma] = useState("#00ff00");
  const [stage, setStage] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const video = kind !== "music";
  const addTag = (t: string) => setTags((v) => (splitTags(v).some((x) => x.toLowerCase() === t) ? v : [...splitTags(v), t].join(", ")));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (stage) return;
    setProblem(null);
    if (!file) return setProblem("Choose a file.");
    const mime = mimeOf(file);
    if (video ? !mime.startsWith("video/") : !mime.startsWith("audio/")) return setProblem(video ? "Choose an MP4, MOV or WebM video." : "Choose an MP3, M4A, OGG or WAV track.");
    if (file.size > 50 * MB) return setProblem("Library files can be up to 50 MB.");
    try {
      setStage("Reading the file…");
      const m = await measure(file, video);
      if (m.duration < 0.5 || m.duration > 600) throw new Error("Library files must be between half a second and 10 minutes long.");
      if (m.width > 4096 || m.height > 4096) throw new Error("Videos can be up to 4096 pixels on each side.");
      const allTags = [...splitTags(tags), ...(kind === "greenscreen" && keyed ? [`chroma:${chroma.toLowerCase()}`] : [])].join(", ");
      const title = name.trim() || baseName(file.name) || "Untitled";
      const query = new URLSearchParams({ kind, name: title, tags: allTags, duration: m.duration.toFixed(2), width: String(m.width), height: String(m.height) });
      setStage("Uploading…");
      setProgress(0);
      const { id } = await sendFile<{ id: string }>(`/admin/library/file?${query}`, file, mime, setProgress);
      setProgress(null);
      if (m.poster) {
        setStage("Saving the thumbnail…");
        try {
          await sendFile(`/admin/library/${id}/thumb`, m.poster, "image/jpeg");
        } catch (err) {
          toast(`Uploaded, but the thumbnail failed: ${errorText(err)}`, "bad");
        }
      }
      toast(`${title} is in the library.`, "good");
      setFile(null); setName(""); setTags(""); setKeyed(false);
      onUploaded();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setStage(null);
      setProgress(null);
    }
  };
  return (
    <section className="card" aria-labelledby="library-upload-title">
      <div className="card-head">
        <div>
          <h2 id="library-upload-title">Add to the library</h2>
          <p>Up to 50 MB. Length and size are measured here in your browser; clips also get a thumbnail.</p>
        </div>
      </div>
      <form className="form-grid" onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="lib-kind">Kind</label>
          <select id="lib-kind" className="select" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setFile(null); }} disabled={!!stage}>
            <option value="clip">Clip (Wall of Text, Hook & Demo)</option>
            <option value="greenscreen">Green-screen creator</option>
            <option value="music">Music</option>
          </select>
        </div>
        <div className="field">
          <span className="label" id="lib-file-label">File</span>
          <div className="row">
            <button type="button" className="btn" onClick={() => input.current?.click()} disabled={!!stage} aria-describedby="lib-file-label lib-file-name">
              <UploadIcon size={16} aria-hidden="true" />{file ? "Change file" : "Choose file"}
            </button>
            <span id="lib-file-name" className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file ? `${file.name} · ${bytes(file.size)}` : "No file chosen"}</span>
          </div>
          <input ref={input} type="file" hidden tabIndex={-1} aria-hidden="true" accept={video ? "video/mp4,video/quicktime,video/webm,.mov" : "audio/*,.mp3,.m4a,.wav,.ogg"}
            onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ""; setFile(f); if (f && !name.trim()) setName(baseName(f.name)); }} />
        </div>
        <div className="field">
          <label className="label" htmlFor="lib-name">Name</label>
          <input id="lib-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Woman laughing at phone" disabled={!!stage} />
        </div>
        <div className="field">
          <label className="label" htmlFor="lib-tags">Tags</label>
          <input id="lib-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} maxLength={280} placeholder="Comma-separated, e.g. reaction, woman" disabled={!!stage} aria-describedby="lib-tags-hint" />
          {video && (
            <div className="row wrap" id="lib-tags-hint" style={{ gap: 6 }}>
              <span className="hint">Add:</span>
              {clipTagIdeas.map((t) => <button key={t} type="button" className="chip button tag-chip" onClick={() => addTag(t)} disabled={!!stage}>{t}</button>)}
            </div>
          )}
        </div>
        {kind === "greenscreen" && (
          <div className="field full">
            <label className="check">
              <input type="checkbox" checked={keyed} onChange={(e) => setKeyed(e.target.checked)} disabled={!!stage} />
              <span>Set the key colour (otherwise pure green is assumed)</span>
            </label>
            {keyed && (
              <div className="color-field" style={{ maxWidth: 260 }}>
                <input type="color" value={chroma} onChange={(e) => setChroma(e.target.value)} aria-label="Key colour" />
                <span className="small muted">Stored as the tag <code>chroma:{chroma.toLowerCase()}</code></span>
              </div>
            )}
          </div>
        )}
        {problem && <div className="notice bad full" role="alert">{problem}</div>}
        <div className="full row wrap">
          <button type="submit" className="btn primary" disabled={!file || !!stage}>{stage ? <Spinner label="Uploading" /> : <UploadIcon size={16} aria-hidden="true" />}Upload</button>
          {stage && <span className="small muted" role="status">{stage}{progress !== null && ` ${Math.round(progress * 100)}%`}</span>}
          {progress !== null && <div className="meter grow" style={{ maxWidth: 260 }} aria-hidden="true"><span style={{ width: `${Math.max(2, progress * 100)}%` }} /></div>}
        </div>
      </form>
    </section>
  );
}

function PreviewModal({ item, onClose }: { item: AdminItem; onClose: () => void }) {
  const close = useStableCallback(onClose);
  return (
    <Modal title={item.name} onClose={close} wide>
      <div className="adm-preview stack">
        {!item.active && <div className="notice warn">This item is switched off, so its file isn't served. Switch it on to preview it.</div>}
        {item.kind === "music"
          ? <audio controls autoPlay={false} src={item.url} />
          : <video controls playsInline src={item.url} poster={item.thumb || undefined} />}
        <div className="row wrap small muted">
          <span>{kindNames[item.kind]}</span>·<span>{seconds(item.duration)}</span>{item.width > 0 && <>·<span>{item.width} × {item.height}</span></>}
          {item.tags.length > 0 && <>·<span>{item.tags.join(", ")}</span></>}
          <a className="btn sm" href={item.url} download style={{ marginLeft: "auto" }}><Download size={14} aria-hidden="true" />Download</a>
        </div>
      </div>
    </Modal>
  );
}

function EditItemModal({ item, onClose, onSaved }: { item: AdminItem; onClose: () => void; onSaved: (c: Partial<AdminItem>) => void }) {
  const toast = useToast();
  const [name, setName] = useState(item.name);
  const [tags, setTags] = useState(item.rawTags);
  const [busy, setBusy] = useState(false);
  const close = useStableCallback(onClose);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const raw = tags.split(",").map((t) => t.trim()).filter(Boolean).join(", ");
    try {
      await patch(`/admin/library/${item.id}`, { name: name.trim(), tags: raw });
      toast("Saved.", "good");
      onSaved({ name: name.trim(), rawTags: raw, tags: splitTags(raw) });
    } catch (err) {
      toast(errorText(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title="Edit library item" onClose={close}>
      <form className="stack" onSubmit={save}>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></label>
        <label className="field">
          <span>Tags</span>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} maxLength={300} />
          <span className="hint">Comma-separated. A green-screen clip may carry its key colour as <code>chroma:#00ff00</code>.</span>
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy && <Spinner label="Saving" />}Save</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------------------------------------ creators */

const portraitUrl = (c: AdminCharacter) => `/api/characters/${c.id}/image?v=${c.updated_at}`;
const enginesOf = (c: AdminCharacter) => { try { const e = JSON.parse(c.engines); return Array.isArray(e) ? (e as string[]) : []; } catch { return []; } };
/** IDs per bulk request (the server takes up to 500). */
const BULK_IDS = 500;

function CreatorsTab() {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [gender, setGender] = useState("");
  const [status, setStatus] = useState("all");
  const [kind, setKind] = useState("all");
  const q = useDebounced(query.trim());
  const list = usePaged<AdminCharacter, { total?: number }>("/admin/characters", { q, gender, status, kind, limit: "50" });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkGender, setBulkGender] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [editing, setEditing] = useState<AdminCharacter | null>(null);
  const [deleting, setDeleting] = useState<AdminCharacter | null>(null);
  const items = list.items, total = list.first?.total;
  const filtered = !!q || !!gender || status !== "all" || kind !== "all";
  const change = (ids: Set<string>, c: Partial<AdminCharacter>) => list.setItems((all) => all.map((x) => (ids.has(x.id) ? { ...x, ...c } : x)));
  const setActive = async (c: AdminCharacter, active: boolean) => {
    change(new Set([c.id]), { active: active ? 1 : 0 });
    try {
      await patch(`/admin/characters/${c.id}`, { active });
    } catch (e) {
      change(new Set([c.id]), { active: c.active });
      toast(errorText(e), "bad");
    }
  };
  const allShown = items.length > 0 && items.every((c) => selected.has(c.id));
  const someShown = items.some((c) => selected.has(c.id));
  const toggle = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const toggleShown = (on: boolean) => setSelected((s) => { const n = new Set(s); for (const c of items) if (on) n.add(c.id); else n.delete(c.id); return n; });
  const bulk = async (body: { active?: boolean; gender?: string }, done: string) => {
    const ids = [...selected];
    setBulkBusy(true);
    let updated = 0;
    try {
      for (let i = 0; i < ids.length; i += BULK_IDS) updated += (await post<{ updated: number }>("/admin/characters/bulk", { ids: ids.slice(i, i + BULK_IDS), ...body })).updated;
      change(selected, { ...(body.active !== undefined && { active: body.active ? 1 : 0 }), ...(body.gender !== undefined && { gender: body.gender }) });
      toast(`${done} ${number(updated)} creator${updated === 1 ? "" : "s"}.`, "good");
    } catch (e) {
      // Earlier batches may have gone through: show the list as it is now.
      toast(errorText(e), "bad");
      if (updated) list.reload();
    } finally {
      setBulkBusy(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 20 }}>
      <AddCreators onDone={list.reload} />
      <section aria-labelledby="creators-list-title">
        <div className="section-head">
          <div>
            <h2 id="creators-list-title">Library creators</h2>
            <p>Creators with a HeyGen look are standard; the rest are premium (animated from the portrait, at the higher rate).</p>
          </div>
          <div className="filter-bar">
            <label className="search">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search by name or description</span>
              <input className="input" type="search" placeholder="Name or description" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <select className="select compact" value={gender} onChange={(e) => setGender(e.target.value)} aria-label="Gender">
              <option value="">Any gender</option><option value="female">Female</option><option value="male">Male</option><option value="none">Not specified</option>
            </select>
            <select className="select compact" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="all">On and off</option><option value="active">On</option><option value="off">Off</option>
            </select>
            <select className="select compact" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
              <option value="all">All kinds</option><option value="look">HeyGen look</option><option value="portrait">Portrait (premium)</option>
            </select>
          </div>
        </div>
        {list.loading && !items.length ? <Loading /> : list.error && !items.length ? <LoadError error={list.error} retry={list.reload} /> : !items.length ? (
          filtered
            ? <Empty icon={<Search size={24} />} title="No creators match" action={<button type="button" className="btn" onClick={() => { setQuery(""); setGender(""); setStatus("all"); setKind("all"); }}>Clear filters</button>}>Try other words or filters.</Empty>
            : <Empty icon={<UserRound size={24} />} title="No library creators yet">Upload a portrait or import HeyGen looks above.</Empty>
        ) : (
          <div className={`table-wrap${list.loading ? " list-stale" : ""}`} aria-busy={list.loading}>
            <table className="table">
              <caption className="sr-only">Library creators</caption>
              <thead>
                <tr>
                  <th scope="col" className="check-cell">
                    <input type="checkbox" aria-label="Select all shown creators" checked={allShown} onChange={(e) => toggleShown(e.target.checked)}
                      ref={(el) => { if (el) el.indeterminate = someShown && !allShown; }} />
                  </th>
                  <th scope="col">Portrait</th><th scope="col">Name</th><th scope="col">Description</th><th scope="col">HeyGen look</th><th scope="col">Active</th><th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id}>
                    <td className="check-cell"><input type="checkbox" aria-label={`Select ${c.name}`} checked={selected.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} /></td>
                    <td><span className="adm-thumb"><img src={portraitUrl(c)} alt={`Portrait of ${c.name}`} loading="lazy" decoding="async" /></span></td>
                    <td><strong>{c.name}</strong><div className="small muted">{genderNames[c.gender] ?? c.gender}</div></td>
                    <td><span className="clip small" title={c.description}>{c.description || <span className="muted">None</span>}</span></td>
                    <td className="small">
                      {c.look_id ? <><code className="clip" title={c.look_id}>{c.look_id}</code><span className="muted">{enginesOf(c).join(", ")}</span></> : <span className="chip orange">Premium · no look</span>}
                    </td>
                    <td><Switch checked={!!c.active} onChange={(v) => void setActive(c, v)} label={`${c.name} is active`} /></td>
                    <td>
                      <div className="icon-actions">
                        <button type="button" className="btn icon ghost" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`} title="Edit"><Pencil size={16} /></button>
                        <button type="button" className="btn icon ghost danger" onClick={() => setDeleting(c)} aria-label={`Delete ${c.name}`} title="Delete"><Trash2 size={16} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <LoadMore next={list.next} loading={list.loadingMore} error={list.moreError} shown={items.length} total={total} noun="creators" onMore={list.loadMore} />
        {selected.size > 0 && (
          <div className="bulk-bar" role="region" aria-label="Selected creators">
            <span><strong>{number(selected.size)}</strong> selected</span>
            <div className="row">
              <button type="button" className="btn sm" disabled={bulkBusy} onClick={() => void bulk({ active: true }, "Switched on")}>Switch on</button>
              <button type="button" className="btn sm" disabled={bulkBusy} onClick={() => void bulk({ active: false }, "Switched off")}>Switch off</button>
              <select className="select compact" value={bulkGender} onChange={(e) => setBulkGender(e.target.value)} aria-label="Gender for the selected creators" disabled={bulkBusy}>
                <option value="">Not specified</option><option value="female">Female</option><option value="male">Male</option>
              </select>
              <button type="button" className="btn sm" disabled={bulkBusy} onClick={() => void bulk({ gender: bulkGender }, "Set the gender of")}>Set gender</button>
              <button type="button" className="btn sm ghost" disabled={bulkBusy} onClick={() => setSelected(new Set())}>Clear selection</button>
              {bulkBusy && <Spinner label="Saving" />}
            </div>
          </div>
        )}
      </section>
      {editing && <EditCreatorModal creator={editing} onClose={() => setEditing(null)} onSaved={(c) => { list.setItems((all) => all.map((x) => (x.id === c.id ? c : x))); setEditing(null); }} />}
      {deleting && (
        <ConfirmDialog title="Delete this creator?" onClose={() => setDeleting(null)} onConfirm={async () => {
          await del(`/admin/characters/${deleting.id}`);
          list.setItems((all) => all.filter((x) => x.id !== deleting.id));
          list.setFirst((f) => (f && f.total !== undefined ? { ...f, total: Math.max(0, f.total - 1) } : f));
          toggle(deleting.id, false);
          toast("Deleted.", "good");
        }}>
          <p><strong>{deleting.name}</strong> is removed from the library for everyone. To hide them only, switch them off instead.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

type AddMode = "browse" | "looks" | "look" | "portrait";
/** The ways to add library creators, in one card. Every form stays mounted, so a running import keeps going. */
function AddCreators({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<AddMode>("browse");
  return (
    <section className="card" aria-labelledby="add-creators-title">
      <div className="card-head" style={{ alignItems: "center" }}>
        <h2 id="add-creators-title">Add library creators</h2>
        <Tabs label="How to add creators" idBase="add-creators" value={mode} onChange={setMode} items={[
          { id: "browse", label: "Browse HeyGen" }, { id: "looks", label: "HeyGen looks" }, { id: "look", label: "One look, with details" }, { id: "portrait", label: "Portrait" },
        ]} />
      </div>
      {(["browse", "looks", "look", "portrait"] as const).map((m) => (
        <div key={m} hidden={mode !== m} {...(mode === m && tabPanel("add-creators", m))}>
          {m === "browse" ? <BrowseHeyGen onDone={onDone} /> : m === "looks" ? <BulkImport onDone={onDone} /> : m === "look" ? <ImportLook onDone={onDone} /> : <PortraitUpload onDone={onDone} />}
        </div>
      ))}
    </section>
  );
}

const importLabels: Record<LookImport["status"], { label: string; tone: string }> = {
  failed: { label: "Failed, try again", tone: "red" }, unusable: { label: "Can't be used", tone: "orange" }, exists: { label: "Already in the library", tone: "" }, imported: { label: "Imported", tone: "green" },
};
/** Bulk import requests: small, so the progress moves and a stop takes effect quickly. */
const IMPORT_CHUNK = 10;

/** Many HeyGen looks at once: pasted IDs are checked a few at a time, each with its own result. */
function BulkImport({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [gender, setGender] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<LookImport[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const stop = useRef(false);
  const { ids, repeated } = parseLookIds(text);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (progress) return;
    setProblem(null);
    if (!ids.length) return setProblem("Paste at least one look ID.");
    if (ids.length > BULK_PASTE) return setProblem(`Paste up to ${number(BULK_PASTE)} look IDs at a time.`);
    stop.current = false;
    const all: LookImport[] = [];
    setResults([]);
    setProgress({ done: 0, total: ids.length });
    try {
      for (let i = 0; i < ids.length && !stop.current; i += IMPORT_CHUNK) {
        const r = await post<{ results: LookImport[] }>("/admin/characters/import/bulk", { lookIds: ids.slice(i, i + IMPORT_CHUNK), gender });
        all.push(...r.results);
        setResults([...all]);
        setProgress({ done: all.length, total: ids.length });
      }
      if (all.length === ids.length) setText("");
      else setProblem(`Stopped after ${number(all.length)} of ${number(ids.length)}. The rest are still in the box.`);
      if (all.length < ids.length) setText(ids.slice(all.length).join("\n"));
    } catch (err) {
      // Requests already answered stay imported; the rest (including the one that failed) stay in the box.
      setProblem(`${errorText(err)}${all.length ? ` ${number(all.length)} of ${number(ids.length)} were checked; the rest are still in the box.` : ""}`);
      setText(ids.slice(all.length).join("\n"));
    } finally {
      setProgress(null);
      if (all.some((r) => r.status === "imported")) onDone();
    }
  };
  const counts = { imported: 0, exists: 0, unusable: 0, failed: 0 };
  for (const r of results) counts[r.status]++;
  const order: LookImport["status"][] = ["failed", "unusable", "exists", "imported"];
  const sorted = [...results].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const retry = results.filter((r) => r.status === "failed").map((r) => r.lookId);
  return (
    <div>
      <p className="muted small" style={{ marginBottom: 14 }}>
        Paste look IDs, one per line or separated by commas. Each is checked with HeyGen (it needs the Avatar III engine), named after the look and given
        its preview as the portrait; looks already in the library are skipped. Up to {number(BULK_PASTE)} at a time.
      </p>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <div className="field full">
            <label className="label" htmlFor="bulk-ids">Look IDs <span className="counter">{number(ids.length)} ID{ids.length === 1 ? "" : "s"}{repeated ? ` · ${number(repeated)} repeated, counted once` : ""}</span></label>
            <textarea id="bulk-ids" className="textarea ids-box" rows={5} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} disabled={!!progress}
              placeholder={"One look ID per line, or separated by commas"} />
          </div>
          <GenderSelect id="bulk-gender" value={gender} onChange={setGender} label="Gender (for all of them)" />
        </div>
        {problem && <div className="notice bad" role="alert">{problem}</div>}
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button type="submit" className="btn primary" disabled={!!progress || !ids.length}>
            {progress ? <Spinner label="Importing" /> : <UploadIcon size={16} aria-hidden="true" />}Import {ids.length > 1 ? `${number(ids.length)} looks` : "look"}
          </button>
          {progress && <button type="button" className="btn" onClick={() => { stop.current = true; }}>Stop</button>}
          {progress && <span className="small muted" role="status">Checked {number(progress.done)} of {number(progress.total)}…</span>}
          {progress && <div className="meter grow" style={{ maxWidth: 260 }} aria-hidden="true"><span style={{ width: `${Math.max(2, (progress.done / progress.total) * 100)}%` }} /></div>}
        </div>
      </form>
      {results.length > 0 && (
        <div className="stack" style={{ marginTop: 16 }}>
          <div className="row" style={{ flexWrap: "wrap" }} role="status">
            {order.filter((s) => counts[s]).map((s) => <span key={s} className={`chip ${importLabels[s].tone}`}>{importLabels[s].label} · {number(counts[s])}</span>)}
            {retry.length > 0 && !progress && <button type="button" className="btn sm" onClick={() => { setText((t) => parseLookIds(`${t}\n${retry.join("\n")}`).ids.join("\n")); setProblem(null); }}>Put the failed IDs back in the box</button>}
          </div>
          <div className="table-wrap import-results">
            <table className="table">
              <caption className="sr-only">Import results, problems first</caption>
              <thead><tr><th scope="col">Look ID</th><th scope="col">Result</th><th scope="col">Creator or reason</th></tr></thead>
              <tbody>
                {sorted.map((r) => (
                  <tr key={r.lookId}>
                    <td><code>{r.lookId}</code></td>
                    <td><span className={`chip ${importLabels[r.status].tone}`}>{importLabels[r.status].label}</span></td>
                    <td className="small">{r.name && <strong>{r.name}</strong>}{r.name && r.error && " · "}{r.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function PortraitUpload({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gender, setGender] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (!file) return setProblem("Choose a portrait.");
    if (!name.trim()) return setProblem("Give the creator a name.");
    const mime = mimeOf(file);
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) return setProblem("Use a JPG, PNG or WebP portrait.");
    if (file.size > 10 * MB) return setProblem("Portraits can be up to 10 MB.");
    setBusy(true);
    try {
      const q = new URLSearchParams({ name: name.trim(), description: description.trim(), gender });
      await sendFile(`/admin/characters/file?${q}`, file, mime);
      toast(`${name.trim()} was added.`, "good");
      setFile(null); setName(""); setDescription(""); setGender("");
      onDone();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p className="muted small" style={{ marginBottom: 14 }}>A premium creator, animated from this image. Portrait 3:4 or 9:16, up to 10 MB.</p>
      <form className="stack" onSubmit={submit}>
        <div className="row">
          <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy}><UploadIcon size={16} aria-hidden="true" />{file ? "Change image" : "Choose image"}</button>
          <span className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file ? file.name : "No image chosen"}</span>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden tabIndex={-1} aria-hidden="true"
            onChange={(e) => { const f = e.target.files?.[0] || null; e.target.value = ""; setFile(f); if (f && !name.trim()) setName(baseName(f.name).slice(0, 40)); }} />
        </div>
        <div className="form-grid">
          <div className="field"><label className="label" htmlFor="portrait-name">Name</label><input id="portrait-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} /></div>
          <GenderSelect id="portrait-gender" value={gender} onChange={setGender} />
          <div className="field full"><label className="label" htmlFor="portrait-description">Description</label><textarea id="portrait-description" className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></div>
        </div>
        {problem && <div className="notice bad" role="alert">{problem}</div>}
        <button type="submit" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={busy || !file}>{busy && <Spinner label="Uploading" />}Add creator</button>
      </form>
    </div>
  );
}

function ImportLook({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [lookId, setLookId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gender, setGender] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (!lookId.trim()) return setProblem("Paste the look ID from HeyGen.");
    setBusy(true);
    try {
      await post("/admin/characters/import", { lookId: lookId.trim(), ...(name.trim() && { name: name.trim() }), description: description.trim(), gender });
      toast("Imported. The creator is in the library.", "good");
      setLookId(""); setName(""); setDescription(""); setGender("");
      onDone();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <p className="muted small" style={{ marginBottom: 14 }}>A standard creator with your own name and description: the look's preview becomes the portrait. It needs the Avatar III engine.</p>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <div className="field full"><label className="label" htmlFor="look-id">Look ID</label><input id="look-id" className="input" value={lookId} onChange={(e) => setLookId(e.target.value)} maxLength={160} spellCheck={false} /></div>
          <div className="field"><label className="label" htmlFor="look-name">Name (optional)</label><input id="look-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="The look's own name" /></div>
          <GenderSelect id="look-gender" value={gender} onChange={setGender} />
          <div className="field full"><label className="label" htmlFor="look-description">Description</label><textarea id="look-description" className="textarea" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></div>
        </div>
        {problem && <div className="notice bad" role="alert">{problem}</div>}
        <button type="submit" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={busy || !lookId.trim()}>{busy && <Spinner label="Importing" />}Import look</button>
      </form>
    </div>
  );
}

function EditCreatorModal({ creator, onClose, onSaved }: { creator: AdminCharacter; onClose: () => void; onSaved: (c: AdminCharacter) => void }) {
  const toast = useToast();
  const [name, setName] = useState(creator.name);
  const [description, setDescription] = useState(creator.description);
  const [gender, setGender] = useState(creator.gender);
  const [lookId, setLookId] = useState(creator.look_id || "");
  const [busy, setBusy] = useState(false);
  const close = useStableCallback(onClose);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const look = lookId.trim();
    try {
      const r = await patch<{ character: AdminCharacter }>(`/admin/characters/${creator.id}`, {
        name: name.trim(), description: description.trim(), gender,
        ...(look !== (creator.look_id || "") && { lookId: look || null }),
      });
      toast("Saved.", "good");
      onSaved(r.character);
    } catch (err) {
      toast(errorText(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title={`Edit ${creator.name}`} onClose={close}>
      <form className="stack" onSubmit={save}>
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <img src={portraitUrl(creator)} alt={`Portrait of ${creator.name}`} style={{ width: 96, aspectRatio: "3 / 4", objectFit: "cover", borderRadius: 12, flex: "none" }} />
          <div className="stack grow">
            <div className="field"><label className="label" htmlFor="edit-c-name">Name</label><input id="edit-c-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required /></div>
            <GenderSelect id="edit-c-gender" value={gender} onChange={setGender} />
          </div>
        </div>
        <div className="field"><label className="label" htmlFor="edit-c-description">Description</label><textarea id="edit-c-description" className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></div>
        <div className="field">
          <label className="label" htmlFor="edit-c-look">HeyGen look ID</label>
          <input id="edit-c-look" className="input" value={lookId} onChange={(e) => setLookId(e.target.value)} maxLength={160} spellCheck={false} aria-describedby="edit-c-look-hint" />
          <span id="edit-c-look-hint" className="hint">Linking a look makes this a standard creator (checked with HeyGen). Clear it to make it premium.</span>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy && <Spinner label="Saving" />}Save</button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------------------------------------ messages */

function MessagesTab() {
  const { data, loading, error, reload } = useApi<{ messages: Message[] }>("/admin/messages");
  if (loading) return <Loading />;
  if (error || !data) return <LoadError error={error || "Not available."} retry={() => void reload()} />;
  if (!data.messages.length) return <Empty icon={<Mail size={24} />} title="No messages">Messages from the contact form show up here.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Contact messages, newest first</caption>
        <thead><tr><th scope="col">Received</th><th scope="col">From</th><th scope="col">Topic</th><th scope="col">Message</th></tr></thead>
        <tbody>
          {data.messages.map((m) => (
            <tr key={m.id} style={{ verticalAlign: "top" }}>
              <td className="small" style={{ whiteSpace: "nowrap" }} title={formatDate(m.created_at, true)}>{ago(m.created_at)}</td>
              <td>
                <strong>{m.name}</strong>
                <div className="small"><a href={`mailto:${m.email}?subject=${encodeURIComponent(`Re: ${topics[m.topic] || "Your message"}`)}`} className="link">{m.email}</a></div>
              </td>
              <td><span className={`chip${m.topic === "abuse" ? " red" : m.topic === "billing" || m.topic === "withdrawal" ? " orange" : ""}`}>{topics[m.topic] || m.topic}</span></td>
              <td><MessageText text={m.message} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MessageText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= 240) return <p className="msg-text">{text}</p>;
  return (
    <div>
      <p className="msg-text">{open ? text : `${text.slice(0, 220).trimEnd()}…`}</p>
      <button type="button" className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Show less" : "Show all"}</button>
    </div>
  );
}
