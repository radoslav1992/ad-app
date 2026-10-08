/**
 * Shared pickers, upload helpers and small building blocks for the dashboard pages.
 *
 * Modals
 * - <MediaPicker workspaceId type title? allowUpload? onPick onClose />
 *     workspaceId: string — whose library to list (assets of the workspace plus account-wide ones).
 *     type: "image" | "video" | "audio" — only ready assets of this type are listed, newest first.
 *     title?: string — the modal heading (default "Choose an image" / "Choose a video" / "Choose a track").
 *     allowUpload?: boolean — show an upload button (default true); a file uploaded here is selected once ready.
 *     onPick(asset: Asset) — called once with the chosen, ready asset. The picker does not close itself:
 *       unmount it in onPick (onClose is not called).
 *     onClose() — Cancel, Escape or a click on the backdrop.
 * - <LibraryPicker kind title? onPick onClose />
 *     kind: "clip" | "greenscreen" | "music" — the shared library (GET /api/library?kind=).
 *     Tag filter chips (every chosen tag must match), 12 items a page, clips preview on hover/focus (poster =
 *     item.thumb), music has a play button. onPick(item: LibraryItem) / onClose() as for MediaPicker.
 * - <ConfirmDialog title confirmLabel? danger? onConfirm onClose>body</ConfirmDialog>
 *     A confirmation for destructive actions. onConfirm may return a promise: the dialog shows a spinner, toasts
 *     the error if it rejects (and stays open), and calls onClose when it resolves.
 *
 * Uploads
 * - useUploads(workspaceId?, { only?, onDone?, concurrency? }) → { items, add(files), dismiss(key), clearFinished(), busy }
 *     Chunked uploads through uploadFile() (src/lib.tsx), three at a time, with per-file progress and the
 *     server's checking/failed states. onDone(asset) runs for every finished upload (ready or failed).
 * - <UploadList items onDismiss? action?(item) /> — progress rows for useUploads items.
 * - <FileButton accept multiple? label? className? disabled? onFiles(files) /> — a button that opens the file chooser.
 * - <UploadButton workspaceId? type? multiple? label? className? disabled? onUploaded?(asset) />
 *     Self-contained: uploads the chosen files, shows progress in the button and toasts failures.
 * - <DropZone onFiles disabled? label? className?>children</DropZone> — accepts files dropped on its area.
 * - ACCEPT[type], mediaTypeOf(file)
 *
 * Other helpers
 * - <Tabs label value onChange items idBase? /> — ARIA tabs with arrow-key navigation; pair with tabPanel(idBase, value).
 * - useHoverPlay() → { videoRef, handlers } — a muted preview that plays while the pointer or focus is on its card.
 * - usePreviewAudio() → { playing, toggle(id, url), stop() } — one audio preview at a time.
 * - useRetryKey() → { key(body), settle(error?) } — idempotency keys that survive a retry after a network TypeError.
 * - useStableCallback(fn) — a stable function that always calls the latest `fn` (use it for Modal's onClose).
 * - useSignedInUser(), creditBlock(user, cost), assetKindLabel(kind), formatDate(unix), ago(unix), Empty, GridSkeleton.
 */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Check, CheckCircle2, ChevronLeft, ChevronRight, Music, Pause, Play, Search, Upload, UploadCloud } from "lucide-react";
import { Modal, Spinner, useToast } from "../ui";
import { errorText, newKey, seconds, uploadFile, useApi, useAuth, bytes as formatBytes, type Asset, type LibraryItem, type User } from "../lib";
import "./pages.css";

export type MediaType = "image" | "video" | "audio";

/* ------------------------------------------------------------------------------------------------ small helpers */

/** A stable function that always runs the latest `fn` (Modal re-focuses itself whenever its onClose changes). */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R) {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** The signed-in person (pages under the dashboard layout always have one). */
export function useSignedInUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error("This page needs a signed-in user.");
  return user;
}

/**
 * Idempotency keys for paid requests: the same body sent again after a network failure (a TypeError, so the request
 * may have arrived) reuses its key; anything else gets a fresh one.
 */
export function useRetryKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return useMemo(() => ({
    key(body: unknown) {
      const text = JSON.stringify(body);
      if (!last.current || last.current.body !== text) last.current = { body: text, key: newKey() };
      return last.current.key;
    },
    settle(error?: unknown) {
      if (!(error instanceof TypeError)) last.current = null;
    },
  }), []);
}

/** Why AI work costing `cost` credits can't start now, or null. */
export function creditBlock(user: User, cost: number): { text: string; to?: string; action?: string } | null {
  if (!user.verified) return { text: "Confirm your email to use AI credits. We sent you a link when you signed up." };
  if (user.trialEnded) return { text: "Your free trial has ended. Upgrade to keep creating.", to: "/app/billing", action: "See plans" };
  if (user.limit - user.used < cost) return { text: "You're out of AI credits for this period.", to: "/app/billing", action: "Get more credits" };
  return null;
}
export function CreditBlockNotice({ block }: { block: ReturnType<typeof creditBlock> }) {
  if (!block) return null;
  return (
    <div className="notice warn" role="note">
      {block.text} {block.to && <Link to={block.to} className="link">{block.action}</Link>}
    </div>
  );
}

const kindLabels: Record<string, string> = { upload: "Upload", brand: "Website", ai_image: "AI image", ai_clip: "AI clip", portrait: "Portrait" };
export const assetKindLabel = (kind: string) => kindLabels[kind] || "File";

export const formatDate = (unix: number, withTime = false) =>
  new Date(unix * 1000).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) });
/** "just now", "5 min ago", "3 h ago", "2 days ago", or the date. */
export function ago(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} day${s < 2 * 86400 ? "" : "s"} ago`;
  return formatDate(unix);
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty empty-card">
      {icon && <span className="empty-icon" aria-hidden="true">{icon}</span>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function GridSkeleton({ count = 8, tall = false, className = "lib-grid" }: { count?: number; tall?: boolean; className?: string }) {
  return (
    <div className={className} aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => <div key={i} className="skeleton" style={{ aspectRatio: tall ? "9 / 16" : "1" }} />)}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ tabs */

export type TabItem<T extends string> = { id: T; label: ReactNode; count?: number };
/** ARIA tabs: one tab stop, arrow keys / Home / End move between tabs. */
export function Tabs<T extends string>({ label, value, onChange, items, idBase }: { label: string; value: T; onChange: (v: T) => void; items: TabItem<T>[]; idBase?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const n = items.length;
    const next = e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((t, i) => (
        <button
          key={t.id} type="button" role="tab" ref={(el) => { refs.current[i] = el; }}
          id={idBase ? `${idBase}-tab-${t.id}` : undefined} aria-controls={idBase ? `${idBase}-panel` : undefined}
          aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)} onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}{t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
/** Props for the panel that belongs to <Tabs idBase=…>. */
export const tabPanel = (idBase: string, value: string) => ({ role: "tabpanel" as const, id: `${idBase}-panel`, "aria-labelledby": `${idBase}-tab-${value}` });

/* ------------------------------------------------------------------------------------------------ confirm */

export function ConfirmDialog({ title, children, confirmLabel = "Delete", danger = true, disabled = false, onConfirm, onClose }: {
  title: string; children?: ReactNode; confirmLabel?: string; danger?: boolean; disabled?: boolean;
  onConfirm: () => unknown | Promise<unknown>; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const close = useStableCallback(() => { if (!busy) onClose(); });
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
      setBusy(false);
      onClose();
    } catch (e) {
      toast(errorText(e), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={close} footer={
      <>
        <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
        <button type="button" className={`btn ${danger ? "danger-solid" : "primary"}`} onClick={confirm} disabled={busy || disabled}>
          {busy && <Spinner label="Working" />}{confirmLabel}
        </button>
      </>
    }>
      <div className="stack">{children}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------------------------------------ previews */

/** A muted, looping preview: spread `handlers` on the card and give the <video> `videoRef`. */
export function useHoverPlay() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const handlers = useMemo(() => {
    const play = () => { void videoRef.current?.play().catch(() => {}); };
    const stop = () => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      try { v.currentTime = 0; } catch { /* not seekable yet */ }
    };
    return { onMouseEnter: play, onMouseLeave: stop, onFocus: play, onBlur: stop };
  }, []);
  return { videoRef, handlers };
}
/** A video URL that shows its first frame without a poster (most browsers then load only the metadata). */
export const firstFrame = (url: string) => `${url}#t=0.1`;

/** One audio preview at a time (starting another stops the first). */
export function usePreviewAudio() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const stop = useCallback(() => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  }, []);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const toggle = useCallback((id: string, url: string) => {
    if (audio.current && audio.current.dataset.id === id) { stop(); return; }
    audio.current?.pause();
    const a = new Audio(url);
    a.dataset.id = id;
    audio.current = a;
    a.onended = () => { if (audio.current === a) stop(); };
    setPlaying(id);
    void a.play().catch(() => { if (audio.current === a) stop(); });
  }, [stop]);
  return { playing, toggle, stop };
}
export function PlayButton({ playing, onClick, label }: { playing: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className="play-btn" onClick={onClick} aria-label={`${playing ? "Pause" : "Play"} ${label}`} aria-pressed={playing}>
      {playing ? <Pause size={18} /> : <Play size={18} />}
    </button>
  );
}

/* ------------------------------------------------------------------------------------------------ uploads */

const MB = 1024 * 1024;
const types: Record<string, MediaType> = {
  "image/jpeg": "image", "image/png": "image", "image/webp": "image",
  "video/mp4": "video", "video/quicktime": "video", "video/webm": "video",
  "audio/mpeg": "audio", "audio/wav": "audio", "audio/x-wav": "audio", "audio/mp4": "audio", "audio/x-m4a": "audio", "audio/aac": "audio", "audio/ogg": "audio",
};
/** The server's limits per type (server/media.ts). */
const limits: Record<MediaType, number> = { image: 20 * MB, video: 500 * MB, audio: 50 * MB };
export const ACCEPT: Record<MediaType | "any", string> = {
  image: "image/jpeg,image/png,image/webp",
  video: "video/mp4,video/quicktime,video/webm,.mov",
  audio: "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,.mp3,.m4a,.wav,.ogg",
  any: "",
};
ACCEPT.any = [ACCEPT.image, ACCEPT.video, ACCEPT.audio].join(",");
export function mediaTypeOf(file: File): MediaType | null {
  const t = types[file.type.toLowerCase()];
  if (t) return t;
  if (!file.type && /\.mov$/i.test(file.name)) return "video";
  return null;
}
const typeWords: Record<MediaType, { one: string; many: string }> = {
  image: { one: "an image", many: "Images" }, video: { one: "a video", many: "Videos" }, audio: { one: "an audio track", many: "Tracks" },
};

export type Upload = {
  key: string; name: string; bytes: number; type: MediaType | null; progress: number;
  status: "queued" | "uploading" | "checking" | "ready" | "failed"; error: string | null; asset: Asset | null;
};
export type Uploads = ReturnType<typeof useUploads>;
export function useUploads(workspaceId?: string, options: { only?: MediaType; onDone?: (asset: Asset) => void; concurrency?: number } = {}) {
  const [items, setItems] = useState<Upload[]>([]);
  const settings = useRef({ workspaceId, ...options });
  useLayoutEffect(() => {
    settings.current = { workspaceId, ...options };
  });
  const queue = useRef<{ key: string; file: File }[]>([]);
  const active = useRef(0);
  const set = useCallback((key: string, change: Partial<Upload>) => setItems((all) => all.map((i) => (i.key === key ? { ...i, ...change } : i))), []);
  const pump = useCallback(function next() {
    while (active.current < (settings.current.concurrency || 3) && queue.current.length) {
      const job = queue.current.shift();
      if (!job) break;
      active.current++;
      void (async () => {
        set(job.key, { status: "uploading" });
        try {
          const asset = await uploadFile(job.file, settings.current.workspaceId, (share) =>
            set(job.key, share >= 1 ? { progress: 1, status: "checking" } : { progress: share }));
          set(job.key, { status: asset.status === "ready" ? "ready" : asset.status === "failed" ? "failed" : "checking", error: asset.error, asset, progress: 1 });
          settings.current.onDone?.(asset);
        } catch (e) {
          set(job.key, { status: "failed", error: errorText(e) });
        } finally {
          active.current--;
          next();
        }
      })();
    }
  }, [set]);
  const add = useCallback((files: Iterable<File>) => {
    const fresh: Upload[] = [];
    const only = settings.current.only;
    for (const file of files) {
      const type = mediaTypeOf(file);
      const problem = !type
        ? only ? `Choose ${typeWords[only].one} file.` : "This file type isn't supported. Upload JPG, PNG or WebP images, MP4, MOV or WebM videos, or MP3, WAV, M4A or OGG tracks."
        : only && type !== only ? `Choose ${typeWords[only].one} file.`
        : file.size > limits[type] ? `${typeWords[type].many} can be up to ${limits[type] / MB} MB.`
        : file.size < 24 ? "This file is empty." : null;
      const key = newKey();
      fresh.push({ key, name: file.name, bytes: file.size, type, progress: 0, status: problem ? "failed" : "queued", error: problem, asset: null });
      if (!problem) queue.current.push({ key, file });
    }
    setItems((all) => [...fresh, ...all]);
    pump();
  }, [pump]);
  const dismiss = useCallback((key: string) => setItems((all) => all.filter((i) => i.key !== key)), []);
  const clearFinished = useCallback(() => setItems((all) => all.filter((i) => i.status === "queued" || i.status === "uploading" || (i.status === "checking" && !i.asset))), []);
  const busy = items.some((i) => i.status === "queued" || i.status === "uploading" || (i.status === "checking" && !i.asset));
  return { items, add, dismiss, clearFinished, busy };
}

function uploadStatus(u: Upload) {
  if (u.status === "queued") return "Waiting…";
  if (u.status === "uploading") return `Uploading · ${Math.round(u.progress * 100)}% of ${formatBytes(u.bytes)}`;
  if (u.status === "checking") return u.asset ? "Still checking. It appears in your library when it's ready." : "Checking the file…";
  if (u.status === "ready") return "Ready";
  return u.error || "This file can't be used.";
}
export function UploadList({ items, onDismiss, action }: { items: Upload[]; onDismiss?: (key: string) => void; action?: (item: Upload) => ReactNode }) {
  if (!items.length) return null;
  // Announce how many are done rather than every progress step.
  const working = items.filter((u) => u.status === "queued" || u.status === "uploading" || u.status === "checking").length;
  const ready = items.filter((u) => u.status === "ready").length, failed = items.filter((u) => u.status === "failed").length;
  return (
    <>
      <p className="sr-only" aria-live="polite">{[working && `${working} uploading`, ready && `${ready} ready`, failed && `${failed} failed`].filter(Boolean).join(", ")}</p>
      <ul className="uploads list-plain" aria-label="Uploads">
        {items.map((u) => {
          const working = u.status === "queued" || u.status === "uploading" || (u.status === "checking" && !u.asset);
          return (
            <li key={u.key} className={`upload-row${u.status === "failed" ? " failed" : ""}`}>
              {working ? <Spinner label="Uploading" /> : u.status === "failed" ? <AlertCircle size={20} color="var(--red)" aria-hidden="true" /> : u.status === "ready" ? <CheckCircle2 size={20} color="var(--green)" aria-hidden="true" /> : <Spinner label="Checking" />}
              <div className="grow">
                <div className="name">{u.name}</div>
                <div className="status">{uploadStatus(u)}</div>
                {u.status === "uploading" && <div className="meter" role="progressbar" aria-label={`Uploading ${u.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)}><span style={{ width: `${Math.max(3, u.progress * 100)}%` }} /></div>}
              </div>
              <div className="row">
                {action?.(u)}
                {onDismiss && !working && <button type="button" className="btn sm ghost" onClick={() => onDismiss(u.key)} aria-label={`Dismiss ${u.name}`}>Dismiss</button>}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** A button that opens the file chooser. */
export function FileButton({ accept, multiple = false, label = "Upload", className = "btn", disabled = false, icon, onFiles }: {
  accept: string; multiple?: boolean; label?: ReactNode; className?: string; disabled?: boolean; icon?: ReactNode; onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => input.current?.click()} disabled={disabled}>
        {icon ?? <Upload size={16} aria-hidden="true" />}{label}
      </button>
      <input
        ref={input} type="file" accept={accept} multiple={multiple} hidden tabIndex={-1} aria-hidden="true"
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** Uploads the chosen files itself: progress in the button, failures as toasts, `onUploaded` per ready file. */
export function UploadButton({ workspaceId, type, multiple = false, label = "Upload", className = "btn", disabled = false, onUploaded }: {
  workspaceId?: string; type?: MediaType; multiple?: boolean; label?: string; className?: string; disabled?: boolean; onUploaded?: (asset: Asset) => void;
}) {
  const toast = useToast();
  const uploads = useUploads(workspaceId, {
    only: type,
    onDone: (asset) => {
      if (asset.status === "ready") onUploaded?.(asset);
      else if (asset.status === "failed") toast(`${asset.name}: ${asset.error || "This file can't be used."}`, "bad");
    },
  });
  const { items, dismiss } = uploads;
  // Problems found before the upload (type, size) and network errors are toasted once, then dropped.
  useEffect(() => {
    for (const u of items) {
      if (u.status === "failed" && !u.asset) { toast(`${u.name}: ${u.error}`, "bad"); dismiss(u.key); }
      else if (u.status === "ready" || u.status === "failed") dismiss(u.key);
    }
  }, [items, dismiss, toast]);
  const working = items.filter((u) => u.status !== "ready" && u.status !== "failed");
  const share = working.length ? working.reduce((n, u) => n + u.progress, 0) / working.length : 0;
  return (
    <FileButton
      accept={type ? ACCEPT[type] : ACCEPT.any} multiple={multiple} className={className} disabled={disabled || working.length > 0}
      icon={working.length ? <Spinner label="Uploading" /> : undefined}
      label={working.length ? (share >= 1 ? "Checking…" : `Uploading ${Math.round(share * 100)}%`) : label}
      onFiles={uploads.add}
    />
  );
}

/** Accepts files dropped anywhere on its area (with a visible overlay while dragging). */
export function DropZone({ onFiles, disabled = false, label = "Drop files to upload", className = "", children }: {
  onFiles: (files: File[]) => void; disabled?: boolean; label?: string; className?: string; children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: ReactDragEvent) => !disabled && [...e.dataTransfer.types].includes("Files");
  return (
    <div
      className={`dropzone ${className}`}
      onDragEnter={(e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true); }}
      onDragOver={(e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
      }}
    >
      {children}
      {over && <div className="drop-overlay" aria-hidden="true"><UploadCloud size={36} />{label}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ MediaPicker */

export type MediaPickerProps = {
  workspaceId: string;
  type: MediaType;
  title?: string;
  onPick: (asset: Asset) => void;
  onClose: () => void;
  allowUpload?: boolean;
};
const pickTitles: Record<MediaType, string> = { image: "Choose an image", video: "Choose a video", audio: "Choose a track" };

export function MediaPicker({ workspaceId, type, title, onPick, onClose, allowUpload = true }: MediaPickerProps) {
  const { data, loading, error, reload, setData } = useApi<{ assets: Asset[] }>(`/media?workspace=${encodeURIComponent(workspaceId)}&type=${type}&source=library&limit=200`);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const audio = usePreviewAudio();
  const close = useStableCallback(onClose);
  const uploads = useUploads(workspaceId, {
    only: type,
    onDone: (asset) => {
      if (asset.status !== "ready") return;
      setData((d) => ({ ...d, assets: [asset, ...(d?.assets || []).filter((a) => a.id !== asset.id)] }));
      setSelected(asset.id);
    },
  });
  const ready = (data?.assets || []).filter((a) => a.status === "ready");
  const q = query.trim().toLowerCase();
  const shown = q ? ready.filter((a) => a.name.toLowerCase().includes(q)) : ready;
  const chosen = ready.find((a) => a.id === selected) || null;
  const pick = (asset: Asset) => { audio.stop(); onPick(asset); };
  const visibleUploads = uploads.items.filter((u) => u.status !== "ready");
  const word = type === "audio" ? "track" : type;
  return (
    <Modal title={title || pickTitles[type]} onClose={close} wide footer={
      <>
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={!chosen} onClick={() => chosen && pick(chosen)}>
          <Check size={16} aria-hidden="true" />Use this {word}
        </button>
      </>
    }>
      <div className="pick-toolbar">
        {ready.length > 8 && (
          <label className="search">
            <Search size={16} aria-hidden="true" />
            <span className="sr-only">Search by name</span>
            <input className="input" type="search" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}
        {allowUpload && (
          <FileButton accept={ACCEPT[type]} label={`Upload ${word === "track" ? "a track" : word === "image" ? "an image" : "a video"}`} className="btn" onFiles={(files) => uploads.add(files.slice(0, 1))} disabled={uploads.busy} />
        )}
      </div>
      {visibleUploads.length > 0 && <div style={{ marginBottom: 14 }}><UploadList items={visibleUploads} onDismiss={uploads.dismiss} /></div>}
      {loading ? (
        <GridSkeleton count={8} tall={type === "video"} className="pick-grid" />
      ) : error ? (
        <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
      ) : !ready.length ? (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">{type === "audio" ? <Music size={24} /> : <UploadCloud size={24} />}</span>
          <h3>No {word}s in your library yet</h3>
          <p>{allowUpload ? `Upload ${word === "image" ? "an image" : word === "video" ? "a video" : "a track"} and it's ready to use here.` : "Add some in your Library first."}</p>
        </div>
      ) : !shown.length ? (
        <p className="muted center">Nothing matches “{query}”.</p>
      ) : type === "audio" ? (
        <ul className="pick-rows list-plain">
          {shown.map((a) => (
            <li key={a.id} className={`pick-row${a.id === selected ? " selected" : ""}`}>
              <PlayButton playing={audio.playing === a.id} onClick={() => audio.toggle(a.id, a.url)} label={a.name} />
              <button type="button" className="choose" aria-pressed={a.id === selected} onClick={() => setSelected(a.id)} onDoubleClick={() => pick(a)}>
                <span className="grow">
                  <span className="name" style={{ display: "block" }}>{a.name}</span>
                  <span className="small muted">{seconds(a.duration)} · {formatBytes(a.bytes)}</span>
                </span>
                {a.id === selected && <Check size={18} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="pick-grid">
          {shown.map((a) => <PickTile key={a.id} asset={a} selected={a.id === selected} onSelect={() => setSelected(a.id)} onPick={() => pick(a)} />)}
        </div>
      )}
    </Modal>
  );
}
function PickTile({ asset, selected, onSelect, onPick }: { asset: Asset; selected: boolean; onSelect: () => void; onPick: () => void }) {
  const { videoRef, handlers } = useHoverPlay();
  const video = asset.mime.startsWith("video/");
  return (
    <button type="button" className={`pick-item${video ? " tall" : ""}`} aria-pressed={selected} onClick={onSelect} onDoubleClick={onPick} {...(video ? handlers : {})}
      aria-label={`${asset.name}${video ? `, ${seconds(asset.duration)}` : ""}`}>
      {video
        ? <video ref={videoRef} src={firstFrame(asset.url)} muted loop playsInline preload="metadata" aria-hidden="true" />
        : <img src={asset.url} alt="" loading="lazy" decoding="async" />}
      {video && <span className="chip dark pick-duration">{seconds(asset.duration)}</span>}
      {selected && <span className="pick-check" aria-hidden="true"><Check size={15} /></span>}
      <span className="pick-name" aria-hidden="true">{asset.name}</span>
    </button>
  );
}

/* ------------------------------------------------------------------------------------------------ LibraryPicker */

export type LibraryPickerProps = { kind: "clip" | "greenscreen" | "music"; title?: string; onPick: (item: LibraryItem) => void; onClose: () => void };
const libraryTitles = { clip: "Choose a clip", greenscreen: "Choose a green-screen creator", music: "Choose music" } as const;
const PAGE = 12;

export function LibraryPicker({ kind, title, onPick, onClose }: LibraryPickerProps) {
  const { data, loading, error, reload } = useApi<{ items: LibraryItem[]; tags: string[] }>(`/library?kind=${kind}`);
  const [tags, setTags] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const audio = usePreviewAudio();
  const close = useStableCallback(onClose);
  const all = data?.items || [];
  const items = all.filter((i) => tags.every((t) => i.tags.some((x) => x.toLowerCase() === t.toLowerCase())));
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = items.slice(current * PAGE, current * PAGE + PAGE);
  const chosen = all.find((i) => i.id === selected) || null;
  const toggleTag = (t: string) => {
    setTags((list) => (list.includes(t) ? list.filter((x) => x !== t) : [...list, t]));
    setPage(0);
  };
  const pick = (item: LibraryItem) => { audio.stop(); onPick(item); };
  const music = kind === "music";
  return (
    <Modal title={title || libraryTitles[kind]} onClose={close} wide footer={
      <>
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="button" className="btn primary" disabled={!chosen} onClick={() => chosen && pick(chosen)}>
          <Check size={16} aria-hidden="true" />{music ? "Use this track" : "Use this clip"}
        </button>
      </>
    }>
      {!!data?.tags.length && (
        <div className="tag-filter" role="group" aria-label="Filter by tag">
          <button type="button" className="chip button" aria-pressed={!tags.length} onClick={() => { setTags([]); setPage(0); }}>All</button>
          {data.tags.map((t) => (
            <button key={t} type="button" className="chip button tag-chip" aria-pressed={tags.includes(t)} onClick={() => toggleTag(t)}>{t}</button>
          ))}
        </div>
      )}
      {loading ? (
        music ? <div className="stack">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 58 }} />)}</div>
          : <GridSkeleton count={8} tall className="pick-grid" />
      ) : error ? (
        <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
      ) : !all.length ? (
        <div className="empty">
          <span className="empty-icon" aria-hidden="true">{music ? <Music size={24} /> : <UploadCloud size={24} />}</span>
          <h3>The library is empty for now</h3>
          <p>We're adding {music ? "tracks" : "clips"} soon. You can use your own uploads meanwhile.</p>
        </div>
      ) : !items.length ? (
        <div className="empty">
          <h3>Nothing has all of these tags</h3>
          <button type="button" className="btn" onClick={() => setTags([])}>Clear filters</button>
        </div>
      ) : music ? (
        <ul className="pick-rows list-plain">
          {shown.map((t) => (
            <li key={t.id} className={`pick-row${t.id === selected ? " selected" : ""}`}>
              <PlayButton playing={audio.playing === t.id} onClick={() => audio.toggle(t.id, t.url)} label={t.name} />
              <button type="button" className="choose" aria-pressed={t.id === selected} onClick={() => setSelected(t.id)} onDoubleClick={() => pick(t)}>
                <span className="grow">
                  <span className="name" style={{ display: "block" }}>{t.name}</span>
                  <span className="small muted">{seconds(t.duration)}{t.tags.length ? ` · ${t.tags.join(", ")}` : ""}</span>
                </span>
                {t.id === selected && <Check size={18} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="pick-grid">
          {shown.map((c) => <ClipTile key={c.id} item={c} selected={c.id === selected} onSelect={() => setSelected(c.id)} onPick={() => pick(c)} />)}
        </div>
      )}
      {pages > 1 && (
        <nav className="pager" aria-label="Pages">
          <button type="button" className="btn sm" onClick={() => setPage(current - 1)} disabled={current === 0} aria-label="Previous page"><ChevronLeft size={16} /></button>
          <span aria-live="polite">Page {current + 1} of {pages}</span>
          <button type="button" className="btn sm" onClick={() => setPage(current + 1)} disabled={current >= pages - 1} aria-label="Next page"><ChevronRight size={16} /></button>
        </nav>
      )}
    </Modal>
  );
}
function ClipTile({ item, selected, onSelect, onPick }: { item: LibraryItem; selected: boolean; onSelect: () => void; onPick: () => void }) {
  const { videoRef, handlers } = useHoverPlay();
  return (
    <button type="button" className="pick-item tall" aria-pressed={selected} onClick={onSelect} onDoubleClick={onPick} {...handlers}
      aria-label={`${item.name}, ${seconds(item.duration)}${item.tags.length ? `, ${item.tags.join(", ")}` : ""}`}>
      <video ref={videoRef} src={item.thumb ? item.url : firstFrame(item.url)} poster={item.thumb || undefined} muted loop playsInline preload={item.thumb ? "none" : "metadata"} aria-hidden="true" />
      <span className="chip dark pick-duration">{seconds(item.duration)}</span>
      {selected && <span className="pick-check" aria-hidden="true"><Check size={15} /></span>}
      <span className="pick-name" aria-hidden="true">{item.name}</span>
    </button>
  );
}
