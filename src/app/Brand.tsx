import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileText, Globe, ImagePlus, Images, Palette, RefreshCw, Save, Trash2, Undo2, X } from "lucide-react";
import { Spinner, useToast } from "../ui";
import { del, errorText, fileUrl, patch, post, useApi, usePoll, type Workspace } from "../lib";
import { businessCategories, businessCategoryNames, emptyProfile, profileSchema, type Profile } from "../../shared/profile";
import { useCurrentWorkspace, useWorkspace } from "./workspace";
import { ConfirmDialog, Empty, MediaPicker, UploadButton, assetKindLabel, formatDate } from "./pickers";
import "./pages.css";

type BrandImage = { id: string; kind: string; name: string; width: number; height: number };
type Loaded = { workspace: Workspace & { images?: BrandImage[] } };
type Draft = { profile: Profile; watermark: string };
type ListKey = "valueProps" | "painPoints" | "features" | "keywords";
type TextKey = "name" | "product" | "description" | "category" | "audience" | "tone" | "cta" | "notes";

function toDraft(w: Workspace): Draft {
  const parsed = profileSchema.safeParse(w.profile ?? {});
  return { profile: parsed.success ? parsed.data : { ...emptyProfile(), ...w.profile }, watermark: w.settings?.watermark || "" };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const labels: Record<keyof Profile, string> = {
  name: "Brand name", product: "What it is", description: "Description", category: "Category", audience: "Audience", valueProps: "Value propositions",
  painPoints: "Pain points", features: "Features", tone: "Tone of voice", cta: "Call to action", keywords: "Keywords", language: "Language",
  colors: "Colours", businessModel: "Business model", categories: "Business type", notes: "Notes",
};
const languages: [string, string][] = [
  ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["pt-BR", "Portuguese (Brazil)"],
  ["nl", "Dutch"], ["pl", "Polish"], ["sv", "Swedish"], ["da", "Danish"], ["nb", "Norwegian"], ["fi", "Finnish"], ["cs", "Czech"], ["ro", "Romanian"],
  ["hu", "Hungarian"], ["el", "Greek"], ["tr", "Turkish"], ["ru", "Russian"], ["uk", "Ukrainian"], ["ar", "Arabic"], ["he", "Hebrew"], ["hi", "Hindi"],
  ["id", "Indonesian"], ["ms", "Malay"], ["th", "Thai"], ["vi", "Vietnamese"], ["ja", "Japanese"], ["ko", "Korean"], ["zh", "Chinese"],
];
const models: { id: Profile["businessModel"]; label: string }[] = [{ id: "b2b", label: "B2B" }, { id: "b2c", label: "B2C" }, { id: "both", label: "Both" }];
const scanSteps = [{ id: "website", label: "Website" }, { id: "profile", label: "Profile" }, { id: "images", label: "Images" }];
const HEX = /^#[0-9a-f]{6}$/i;

/** The workspace's brand: the profile every post is written from, logo, colours, website analysis and brand images. */
export function BrandPage() {
  const workspace = useCurrentWorkspace();
  // A fresh editor per workspace, so switching brands never carries edits over.
  return <BrandEditor key={workspace.id} workspaceId={workspace.id} />;
}

function BrandEditor({ workspaceId }: { workspaceId: string }) {
  const { update } = useWorkspace();
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<Loaded>(`/workspaces/${workspaceId}`);
  const w = data?.workspace ?? null;
  const saved = useMemo(() => (w ? toDraft(w) : null), [w]);
  /** Unsaved edits; null follows the stored brand. */
  const [edits, setEdits] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [pickingLogo, setPickingLogo] = useState(false);
  const [deleting, setDeleting] = useState<BrandImage | null>(null);

  // When the stored brand changes (after an analysis), edits that match the old one are dropped so it shows the new one.
  const lastSaved = useRef<Draft | null>(null);
  useEffect(() => {
    if (!saved) return;
    const previous = lastSaved.current;
    lastSaved.current = saved;
    if (previous) setEdits((d) => (d && same(d, previous) ? null : d));
  }, [saved]);
  const draft = edits ?? saved;
  const dirty = !!edits && !!saved && !same(edits, saved);
  const edit = (change: (d: Draft) => Draft) => setEdits((d) => {
    const base = d ?? saved;
    return base ? change(base) : d;
  });
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const scanning = w?.scan.status === "scanning";
  usePoll(reload, 3000, scanning);
  const lastStatus = useRef<string | null>(null);
  useEffect(() => {
    if (!w) return;
    const before = lastStatus.current;
    lastStatus.current = w.scan.status;
    if (before !== "scanning" || w.scan.status === "scanning") return;
    const { images: _images, ...rest } = w;
    update(rest);
    if (w.scan.status === "ready") toast("Your brand profile is updated from the analysis.", "good");
    else toast(w.scan.error || "The analysis didn't finish. Try again, or fill in your brand by hand.", "bad");
  }, [w, update, toast]);

  /** Stores a workspace the server sent back (it has no images list) here and in the sidebar. */
  const apply = (ws: Workspace) => {
    setData((d) => ({ workspace: { ...ws, images: d?.workspace.images || [] } }));
    update(ws);
  };
  const setProfile = <K extends keyof Profile>(key: K, value: Profile[K]) => edit((d) => ({ ...d, profile: { ...d.profile, [key]: value } }));

  const save = async () => {
    if (!draft || !saved || saving) return;
    const parsed = profileSchema.safeParse(draft.profile);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const label = labels[issue.path[0] as keyof Profile] || "the form";
      toast(`${label} ${issue.code === "too_big" ? "is too long" : issue.code === "invalid_format" ? "isn't in the right format" : "needs a look"}.`, "bad");
      return;
    }
    const changes: Partial<Record<keyof Profile, unknown>> = {};
    for (const key of Object.keys(parsed.data) as (keyof Profile)[]) if (!same(parsed.data[key], saved.profile[key])) changes[key] = parsed.data[key];
    const body: Record<string, unknown> = {};
    if (Object.keys(changes).length) body.profile = changes;
    if (draft.watermark.trim() !== saved.watermark) body.settings = { watermark: draft.watermark.trim() };
    if (!Object.keys(body).length) { setEdits(null); return; }
    setSaving(true);
    try {
      const { workspace } = await patch<{ workspace: Workspace }>(`/workspaces/${workspaceId}`, body);
      apply(workspace);
      setEdits(null);
      toast("Brand saved. New posts use it from now on.", "good");
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setSaving(false);
    }
  };
  const setLogo = async (id: string | null) => {
    setLogoBusy(true);
    try {
      const { workspace } = await patch<{ workspace: Workspace }>(`/workspaces/${workspaceId}`, { logoAssetId: id });
      apply(workspace);
      toast(id ? "Logo updated." : "Logo removed.", "good");
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setLogoBusy(false);
    }
  };
  const removeImage = async (img: BrandImage) => {
    await del(`/media/${img.id}`);
    setData((d) => d && { workspace: { ...d.workspace, images: (d.workspace.images || []).filter((i) => i.id !== img.id), logoAssetId: d.workspace.logoAssetId === img.id ? null : d.workspace.logoAssetId } });
    if (w?.logoAssetId === img.id) {
      const { images: _images, ...rest } = w;
      update({ ...rest, logoAssetId: null });
    }
    toast("Image deleted.", "good");
  };

  if (loading || (!error && !w)) {
    return (
      <main className="page" aria-busy="true">
        <div className="page-head"><div><h1>Brand</h1><p>Loading your brand…</p></div></div>
        <div className="brand-layout">
          <div className="stack">{[280, 220, 200].map((h) => <div key={h} className="skeleton" style={{ height: h }} />)}</div>
          <div className="stack">{[220, 180].map((h) => <div key={h} className="skeleton" style={{ height: h }} />)}</div>
        </div>
      </main>
    );
  }
  if (error || !w || !draft || !saved) {
    return (
      <main className="page">
        <div className="page-head"><div><h1>Brand</h1></div></div>
        <div className="notice bad" role="alert">{error || "This workspace couldn't be loaded."} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
      </main>
    );
  }

  const p = draft.profile;
  const text = (key: TextKey, label: string, max: number, options: { area?: boolean; rows?: number; hint?: ReactNode; placeholder?: string; full?: boolean } = {}) => {
    const id = `brand-${key}`;
    const value = p[key];
    return (
      <div className={`field${options.full ? " full" : ""}`}>
        <label className="label" htmlFor={id}>{label}{(options.area || max > 200) && <span className="counter">{value.length}/{max}</span>}</label>
        {options.area
          ? <textarea id={id} className="textarea" rows={options.rows || 3} maxLength={max} value={value} placeholder={options.placeholder} onChange={(e) => setProfile(key, e.target.value)} aria-describedby={options.hint ? `${id}-hint` : undefined} />
          : <input id={id} className="input" maxLength={max} value={value} placeholder={options.placeholder} onChange={(e) => setProfile(key, e.target.value)} aria-describedby={options.hint ? `${id}-hint` : undefined} />}
        {options.hint && <span id={`${id}-hint`} className="hint">{options.hint}</span>}
      </div>
    );
  };
  const list = (key: ListKey, label: string, max: number, placeholder: string, maxLength = 160) => (
    <TagList id={`brand-${key}`} label={label} values={p[key]} max={max} maxLength={maxLength} placeholder={placeholder} onChange={(v) => setProfile(key, v)} />
  );
  const languageKnown = languages.some(([code]) => code === p.language);
  const images = w.images || [];

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Brand</h1>
          <p>What we know about {w.name}. Every idea, script and caption is written from this.</p>
        </div>
        <div className="toolbar">
          {dirty && <span className="chip orange" role="status">Unsaved changes</span>}
          {dirty && <button type="button" className="btn" onClick={() => setEdits(null)} disabled={saving}><Undo2 size={16} aria-hidden="true" />Discard</button>}
          <button type="button" className="btn primary" onClick={save} disabled={!dirty || saving || scanning}>
            {saving ? <Spinner label="Saving" /> : <Save size={16} aria-hidden="true" />}Save changes
          </button>
        </div>
      </div>

      {scanning && (
        <div className="notice" role="status" style={{ marginBottom: 16 }}>
          <div className="row"><Spinner label="Analyzing" /><strong>Analyzing your brand…</strong> The profile updates by itself when it's done; editing is paused until then.</div>
          <ScanSteps step={w.scan.step} />
        </div>
      )}

      <div className="brand-layout">
        <fieldset className="brand-fieldset brand-main" disabled={scanning || saving}>
          <legend className="sr-only">Brand profile</legend>
          <section className="card" aria-labelledby="brand-basics">
            <div className="card-head"><div><h2 id="brand-basics">Basics</h2><p>Who you are, in your own words.</p></div></div>
            <div className="form-grid">
              {text("name", "Brand name", 80, { hint: "As it should appear in posts." })}
              {text("category", "Category", 80, { placeholder: "e.g. Fitness app" })}
              {text("product", "What it is", 200, { full: true, placeholder: "One line, e.g. A budgeting app that splits bills with friends" })}
              {text("description", "Description", 1200, { area: true, rows: 5, full: true })}
              {text("audience", "Audience", 400, { area: true, rows: 3, full: true, placeholder: "Who buys it and why, e.g. Students sharing a flat who hate chasing money" })}
            </div>
          </section>

          <section className="card" aria-labelledby="brand-offer">
            <div className="card-head"><div><h2 id="brand-offer">What you offer</h2><p>The hooks and scripts lean on these. Press Enter after each one.</p></div></div>
            <div className="stack" style={{ gap: 16 }}>
              {list("valueProps", "Value propositions", 6, "e.g. Split any bill in two taps")}
              {list("painPoints", "Pain points you solve", 6, "e.g. Awkward money talks with friends")}
              {list("features", "Features", 8, "e.g. Shared expense groups")}
              {list("keywords", "Keywords", 12, "e.g. budgeting", 40)}
            </div>
          </section>

          <section className="card" aria-labelledby="brand-voice">
            <div className="card-head"><div><h2 id="brand-voice">Voice</h2><p>How your posts sound and what they ask people to do.</p></div></div>
            <div className="form-grid">
              {text("tone", "Tone of voice", 160, { placeholder: "e.g. Playful, direct, a little cheeky" })}
              {text("cta", "Call to action", 160, { placeholder: "e.g. Download it free on the App Store" })}
              <div className="field">
                <label className="label" htmlFor="brand-language">Language of your posts</label>
                <select id="brand-language" className="select" value={p.language} onChange={(e) => setProfile("language", e.target.value)}>
                  {!languageKnown && <option value={p.language}>{p.language}</option>}
                  {languages.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </select>
              </div>
              {text("notes", "Notes for the writer", 1000, { area: true, rows: 4, full: true, hint: "Claims to avoid, words to use, anything we should always follow.", placeholder: "e.g. Never promise results in days. Say “members”, not “users”." })}
            </div>
          </section>

          <section className="card" aria-labelledby="brand-business">
            <div className="card-head"><div><h2 id="brand-business">Business</h2><p>Helps us pick formats and angles that fit.</p></div></div>
            <div className="stack" style={{ gap: 18 }}>
              <div className="field">
                <span id="brand-model-label">Who you sell to</span>
                <div className="pill-row" role="group" aria-labelledby="brand-model-label">
                  {models.map((m) => (
                    <button key={m.id} type="button" className="pill sm" aria-pressed={p.businessModel === m.id} onClick={() => setProfile("businessModel", p.businessModel === m.id ? "" : m.id)}>{m.label}</button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span id="brand-categories-label">Type of business <span className="counter">Choose all that fit</span></span>
                <div className="pill-row" role="group" aria-labelledby="brand-categories-label">
                  {businessCategories.map((c) => {
                    const on = p.categories.includes(c);
                    return (
                      <button key={c} type="button" className="pill sm" aria-pressed={on}
                        onClick={() => setProfile("categories", on ? p.categories.filter((x) => x !== c) : [...p.categories, c])}>{businessCategoryNames[c]}</button>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>
        </fieldset>

        <div className="brand-side">
          <AnalyzeCard workspace={w} dirty={dirty} onStarted={apply} />

          <section className="card stack" aria-labelledby="brand-look">
            <h2 id="brand-look"><Palette size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />Logo & colours</h2>
            <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
              <div className="logo-box">
                {w.logoAssetId ? <img src={fileUrl(w.logoAssetId)} alt={`${w.name} logo`} /> : <span aria-hidden="true">{w.name.slice(0, 1).toUpperCase()}</span>}
              </div>
              <div className="stack" style={{ gap: 8 }}>
                <UploadButton workspaceId={workspaceId} type="image" label={w.logoAssetId ? "Upload a new logo" : "Upload logo"} className="btn sm" disabled={logoBusy} onUploaded={(a) => void setLogo(a.id)} />
                <button type="button" className="btn sm" onClick={() => setPickingLogo(true)} disabled={logoBusy}><Images size={14} aria-hidden="true" />Choose from Library</button>
                {w.logoAssetId && <button type="button" className="btn sm ghost danger" onClick={() => void setLogo(null)} disabled={logoBusy}>{logoBusy ? <Spinner label="Working" /> : <X size={14} aria-hidden="true" />}Remove logo</button>}
              </div>
            </div>
            <fieldset className="brand-fieldset" disabled={scanning || saving} style={{ gap: 12 }}>
              <legend className="sr-only">Brand colours</legend>
              <ColorField id="brand-primary" label="Primary colour" value={p.colors.primary} onChange={(v) => setProfile("colors", { ...p.colors, primary: v })} />
              <ColorField id="brand-accent" label="Accent colour" value={p.colors.accent} onChange={(v) => setProfile("colors", { ...p.colors, accent: v })} />
              <span className="hint">Used for text highlights and backgrounds in your posts.</span>
            </fieldset>
          </section>

          <section className="card stack" aria-labelledby="brand-watermark">
            <h2 id="brand-watermark">Watermark</h2>
            <div className="field">
              <label className="label" htmlFor="brand-watermark-input">Text in the corner of every video <span className="counter">{draft.watermark.length}/40</span></label>
              <input id="brand-watermark-input" className="input" maxLength={40} value={draft.watermark} placeholder="e.g. @yourbrand" disabled={scanning || saving}
                onChange={(e) => { const v = e.target.value; edit((d) => ({ ...d, watermark: v })); }} aria-describedby="brand-watermark-hint" />
              <span id="brand-watermark-hint" className="hint">Leave it empty for no watermark.</span>
            </div>
          </section>
        </div>
      </div>

      <section className="section" aria-labelledby="brand-images-title">
        <div className="section-head">
          <div>
            <h2 id="brand-images-title">Brand images</h2>
            <p>Product shots and pictures from your website. We use them in slideshows and backgrounds.</p>
          </div>
          <div className="toolbar">
            <Link to="/app/library" className="btn sm">Open Library</Link>
            <UploadButton workspaceId={workspaceId} type="image" multiple label="Upload images" className="btn sm primary" onUploaded={() => void reload()} />
          </div>
        </div>
        {!images.length ? (
          <Empty icon={<ImagePlus size={24} />} title="No brand images yet">
            Upload product photos or screenshots{w.website ? ", or re-analyze your website to collect its images" : ""}.
          </Empty>
        ) : (
          <ul className="brand-images list-plain">
            {images.map((img) => (
              <li key={img.id} className="lib-card">
                <div className="lib-media">
                  <img src={fileUrl(img.id)} alt={img.name} loading="lazy" decoding="async" />
                  <div className="badge-row">
                    <span className="chip dark">{assetKindLabel(img.kind)}</span>
                    {img.id === w.logoAssetId && <span className="chip dark">Logo</span>}
                  </div>
                </div>
                <div className="lib-card-body">
                  <div className="lib-card-name" title={img.name}>{img.name}</div>
                  <div className="lib-card-meta">{img.width} × {img.height}</div>
                </div>
                <div className="lib-card-actions">
                  <button type="button" className="btn icon ghost danger push" onClick={() => setDeleting(img)} aria-label={`Delete ${img.name}`} title="Delete"><Trash2 size={16} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {dirty && (
        <div className="savebar" role="region" aria-label="Unsaved changes">
          <span>You have unsaved changes.</span>
          <div className="row">
            <button type="button" className="btn sm" onClick={() => setEdits(null)} disabled={saving}>Discard</button>
            <button type="button" className="btn sm accent" onClick={save} disabled={saving || scanning}>{saving && <Spinner label="Saving" />}Save changes</button>
          </div>
        </div>
      )}

      {pickingLogo && (
        <MediaPicker workspaceId={workspaceId} type="image" title="Choose your logo" onClose={() => setPickingLogo(false)}
          onPick={(a) => { setPickingLogo(false); void setLogo(a.id); }} />
      )}
      {deleting && (
        <ConfirmDialog title="Delete this image?" onClose={() => setDeleting(null)} onConfirm={() => removeImage(deleting)}>
          <p><strong>{deleting.name}</strong> is removed from your brand images and Library.{deleting.id === w.logoAssetId ? " It's your logo, so the logo is removed too." : ""}</p>
        </ConfirmDialog>
      )}
    </main>
  );
}

function ScanSteps({ step }: { step: string | null }) {
  const at = Math.max(0, scanSteps.findIndex((s) => s.id === step));
  return (
    <div className="scan-steps" aria-label="Analysis progress">
      {scanSteps.map((s, i) => (
        <span key={s.id}><i className={i < at ? "done" : i === at ? "now" : ""} aria-hidden="true" />{s.label}<span className="sr-only">{i < at ? " done" : i === at ? " in progress" : " waiting"}</span></span>
      ))}
    </div>
  );
}

function AnalyzeCard({ workspace: w, dirty, onStarted }: { workspace: Workspace; dirty: boolean; onStarted: (w: Workspace) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<"website" | "description">(w.description && !w.website ? "description" : "website");
  const [website, setWebsite] = useState(w.website || "");
  const [description, setDescription] = useState(w.description || "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const scanning = w.scan.status === "scanning";
  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || scanning || dirty) return;
    setProblem(null);
    const body = mode === "website" ? { website: website.trim() } : { description: description.trim() };
    if (mode === "website" && !website.trim()) { setProblem("Paste your website or app store link."); return; }
    if (mode === "description" && description.trim().length < 20) { setProblem("Describe your business in a few sentences (at least 20 characters)."); return; }
    setBusy(true);
    try {
      const { workspace } = await post<{ workspace: Workspace }>(`/workspaces/${w.id}/analyze`, body);
      onStarted(workspace);
      toast("Analysis started. It usually takes a minute or two.", "good");
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="brand-analyze">
      <form className="stack" onSubmit={start}>
        <h2 id="brand-analyze">{mode === "website" ? <Globe size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} /> : <FileText size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />}Brand analysis</h2>
        {mode === "website" ? (
          <div className="field">
            <label className="label" htmlFor="brand-website">Website or app store link</label>
            <input id="brand-website" className="input" type="url" inputMode="url" placeholder="example.com" value={website} maxLength={300} onChange={(e) => setWebsite(e.target.value)} disabled={scanning || busy} aria-describedby="brand-website-hint" />
            <span id="brand-website-hint" className="hint">Have an app? Paste its App Store or Google Play link.</span>
          </div>
        ) : (
          <div className="field">
            <label className="label" htmlFor="brand-about">Describe your business <span className="counter">{description.trim().length}/4000</span></label>
            <textarea id="brand-about" className="textarea" rows={5} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} disabled={scanning || busy}
              placeholder="What you sell, who it's for and what makes it different." />
          </div>
        )}
        <button type="button" className="link small" style={{ alignSelf: "flex-start" }} onClick={() => { setMode(mode === "website" ? "description" : "website"); setProblem(null); }} disabled={scanning || busy}>
          {mode === "website" ? "Use a description instead" : "Use a website instead"}
        </button>
        {problem && <div className="notice bad" role="alert">{problem}</div>}
        {w.scan.status === "failed" && !problem && <div className="notice bad" role="alert">{w.scan.error || "The last analysis didn't finish."}</div>}
        {dirty && !scanning && <div className="notice warn">Save or discard your changes first: the analysis updates your profile.</div>}
        <button type="submit" className="btn primary" disabled={busy || scanning || dirty}>
          {busy || scanning ? <Spinner label="Analyzing" /> : <RefreshCw size={16} aria-hidden="true" />}
          {scanning ? "Analyzing…" : mode === "website" ? "Re-analyze website" : "Analyze description"}
        </button>
        {w.scan.status === "ready" && w.scan.at && <p className="hint">Last analyzed {formatDate(w.scan.at)}. Re-analyzing fills in your profile with what we find.</p>}
        {w.scan.status === "idle" && <p className="hint">We read your site and fill in the profile, colours and brand images for you.</p>}
      </form>
    </section>
  );
}

function ColorField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  const valid = HEX.test(value);
  return (
    <div className="field">
      <label className="label" htmlFor={`${id}-text`}>{label}</label>
      <div className="color-field">
        <input type="color" value={valid ? value.toLowerCase() : "#000000"} onChange={(e) => onChange(e.target.value)} aria-label={`${label} picker`} />
        <input id={`${id}-text`} className="input" value={value} maxLength={7} spellCheck={false} aria-invalid={!valid}
          onChange={(e) => { const v = e.target.value.trim(); onChange(v.startsWith("#") ? v : `#${v}`); }} />
      </div>
      {!valid && <span className="error small">Use a hex colour like #7c5cff.</span>}
    </div>
  );
}

/** An editable list of short texts (Enter or comma adds, Backspace on an empty field removes the last, click to edit). */
function TagList({ id, label, values, max, maxLength, placeholder, onChange }: {
  id: string; label: string; values: string[]; max: number; maxLength: number; placeholder: string; onChange: (v: string[]) => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const add = () => {
    const v = text.replace(/,+$/, "").trim().slice(0, maxLength);
    if (!v) { setText(""); return; }
    if (values.length >= max) return;
    if (!values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || (e.key === "," && maxLength <= 40)) { e.preventDefault(); add(); }
    else if (e.key === "Backspace" && !text && values.length) { e.preventDefault(); onChange(values.slice(0, -1)); }
  };
  const edit = (i: number) => {
    setText(values[i]);
    onChange(values.filter((_, j) => j !== i));
    setTimeout(() => input.current?.focus(), 0);
  };
  const full = values.length >= max;
  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}<span className="counter">{values.length}/{max}</span></label>
      <div className="tag-editor">
        {values.map((v, i) => (
          <span key={`${v}-${i}`} className="tag" title={v}>
            <button type="button" className="tag-text" onClick={() => edit(i)} aria-label={`Edit “${v}”`}>{v}</button>
            <button type="button" onClick={() => onChange(values.filter((_, j) => j !== i))} aria-label={`Remove “${v}”`}><X size={14} /></button>
          </span>
        ))}
        <input ref={input} id={id} value={text} maxLength={maxLength} disabled={full} placeholder={full ? `That's the maximum of ${max}` : values.length ? "Add another" : placeholder}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={add} aria-describedby={`${id}-hint`} />
      </div>
      <span id={`${id}-hint`} className="hint sr-only">Press Enter to add. Select an item to edit it.</span>
    </div>
  );
}

