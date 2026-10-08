import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, Film, HardDrive, Image as ImageIcon, Music, Pencil, Search, Sparkles, Trash2, Upload as UploadIcon } from "lucide-react";
import { Modal, Spinner, useToast } from "../ui";
import { bytes, del, errorText, patch, seconds, useApi, usePoll, type Asset } from "../lib";
import { useCurrentWorkspace } from "./workspace";
import {
  ACCEPT, ConfirmDialog, DropZone, Empty, FileButton, GridSkeleton, Tabs, UploadList, assetKindLabel, firstFrame, formatDate, tabPanel,
  useHoverPlay, useStableCallback, useUploads, type MediaType,
} from "./pickers";
import "./pages.css";

type MediaList = { assets: Asset[]; storage: { used: number; max: number } };
const tabs: { id: MediaType; label: string; one: string; many: string }[] = [
  { id: "image", label: "Images", one: "image", many: "images" },
  { id: "video", label: "Videos", one: "video", many: "videos" },
  { id: "audio", label: "Audio", one: "track", many: "tracks" },
];
const isType = (v: string | null): v is MediaType => v === "image" || v === "video" || v === "audio";

/** The workspace's media: uploads, website images and AI images, by type, with upload, rename, download and delete. */
export function LibraryPage() {
  const workspace = useCurrentWorkspace();
  const [params, setParams] = useSearchParams();
  const requested = params.get("type");
  const tab: MediaType = isType(requested) ? requested : "image";
  const { data, loading, error, reload, setData } = useApi<MediaList>(`/media?workspace=${workspace.id}&type=${tab}&source=library&limit=200`);
  const uploads = useUploads(workspace.id, { onDone: () => void reload() });
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<Asset | null>(null);
  const [deleting, setDeleting] = useState<Asset | null>(null);
  const [viewing, setViewing] = useState<Asset | null>(null);
  const checking = !!data?.assets.some((a) => a.status === "checking");
  usePoll(reload, 4000, checking);
  const setTab = (t: MediaType) => {
    setQuery("");
    setParams(t === "image" ? {} : { type: t }, { replace: true });
  };
  const current = tabs.find((t) => t.id === tab) || tabs[0];
  const assets = data?.assets || [];
  const q = query.trim().toLowerCase();
  const shown = q ? assets.filter((a) => a.name.toLowerCase().includes(q)) : assets;
  const storage = data?.storage;
  const share = storage && storage.max ? Math.min(1, storage.used / storage.max) : 0;
  const replace = (asset: Asset) => setData((d) => (d ? { ...d, assets: d.assets.map((a) => (a.id === asset.id ? asset : a)) } : d));
  const remove = async (asset: Asset) => {
    await del(`/media/${asset.id}`);
    setData((d) => (d ? { ...d, assets: d.assets.filter((a) => a.id !== asset.id) } : d));
    void reload();
  };
  const finished = uploads.items.some((u) => u.status === "ready" || u.status === "failed");
  const upload = (
    <FileButton accept={ACCEPT.any} multiple label="Upload files" className="btn primary" onFiles={uploads.add} icon={<UploadIcon size={16} aria-hidden="true" />} />
  );

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p>Photos, videos and tracks for {workspace.name}. Everything here can go into any post.</p>
        </div>
        <div className="toolbar">
          {storage && (
            <div className="storage" title="Storage used by all your files">
              <span><HardDrive size={14} aria-hidden="true" style={{ verticalAlign: -2 }} /> <strong>{bytes(storage.used)}</strong>{storage.max ? ` of ${bytes(storage.max)} used` : " used"}</span>
              {!!storage.max && (
                <div className={`meter thin${share > 0.95 ? " bad" : share > 0.8 ? " warn" : ""}`} role="progressbar" aria-label="Storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
                  <span style={{ width: `${Math.max(2, share * 100)}%` }} />
                </div>
              )}
            </div>
          )}
          {upload}
        </div>
      </div>

      {storage && storage.max > 0 && share > 0.95 && (
        <div className="notice bad" style={{ marginBottom: 16 }}>
          Your storage is almost full. Delete files you no longer need, or <Link to="/app/billing" className="link">upgrade for more space</Link>.
        </div>
      )}

      <DropZone onFiles={uploads.add}>
        <div className="row between wrap" style={{ marginBottom: 16 }}>
          <Tabs label="File type" idBase="library" value={tab} onChange={setTab} items={tabs.map((t) => ({ id: t.id, label: t.label }))} />
          {assets.length > 6 && (
            <label className="search" style={{ width: "min(280px, 100%)" }}>
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">Search {current.many} by name</span>
              <input className="input" type="search" placeholder={`Search ${current.many}`} value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
        </div>

        {uploads.items.length > 0 && (
          <div className="stack" style={{ marginBottom: 18 }}>
            <UploadList
              items={uploads.items} onDismiss={uploads.dismiss}
              action={(u) => u.status === "ready" && u.type && u.type !== tab
                ? <button type="button" className="btn sm" onClick={() => setTab(u.type as MediaType)}>Show in {tabs.find((t) => t.id === u.type)?.label}</button>
                : null}
            />
            {finished && <div><button type="button" className="btn sm ghost" onClick={uploads.clearFinished}>Clear finished uploads</button></div>}
          </div>
        )}

        <div {...tabPanel("library", tab)}>
          {loading ? (
            tab === "audio"
              ? <div className="audio-list" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton" style={{ height: 70 }} />)}</div>
              : <GridSkeleton count={10} tall={tab === "video"} />
          ) : error ? (
            <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
          ) : !assets.length ? (
            <Empty
              icon={tab === "image" ? <ImageIcon size={24} /> : tab === "video" ? <Film size={24} /> : <Music size={24} />}
              title={`No ${current.many} yet`}
              action={
                <div className="row wrap" style={{ justifyContent: "center" }}>
                  {upload}
                  {tab === "image" && <Link to="/app/studio" className="btn"><Sparkles size={16} aria-hidden="true" />Make one with AI</Link>}
                </div>
              }
            >
              {tab === "image" && "Upload product photos, screenshots and logos, or drop them anywhere on this page. JPG, PNG or WebP up to 20 MB."}
              {tab === "video" && "Upload product demos and screen recordings for hook & demo posts. MP4, MOV or WebM up to 500 MB."}
              {tab === "audio" && "Upload your own music or voice-overs. MP3, WAV, M4A or OGG up to 50 MB."}
            </Empty>
          ) : !shown.length ? (
            <p className="muted center" style={{ padding: 30 }}>No {current.many} match “{query}”.</p>
          ) : tab === "audio" ? (
            <ul className="audio-list list-plain">
              {shown.map((a) => <AudioRow key={a.id} asset={a} onRename={() => setRenaming(a)} onDelete={() => setDeleting(a)} />)}
            </ul>
          ) : (
            <ul className="lib-grid list-plain">
              {shown.map((a) => (
                <MediaCard key={a.id} asset={a} onOpen={() => setViewing(a)} onRename={() => setRenaming(a)} onDelete={() => setDeleting(a)} />
              ))}
            </ul>
          )}
          {!loading && !error && assets.length > 0 && (
            <p className="hint center" style={{ marginTop: 18 }}>Tip: drop files anywhere on this page to upload them.</p>
          )}
        </div>
      </DropZone>

      {renaming && <RenameModal asset={renaming} onClose={() => setRenaming(null)} onSaved={(a) => { replace(a); setRenaming(null); }} />}
      {deleting && (
        <ConfirmDialog title={`Delete this ${current.one}?`} onConfirm={() => remove(deleting)} onClose={() => setDeleting(null)}>
          <p><strong>{deleting.name}</strong> is removed from your library. Posts already made with it keep their video.</p>
        </ConfirmDialog>
      )}
      {viewing && <ImageViewer asset={viewing} onClose={() => setViewing(null)} />}
    </main>
  );
}

function Actions({ asset, onRename, onDelete }: { asset: Asset; onRename: () => void; onDelete: () => void }) {
  return (
    <div className="icon-actions">
      <button type="button" className="btn icon ghost" onClick={onRename} aria-label={`Rename ${asset.name}`} title="Rename"><Pencil size={16} /></button>
      {asset.status === "ready" && (
        <a className="btn icon ghost" href={`${asset.url}?download=1`} download aria-label={`Download ${asset.name}`} title="Download"><Download size={16} /></a>
      )}
      <button type="button" className="btn icon ghost danger" onClick={onDelete} aria-label={`Delete ${asset.name}`} title="Delete"><Trash2 size={16} /></button>
    </div>
  );
}

function MediaCard({ asset, onOpen, onRename, onDelete }: { asset: Asset; onOpen: () => void; onRename: () => void; onDelete: () => void }) {
  const { videoRef, handlers } = useHoverPlay();
  const video = asset.mime.startsWith("video/");
  const meta = video
    ? [seconds(asset.duration), asset.hasAudio === false ? "No sound" : null, bytes(asset.bytes)]
    : [asset.width && asset.height ? `${asset.width} × ${asset.height}` : null, bytes(asset.bytes)];
  return (
    <li className={`lib-card${video ? " tall" : ""}`} {...(video ? handlers : {})}>
      <div className="lib-media">
        {asset.status === "ready" ? (
          video ? (
            <video ref={videoRef} src={firstFrame(asset.url)} muted loop playsInline preload="metadata" aria-label={`Preview of ${asset.name}`} />
          ) : (
            <>
              <img src={asset.url} alt={asset.name} loading="lazy" decoding="async" />
              <button type="button" className="open" onClick={onOpen} aria-label={`View ${asset.name}`} />
            </>
          )
        ) : asset.status === "failed" ? (
          <div className="lib-state bad" role="note">{asset.error || "This file can't be used."}</div>
        ) : (
          <div className="lib-state"><Spinner label="Checking" />Checking the file…</div>
        )}
        {asset.kind !== "upload" && asset.status === "ready" && (
          <div className="badge-row"><span className="chip dark">{asset.kind === "ai_image" || asset.kind === "ai_clip" ? <Sparkles size={12} aria-hidden="true" /> : null}{assetKindLabel(asset.kind)}</span></div>
        )}
      </div>
      <div className="lib-card-body">
        <div className="lib-card-name" title={asset.name}>{asset.name}</div>
        <div className="lib-card-meta">{meta.filter(Boolean).join(" · ")}</div>
      </div>
      <div className="lib-card-actions">
        <span className="small muted" style={{ paddingLeft: 4 }}>{formatDate(asset.createdAt)}</span>
        <span className="push"><Actions asset={asset} onRename={onRename} onDelete={onDelete} /></span>
      </div>
    </li>
  );
}

function AudioRow({ asset, onRename, onDelete }: { asset: Asset; onRename: () => void; onDelete: () => void }) {
  return (
    <li className="audio-row">
      <span className="audio-icon" aria-hidden="true"><Music size={20} /></span>
      <div style={{ minWidth: 0 }}>
        <div className="name" title={asset.name}>{asset.name}</div>
        <div className="small muted">{[asset.status === "ready" ? seconds(asset.duration) : null, bytes(asset.bytes), formatDate(asset.createdAt)].filter(Boolean).join(" · ")}</div>
      </div>
      {asset.status === "ready" ? (
        <audio controls preload="none" src={asset.url} aria-label={`Play ${asset.name}`} />
      ) : asset.status === "failed" ? (
        <span className="audio-state small error">{asset.error || "This file can't be used."}</span>
      ) : (
        <span className="audio-state small muted row"><Spinner label="Checking" />Checking the file…</span>
      )}
      <Actions asset={asset} onRename={onRename} onDelete={onDelete} />
    </li>
  );
}

function RenameModal({ asset, onClose, onSaved }: { asset: Asset; onClose: () => void; onSaved: (a: Asset) => void }) {
  const [name, setName] = useState(asset.name);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const close = useStableCallback(onClose);
  const input = useRef<HTMLInputElement>(null);
  // After the modal focuses itself: start in the name, selected.
  useEffect(() => { input.current?.select(); }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    try {
      await patch(`/media/${asset.id}`, { name: value });
      toast("Renamed.", "good");
      onSaved({ ...asset, name: value });
    } catch (err) {
      toast(errorText(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title="Rename file" onClose={close}>
      <form className="stack" onSubmit={save}>
        <label className="field">
          <span>Name</span>
          <input ref={input} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} required />
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy && <Spinner label="Saving" />}Save</button>
        </div>
      </form>
    </Modal>
  );
}

function ImageViewer({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const close = useStableCallback(onClose);
  return (
    <Modal title={asset.name} onClose={close} wide>
      <div className="lightbox">
        <img src={asset.url} alt={asset.name} />
        <div className="row wrap" style={{ justifyContent: "center" }}>
          <span className="small muted">{asset.width} × {asset.height} · {bytes(asset.bytes)} · {assetKindLabel(asset.kind)}</span>
          <a className="btn sm" href={`${asset.url}?download=1`} download><Download size={14} aria-hidden="true" />Download</a>
        </div>
      </div>
    </Modal>
  );
}
