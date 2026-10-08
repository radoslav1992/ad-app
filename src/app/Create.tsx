import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, RefreshCw, Shuffle, Sparkles, Trash2, Wand2, ChevronLeft, ChevronRight, Lightbulb, Save, VolumeX, Volume2 } from "lucide-react";
import { api, errorText, fileUrl, newKey, post, put, useAuth, type Asset, type Character, type LibraryItem, type Post } from "../lib";
import { useCurrentWorkspace } from "./workspace";
import { TextPreview } from "./PostView";
import { MediaPicker, LibraryPicker } from "./pickers";
import { Switch, useToast } from "../ui";
import { formatIds, formats, specCredits, specSchema, type FormatId, type Spec } from "../../shared/formats";
import { hookPatterns, writingStyles, writingStyleIds, type WritingStyle } from "../../shared/hooks";
import { textPresets, type TextLook } from "../../shared/overlay";
import { voices } from "../../shared/voices";
import { creditsLabel } from "../../shared/credits";
import "./create.css";

// Manual creation: pick a format and media, let the writer draft it, adjust the text and look, then save (it renders
// in the background and is approved). Also edits existing posts (?post=<id>).

type Picked = { url: string; kind: "image" | "video" | "audio"; name: string };
type Picker = null | { type: "image" | "video" | "audio"; target: string } | { library: "clip" | "greenscreen" | "music"; target: string };
const blankSpec = (format: FormatId, accent: string): Spec | null => {
  const parsed = specSchema.safeParse(
    format === "slideshow" ? { format, slides: [{ text: "Your hook here", image: { color: accent } }, { text: "Your point here", image: { color: accent } }], look: textPresets.box.look }
      : format === "text" ? { format, text: "your thought here", background: { color: accent } }
        : format === "green_screen" ? null : format === "hook_demo" ? null : null,
  );
  return parsed.success ? parsed.data : null;
};

export function Create() {
  const workspace = useCurrentWorkspace();
  const { user, refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editing = params.get("post");
  const [format, setFormat] = useState<FormatId>((params.get("format") as FormatId) || "slideshow");
  const [mode, setMode] = useState<"new" | "remix">(params.get("pattern") ? "remix" : "new");
  const [pattern, setPattern] = useState<string | null>(params.get("pattern"));
  const [mention, setMention] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState<WritingStyle>("quick_thought");
  const [inputs, setInputs] = useState<Record<string, string | undefined>>(() => ({ characterId: params.get("character") || undefined, backgroundAssetId: params.get("image") || undefined }));
  const [voice, setVoice] = useState("aria");
  const [spec, setSpec] = useState<Spec | null>(null);
  const [existing, setExisting] = useState<Post | null>(null);
  const [media, setMedia] = useState<Record<string, Picked>>({});
  const [characters, setCharacters] = useState<Character[]>([]);
  const [picker, setPicker] = useState<Picker>(null);
  const [tab, setTab] = useState<"inspiration" | "preview">(editing ? "preview" : "inspiration");
  const [slide, setSlide] = useState(0);
  const [busy, setBusy] = useState<"" | "generate" | "save">("");
  const [saveKey, setSaveKey] = useState(newKey);

  const remember = useCallback((id: string, item: Picked) => setMedia((m) => ({ ...m, [id]: item })), []);
  // What referenced media looks like in the preview: own files from the media API, shared items from the library.
  const resolve = useCallback(async (s: Spec) => {
    const ids = new Set<string>(), libs = new Set<string>();
    if (s.format === "slideshow") s.slides.forEach((x) => x.image.assetId && ids.add(x.image.assetId));
    if (s.format === "text" || s.format === "green_screen") { if (s.background.assetId) ids.add(s.background.assetId); }
    if (s.format === "text" && s.background.libraryId) libs.add(s.background.libraryId);
    if (s.format === "green_screen") libs.add(s.clipId);
    if (s.format === "hook_demo") { ids.add(s.demo.assetId); if ("libraryId" in s.hookClip) libs.add(s.hookClip.libraryId); }
    for (const id of ids) if (!media[id]) {
      try {
        const { asset } = await api<{ asset: Asset }>(`/media/${id}`);
        remember(id, { url: asset.url, kind: asset.mime.split("/")[0] as Picked["kind"], name: asset.name });
      } catch { /* shown as missing */ }
    }
    if ([...libs].some((id) => !media[id])) {
      try {
        const { items } = await api<{ items: LibraryItem[] }>("/library");
        for (const i of items) remember(i.id, { url: i.url, kind: i.kind === "music" ? "audio" : "video", name: i.name });
      } catch { /* shown as missing */ }
    }
  }, [media, remember]);
  useEffect(() => { void api<{ characters: Character[] }>("/characters").then((r) => setCharacters(r.characters)).catch(() => {}); }, []);
  useEffect(() => {
    if (!editing) return;
    void api<{ post: Post }>(`/posts/${editing}`).then(async ({ post: p }) => {
      setExisting(p);
      setFormat(p.format);
      setSpec(p.spec!);
      await resolve(p.spec!);
    }).catch((e) => toast(errorText(e), "bad"));
    // Load once per post.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    if (editing || spec) return;
    setSpec(blankSpec(format, workspace.profile.colors.primary));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [format]);

  const generate = async () => {
    setBusy("generate");
    try {
      const r = await post<{ specs: Spec[]; missing: Record<string, string> }>(`/workspaces/${workspace.id}/ideas`, {
        count: 1, formats: [format], mention, prompt: prompt.trim() || undefined, style, pattern: mode === "remix" ? pattern || undefined : undefined,
        useCredits: format === "ugc" || !!inputs.useCredits, inputs: Object.fromEntries(Object.entries(inputs).filter(([k, v]) => v && k !== "useCredits")),
      });
      let draft = r.specs[0];
      if (draft.format === "ugc") draft = { ...draft, voiceId: voice };
      setSpec(draft);
      setSlide(0);
      setTab("preview");
      await resolve(draft);
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy("");
    }
  };
  const credits = useMemo(() => {
    if (!spec) return 0;
    const t = spec.format === "ugc" ? characters.find((c) => c.id === spec.characterId) : spec.format === "hook_demo" && "characterId" in spec.hookClip ? characters.find((c) => c.id === (spec.hookClip as { characterId: string }).characterId) : null;
    return specCredits(spec, t?.premium ? "custom" : "library");
  }, [spec, characters]);
  const save = async () => {
    if (!spec) return;
    const parsed = specSchema.safeParse(spec);
    if (!parsed.success) { toast(parsed.error.issues[0]?.message || "Check the post's fields.", "bad"); return; }
    setBusy("save");
    try {
      if (existing) {
        const r = await put<{ rendering: boolean }>(`/posts/${existing.id}`, { spec: parsed.data, idempotencyKey: saveKey });
        toast(r.rendering ? "Saved. Your post is being made again — it'll be ready in a minute or two." : "Saved.", "good");
        navigate("/app/content");
      } else {
        await post(`/posts`, { workspaceId: workspace.id, spec: parsed.data, idempotencyKey: saveKey, approve: true });
        toast(<>Building your post! It'll be ready in a few minutes. <Link to="/app/content">View in Content</Link></>, "good");
        setSpec(null);
        setSaveKey(newKey());
        setSpec(blankSpec(format, workspace.profile.colors.primary));
        setTab("inspiration");
      }
      void refresh();
    } catch (e) {
      // A network failure may have saved it: keep the key so retrying cannot make a second post.
      if (!(e instanceof TypeError)) setSaveKey(newKey());
      toast(errorText(e), "bad");
    } finally {
      setBusy("");
    }
  };
  const change = (next: Partial<Spec>) => spec && setSpec({ ...spec, ...next } as Spec);
  const look: TextLook | null = spec && "look" in spec ? spec.look : spec?.format === "ugc" ? spec.hookLook : null;
  const setLook = (l: TextLook) => spec && (spec.format === "ugc" ? change({ hookLook: l } as Partial<Spec>) : change({ look: l } as Partial<Spec>));
  const picked = (id: string | undefined) => (id ? media[id] : undefined);
  /** A pick from a picker: `library` items are shared clips/tracks, the rest the owner's own files. */
  const onPick = (target: string, id: string, item: Picked, library: boolean) => {
    remember(id, item);
    if (target.startsWith("input:")) { setInputs({ ...inputs, [target.slice(6)]: id }); return; }
    if (!spec) return;
    if (target === "slide" && spec.format === "slideshow") change({ slides: spec.slides.map((s, i) => (i === slide ? { ...s, image: { assetId: id } } : s)) });
    if (target === "background" && spec.format === "text") change({ background: library ? { libraryId: id } : { assetId: id } });
    if (target === "background" && spec.format === "green_screen") change({ background: { assetId: id } });
    if (target === "music") change({ music: library ? { trackId: id, volume: 0.35 } : { assetId: id, volume: 0.35 } });
    if (target === "demo" && spec.format === "hook_demo") change({ demo: { ...spec.demo, assetId: id } });
    if (target === "hookClip" && spec.format === "hook_demo") change({ hookClip: { libraryId: id } });
    if (target === "green" && spec.format === "green_screen") change({ clipId: id });
  };

  // Preview: what the post looks like with its text.
  const preview = (() => {
    if (!spec || !look) return null;
    const bg = (ref: { assetId?: string; libraryId?: string; color?: string; prompt?: string }) => {
      const m = picked(ref.assetId || ref.libraryId);
      if (m && m.kind !== "audio") return { url: m.url, kind: m.kind as "image" | "video" };
      return { color: ref.color || (ref.prompt ? "#3b2a6b" : workspace.profile.colors.primary) };
    };
    if (spec.format === "slideshow") {
      const s = spec.slides[Math.min(slide, spec.slides.length - 1)];
      return <TextPreview text={s.text} look={look} background={bg(s.image)} />;
    }
    if (spec.format === "text" || spec.format === "green_screen") return <TextPreview text={spec.text} look={look} background={bg(spec.background)} />;
    if (spec.format === "hook_demo") {
      const clip = "libraryId" in spec.hookClip ? picked(spec.hookClip.libraryId) : null;
      return <TextPreview text={spec.hook} look={look} background={clip ? { url: clip.url, kind: "video" } : { color: "#1e2433" }} />;
    }
    const character = characters.find((c) => c.id === spec.characterId);
    return <TextPreview text={spec.hook} look={look} background={character ? { url: character.image, kind: "image" } : { color: "#1e2433" }} />;
  })();
  const aiPrompts = spec?.format === "slideshow" ? spec.slides.filter((s) => !s.image.assetId && !s.image.color && s.image.prompt).length : 0;

  return (
    <main className="page create">
      <div className="format-tabs" role="tablist" aria-label="Format">
        {formatIds.map((f) => (
          <button key={f} role="tab" aria-selected={format === f} disabled={!!editing && format !== f}
            onClick={() => { setFormat(f); setSpec(blankSpec(f, workspace.profile.colors.primary)); setSlide(0); }}>{formats[f].name}</button>
        ))}
      </div>
      <h1 className="sr-only">{editing ? "Edit post" : "Create a post"}</h1>
      <div className="create-grid">
        <section className="create-left" aria-label="What to make">
          {!editing && (
            <>
              <div className="card flat">
                <span className="label">Mode</span>
                <div className="seg">
                  <button aria-pressed={mode === "new"} onClick={() => setMode("new")}><Plus size={16} /> Create new</button>
                  <button aria-pressed={mode === "remix"} onClick={() => { setMode("remix"); setTab("inspiration"); }}><Shuffle size={16} /> Remix</button>
                </div>
              </div>
              <div className="card flat">
                <span className="label">Mention your business?</span>
                <div className="seg">
                  <button aria-pressed={mention} onClick={() => setMention(true)}>Yes</button>
                  <button aria-pressed={!mention} onClick={() => setMention(false)}>No</button>
                </div>
              </div>
              {mode === "remix" && (
                <div className="card flat row between">
                  <span className="label">Proven format</span>
                  <span className="small">{hookPatterns.find((p) => p.id === pattern)?.name || <span className="muted">Pick one on the right</span>}</span>
                </div>
              )}
              {(format === "text" || format === "green_screen" || format === "hook_demo") && (
                <InputRow label={format === "green_screen" ? "Green screen" : format === "hook_demo" ? "Hook clip" : "Video"} value={picked(inputs[format === "green_screen" ? "greenScreenId" : "backgroundLibraryId"])?.name}
                  onChange={() => setPicker({ library: format === "green_screen" ? "greenscreen" : "clip", target: `input:${format === "green_screen" ? "greenScreenId" : "backgroundLibraryId"}` })}
                  onClear={() => setInputs({ ...inputs, greenScreenId: undefined, backgroundLibraryId: undefined })} />
              )}
              {format === "hook_demo" && <InputRow label="Demo video" value={picked(inputs.demoAssetId)?.name} onChange={() => setPicker({ type: "video", target: "input:demoAssetId" })} onClear={() => setInputs({ ...inputs, demoAssetId: undefined })} />}
              {format === "green_screen" && <InputRow label="Picture" value={picked(inputs.backgroundAssetId)?.name} onChange={() => setPicker({ type: "image", target: "input:backgroundAssetId" })} onClear={() => setInputs({ ...inputs, backgroundAssetId: undefined })} />}
              {format !== "ugc" && <InputRow label="Audio" value={picked(inputs.musicTrackId)?.name} onChange={() => setPicker({ library: "music", target: "input:musicTrackId" })} onClear={() => setInputs({ ...inputs, musicTrackId: undefined })} />}
              {format === "ugc" && (
                <div className="card flat stack">
                  <span className="label">Creator</span>
                  <div className="creator-row">
                    {characters.length ? characters.map((c) => (
                      <button key={c.id} className="creator" aria-pressed={inputs.characterId === c.id} onClick={() => setInputs({ ...inputs, characterId: c.id })} title={c.name}>
                        <img src={c.image} alt="" /><span>{c.name}</span>
                      </button>
                    )) : <p className="muted small">No creators yet. <Link to="/app/characters">Make one</Link>.</p>}
                  </div>
                  <label className="field"><span>Voice</span>
                    <select className="select" value={voice} onChange={(e) => setVoice(e.target.value)}>
                      {voices.map((v) => <option key={v.id} value={v.id}>{v.name} — {v.tone} ({v.accent})</option>)}
                    </select>
                  </label>
                </div>
              )}
              {(format === "text" || format === "slideshow") && (
                <label className="card flat field"><span>Style</span>
                  <select className="select" value={style} onChange={(e) => setStyle(e.target.value as WritingStyle)}>
                    {writingStyleIds.map((s) => <option key={s} value={s}>{writingStyles[s].name}</option>)}
                  </select>
                </label>
              )}
              {format !== "ugc" && (
                <div className="card flat row between">
                  <div><strong className="small">AI images</strong><p className="muted small">Use AI pictures where you have none (1 credit each)</p></div>
                  <Switch checked={!!inputs.useCredits} onChange={(v) => setInputs({ ...inputs, useCredits: v ? "1" : undefined })} label="Use AI images" />
                </div>
              )}
              <label className="card flat field"><span>Prompt <span className="muted small">(optional)</span></span>
                <textarea className="textarea" rows={3} value={prompt} maxLength={400} onChange={(e) => setPrompt(e.target.value)}
                  placeholder={format === "slideshow" ? "What should this slideshow be about?" : format === "ugc" ? "What should the creator talk about?" : "What should the post be about?"} />
              </label>
              <button className="btn primary big block" onClick={generate} disabled={busy !== "" || (mode === "remix" && !pattern) || user?.trialEnded}>
                {busy === "generate" ? <><span className="spinner" /> Generating…</> : <><Wand2 size={18} /> Generate</>}
              </button>
            </>
          )}
          {editing && existing && (
            <div className="card flat stack">
              <strong>Editing a {formats[existing.format].name.toLowerCase()}</strong>
              <p className="muted small">Text and look changes re-render the post for free. New AI pictures or a new script for a creator use credits.</p>
              <Link className="btn" to="/app/content">Back to Content</Link>
            </div>
          )}
          {spec && <TextFields spec={spec} slide={slide} onChange={change} />}
        </section>
        <section className="create-right card" aria-label="Preview">
          <div className="row between" style={{ marginBottom: 14 }}>
            <div className="tabs" role="tablist">
              {!editing && <button role="tab" aria-selected={tab === "inspiration"} onClick={() => setTab("inspiration")}><Lightbulb size={15} /> Proven formats</button>}
              <button role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")}>Preview</button>
            </div>
            <div className="toolbar">
              {spec && !editing && <button className="btn sm ghost" onClick={() => { setSpec(blankSpec(format, workspace.profile.colors.primary)); setSlide(0); }}><RefreshCw size={14} /> Clear</button>}
              <button className="btn primary" disabled={!spec || busy !== ""} onClick={save}>
                {busy === "save" ? <span className="spinner" /> : <Save size={16} />} {existing ? "Save" : "Save & build"}{credits > 0 ? ` · ${creditsLabel(credits)}` : ""}
              </button>
            </div>
          </div>
          {tab === "inspiration" && !editing ? (
            <div className="patterns">
              {hookPatterns.filter((p) => p.formats.includes(format)).map((p) => (
                <article key={p.id} className={`pattern${pattern === p.id ? " on" : ""}`}>
                  <strong>{p.name}</strong>
                  <p className="template">“{p.template}”</p>
                  <p className="muted small">{p.why}</p>
                  <button className="btn sm" onClick={() => { setMode("remix"); setPattern(p.id); }}><Shuffle size={14} /> Remix this</button>
                </article>
              ))}
            </div>
          ) : spec && look ? (
            <div className="preview-grid">
              <div className="preview-phone">
                {preview}
                {spec.format === "slideshow" && (
                  <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
                    <button className="btn icon sm" disabled={slide === 0} onClick={() => setSlide(slide - 1)} aria-label="Previous slide"><ChevronLeft size={16} /></button>
                    <span className="small muted">Slide {slide + 1} of {spec.slides.length}</span>
                    <button className="btn icon sm" disabled={slide >= spec.slides.length - 1} onClick={() => setSlide(slide + 1)} aria-label="Next slide"><ChevronRight size={16} /></button>
                  </div>
                )}
              </div>
              <Inspector spec={spec} look={look} setLook={setLook} slide={slide} setSlide={setSlide} onChange={change}
                pick={(p) => setPicker(p)} aiPrompts={aiPrompts} characters={characters} />
            </div>
          ) : (
            <div className="empty"><Sparkles size={28} /><p>{format === "ugc" || format === "hook_demo" || format === "green_screen" ? "Choose your media on the left, then Generate." : "Generate a draft, or start typing on the left."}</p></div>
          )}
        </section>
      </div>
      {picker && "type" in picker && (
        <MediaPicker workspaceId={workspace.id} type={picker.type} allowUpload onClose={() => setPicker(null)}
          onPick={(a) => { onPick(picker.target, a.id, { url: a.url, kind: a.mime.split("/")[0] as Picked["kind"], name: a.name }, false); setPicker(null); }} />
      )}
      {picker && "library" in picker && (
        <LibraryPicker kind={picker.library} onClose={() => setPicker(null)}
          onPick={(i) => { onPick(picker.target, i.id, { url: i.url, kind: i.kind === "music" ? "audio" : "video", name: i.name }, true); setPicker(null); }} />
      )}
    </main>
  );
}

function InputRow({ label, value, onChange, onClear }: { label: string; value?: string; onChange: () => void; onClear: () => void }) {
  return (
    <div className="card flat row between">
      <span className="label">{label}</span>
      <div className="row">
        {value ? <span className="small truncate" title={value}>{value}</span> : <span className="small muted">Any</span>}
        {value && <button className="btn sm ghost" onClick={onClear} aria-label={`Clear ${label}`}>×</button>}
        <button className="btn sm" onClick={onChange}>Change</button>
      </div>
    </div>
  );
}

/** The words of the post: slide texts, the wall of text, hook and demo caption, the creator's script, the caption. */
function TextFields({ spec, slide, onChange }: { spec: Spec; slide: number; onChange: (s: Partial<Spec>) => void }) {
  return (
    <div className="card flat stack">
      {spec.format === "slideshow" && (
        <label className="field"><span>Slide {slide + 1} text</span>
          <textarea className="textarea" rows={3} maxLength={300} value={spec.slides[slide]?.text || ""}
            onChange={(e) => onChange({ slides: spec.slides.map((s, i) => (i === slide ? { ...s, text: e.target.value } : s)) })} />
        </label>
      )}
      {(spec.format === "text" || spec.format === "green_screen") && (
        <label className="field"><span>On-screen text</span>
          <textarea className="textarea" rows={5} maxLength={spec.format === "text" ? 600 : 300} value={spec.text} onChange={(e) => onChange({ text: e.target.value })} />
        </label>
      )}
      {spec.format === "hook_demo" && (
        <>
          <label className="field"><span>Hook</span><textarea className="textarea" rows={2} maxLength={200} value={spec.hook} onChange={(e) => onChange({ hook: e.target.value })} /></label>
          <label className="field"><span>Demo caption</span><input className="input" maxLength={200} value={spec.demoText} onChange={(e) => onChange({ demoText: e.target.value })} /></label>
          {"line" in spec.hookClip && (
            <label className="field"><span>What the creator says</span>
              <input className="input" maxLength={200} value={spec.hookClip.line} onChange={(e) => onChange({ hookClip: { ...(spec.hookClip as { characterId: string; voiceId: string; line: string }), line: e.target.value } })} />
            </label>
          )}
        </>
      )}
      {spec.format === "ugc" && (
        <>
          <label className="field"><span>Script <span className="muted small">(spoken; {spec.script.length}/900)</span></span>
            <textarea className="textarea" rows={7} maxLength={900} value={spec.script} onChange={(e) => onChange({ script: e.target.value })} />
          </label>
          <label className="field"><span>On-screen title</span><input className="input" maxLength={140} value={spec.hook} onChange={(e) => onChange({ hook: e.target.value })} /></label>
        </>
      )}
      <label className="field"><span>Caption</span><textarea className="textarea" rows={3} maxLength={2200} value={spec.caption} onChange={(e) => onChange({ caption: e.target.value })} /></label>
      <label className="field"><span>Hashtags</span>
        <input className="input" value={spec.hashtags.join(" ")} placeholder="#productivity #founders"
          onChange={(e) => onChange({ hashtags: e.target.value.split(/[\s,]+/).filter(Boolean).slice(0, 15).map((t) => (t.startsWith("#") ? t : `#${t}`)) })} />
      </label>
    </div>
  );
}

/** The editor's right-hand controls: text look, media swaps, slides, sound. */
function Inspector({ spec, look, setLook, slide, setSlide, onChange, pick, aiPrompts, characters }: {
  spec: Spec; look: TextLook; setLook: (l: TextLook) => void; slide: number; setSlide: (n: number) => void; onChange: (s: Partial<Spec>) => void;
  pick: (p: Picker) => void; aiPrompts: number; characters: Character[];
}) {
  const range = (label: string, value: number, min: number, max: number, stepSize: number, set: (v: number) => void, unit = "") => (
    <label className="field"><span className="small">{label}: {unit === "x" ? `${Math.round(value * 100)}%` : `${value}${unit}`}</span>
      <input type="range" min={min} max={max} step={stepSize} value={value} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );
  const color = (label: string, value: string, set: (v: string) => void) => (
    <label className="row small color-field"><input type="color" value={value} onChange={(e) => set(e.target.value)} aria-label={label} /><span>{label}</span><code>{value.toUpperCase()}</code></label>
  );
  return (
    <div className="inspector stack">
      <div className="stack" style={{ gap: 10 }}>
        <strong className="small">Text</strong>
        <div className="seg small-seg">
          {Object.entries(textPresets).map(([id, p]) => <button key={id} onClick={() => setLook({ ...p.look, position: look.position })} aria-pressed={JSON.stringify({ ...p.look, position: look.position }) === JSON.stringify(look)}>{p.name}</button>)}
        </div>
        <div className="seg small-seg">
          {(["regular", "bold"] as const).map((w) => <button key={w} aria-pressed={look.weight === w} onClick={() => setLook({ ...look, weight: w })}>{w === "bold" ? "Bold" : "Regular"}</button>)}
        </div>
        {range("Size", look.size, 0.5, 1.8, 0.05, (v) => setLook({ ...look, size: v }), "x")}
        {color("Colour", look.color, (v) => setLook({ ...look, color: v }))}
        {range("Stroke", look.stroke, 0, 12, 1, (v) => setLook({ ...look, stroke: v }), "px")}
        {color("Stroke colour", look.strokeColor, (v) => setLook({ ...look, strokeColor: v }))}
        <div className="seg small-seg" role="group" aria-label="Background">
          <button aria-pressed={!!look.background} onClick={() => setLook({ ...look, background: look.background || "#ffffff" })}>Box</button>
          <button aria-pressed={!look.background} onClick={() => setLook({ ...look, background: null })}>None</button>
        </div>
        {look.background && color("Box colour", look.background, (v) => setLook({ ...look, background: v }))}
        <div className="seg small-seg" role="group" aria-label="Position">
          {(["top", "center", "bottom"] as const).map((p) => <button key={p} aria-pressed={look.position === p} onClick={() => setLook({ ...look, position: p })}>{p[0].toUpperCase() + p.slice(1)}</button>)}
        </div>
      </div>
      <hr />
      {spec.format === "slideshow" && (
        <div className="stack" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => pick({ type: "image", target: "slide" })}>Swap image</button>
          <button className="btn sm" onClick={() => onChange({ slides: spec.slides.map((s, i) => (i === slide ? { ...s, image: { color: "#111111" } } : s)) })}>Plain colour</button>
          <button className="btn sm" disabled={spec.slides.length >= 10} onClick={() => { onChange({ slides: [...spec.slides.slice(0, slide + 1), { text: "New slide", image: spec.slides[slide].image }, ...spec.slides.slice(slide + 1)] }); setSlide(slide + 1); }}><Plus size={14} /> Add slide</button>
          <button className="btn sm danger" disabled={spec.slides.length <= 2} onClick={() => { onChange({ slides: spec.slides.filter((_, i) => i !== slide) }); setSlide(Math.max(0, slide - 1)); }}><Trash2 size={14} /> Delete slide</button>
          {range("Seconds per slide (video)", spec.secondsPerSlide, 1.5, 6, 0.5, (v) => onChange({ secondsPerSlide: v }), "s")}
          {aiPrompts > 0 && <p className="notice small">{aiPrompts} AI picture{aiPrompts === 1 ? "" : "s"} will be made when you save.</p>}
        </div>
      )}
      {(spec.format === "text" || spec.format === "green_screen") && (
        <div className="stack" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => pick(spec.format === "text" ? { library: "clip", target: "background" } : { type: "image", target: "background" })}>{spec.format === "text" ? "Swap video" : "Swap picture"}</button>
          {spec.format === "text" && <button className="btn sm" onClick={() => pick({ type: "image", target: "background" })}>Use my image</button>}
          {spec.format === "green_screen" && <button className="btn sm" onClick={() => pick({ library: "greenscreen", target: "green" })}>Swap creator clip</button>}
          <button className="btn sm" onClick={() => onChange({ clipAudio: !spec.clipAudio } as Partial<Spec>)}>{spec.clipAudio ? <><VolumeX size={14} /> Mute clip sound</> : <><Volume2 size={14} /> Keep clip sound</>}</button>
          {range("Length", spec.seconds, spec.format === "text" ? 4 : 3, spec.format === "text" ? 30 : 20, 1, (v) => onChange({ seconds: v } as Partial<Spec>), "s")}
        </div>
      )}
      {spec.format === "hook_demo" && (
        <div className="stack" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => pick({ library: "clip", target: "hookClip" })}>Swap hook clip</button>
          <button className="btn sm" onClick={() => pick({ type: "video", target: "demo" })}>Swap demo video</button>
          {range("Demo length", spec.demo.seconds, 2, 45, 1, (v) => onChange({ demo: { ...spec.demo, seconds: v } }), "s")}
        </div>
      )}
      {spec.format === "ugc" && (
        <div className="stack" style={{ gap: 8 }}>
          <label className="field"><span className="small">Creator</span>
            <select className="select" value={spec.characterId} onChange={(e) => onChange({ characterId: e.target.value })}>
              {characters.map((c) => <option key={c.id} value={c.id}>{c.name}{c.premium ? " (premium)" : ""}</option>)}
            </select>
          </label>
          <label className="field"><span className="small">Voice</span>
            <select className="select" value={spec.voiceId} onChange={(e) => onChange({ voiceId: e.target.value })}>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name} — {v.tone}</option>)}
            </select>
          </label>
        </div>
      )}
      <hr />
      <div className="stack" style={{ gap: 8 }}>
        <button className="btn sm" onClick={() => pick({ library: "music", target: "music" })}>{spec.music ? "Swap audio" : "Add audio"}</button>
        {spec.music && <button className="btn sm ghost" onClick={() => onChange({ music: null })}>Remove audio</button>}
        {spec.music && range("Music volume", spec.music.volume, 0, 1, 0.05, (v) => onChange({ music: { ...spec.music!, volume: v } }), "x")}
      </div>
      <p className="muted small">The preview uses the same fonts and layout as the final video.</p>
    </div>
  );
}
