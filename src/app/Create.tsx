import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, RefreshCw, Shuffle, Sparkles, Trash2, Wand2, ChevronLeft, ChevronRight, Lightbulb, Save, VolumeX, Volume2, AudioLines } from "lucide-react";
import { api, errorText, fileUrl, newKey, post, put, usePoll, useAuth, type Asset, type Character, type LibraryItem, type Post } from "../lib";
import { useCurrentWorkspace } from "./workspace";
import { TextPreview, type PreviewBackground, type TextBlock } from "./TextPreview";
import { CaptionStylePicker, EditorSection, TextAnimationPicker } from "./CaptionPickers";
import { MediaPicker, LibraryPicker } from "./pickers";
import { CreatorField } from "./creators";
import { Switch, useToast } from "../ui";
import { formatIds, formats, recordingCurrent, specCredits, specSchema, HOOK_CLIP_MAX_SECONDS, type FormatId, type Spec, type Subtitles } from "../../shared/formats";
import { hookPatterns, writingStyles, writingStyleIds, type WritingStyle } from "../../shared/hooks";
import { textPresets, type TextLook } from "../../shared/overlay";
import { styledCaptions, type CaptionDocument, type CaptionWord } from "../../shared/captions";
import { clipWords, loopedWords, type SpeechStatus } from "../../shared/speech";
import { voices } from "../../shared/voices";
import { creditsLabel } from "../../shared/credits";
import "./create.css";

// Manual creation: pick a format and media, let the writer draft it, adjust the text and look, then save (it renders
// in the background and is approved). Also edits existing posts (?post=<id>). The preview plays the post's text
// animation and captions as rendered; the caption styles and a clip's subtitles are chosen under it.

/** A file in the post as the editor knows it; own videos and tracks also bring their speech (word timings). */
type Picked = { url: string; kind: "image" | "video" | "audio"; name: string; duration?: number; speech?: SpeechStatus | null; words?: CaptionWord[] };
type MediaAsset = Asset & { speech?: SpeechStatus | null; transcript?: { language: string; words: CaptionWord[] } | null };
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
  /** Which part of a hook + demo the preview plays. */
  const [part, setPart] = useState<"hook" | "demo">("hook");
  const [busy, setBusy] = useState<"" | "generate" | "save">("");
  const [saveKey, setSaveKey] = useState(newKey);

  const remember = useCallback((id: string, item: Picked) => setMedia((m) => ({ ...m, [id]: item })), []);
  /** One own file, with its speech (the media list has no transcripts). */
  const loadAsset = useCallback(async (id: string) => {
    const { asset } = await api<{ asset: MediaAsset }>(`/media/${id}`);
    remember(id, { url: asset.url, kind: asset.mime.split("/")[0] as Picked["kind"], name: asset.name, duration: asset.duration, speech: asset.speech ?? null, words: asset.transcript?.words });
  }, [remember]);
  // What referenced media looks like in the preview: own files from the media API, shared items from the library.
  const resolve = useCallback(async (s: Spec) => {
    const ids = new Set<string>(), libs = new Set<string>();
    if (s.format === "slideshow") s.slides.forEach((x) => x.image.assetId && ids.add(x.image.assetId));
    if (s.format === "text" || s.format === "green_screen") { if (s.background.assetId) ids.add(s.background.assetId); }
    if (s.format === "text" && s.background.libraryId) libs.add(s.background.libraryId);
    if (s.format === "green_screen") libs.add(s.clipId);
    if (s.format === "hook_demo") { ids.add(s.demo.assetId); if ("libraryId" in s.hookClip) libs.add(s.hookClip.libraryId); }
    for (const id of ids) if (!media[id]) await loadAsset(id).catch(() => { /* shown as missing */ });
    if ([...libs].some((id) => !media[id])) {
      try {
        const { items } = await api<{ items: LibraryItem[] }>("/library");
        for (const i of items) remember(i.id, { url: i.url, kind: i.kind === "music" ? "audio" : "video", name: i.name, duration: i.duration });
      } catch { /* shown as missing */ }
    }
  }, [media, remember, loadAsset]);
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
  // AI UGC captions: the recording's words, or a timed sample of the script's start until it is recorded.
  const script = spec?.format === "ugc" ? spec.script : "";
  const sample = useMemo(() => sampleWords(script), [script]);
  const ugcWords = spec?.format === "ugc" && recordingCurrent(spec) && spec.generated?.videoAssetId ? spec.generated.words : sample.words;
  const ugcStyle = spec?.format === "ugc" ? spec.captionStyle : null;
  const ugcCaptions = useMemo(() => (ugcStyle ? styledCaptions(ugcWords, ugcStyle) : null), [ugcWords, ugcStyle]);
  const picked = (id: string | undefined) => (id ? media[id] : undefined);
  // The own clip whose speech can become subtitles: the demo, or a wall of text's video background.
  const speechId = spec?.format === "hook_demo" ? spec.demo.assetId : spec?.format === "text" && picked(spec.background.assetId)?.kind === "video" ? spec.background.assetId : undefined;
  const speechClip = picked(speechId);
  // While its speech is being found, check again every few seconds.
  usePoll(() => { if (speechId) void loadAsset(speechId).catch(() => {}); }, 4000, speechClip?.speech === "pending");
  const [finding, setFinding] = useState(false);
  const findSpeech = async () => {
    if (!speechId) return;
    setFinding(true);
    try {
      await post(`/media/${speechId}/speech`);
      await loadAsset(speechId);
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setFinding(false);
    }
  };
  /** A pick from a picker: `library` items are shared clips/tracks, the rest the owner's own files. */
  const onPick = (target: string, id: string, item: Picked, library: boolean) => {
    remember(id, item);
    if (!library && item.kind === "video") void loadAsset(id).catch(() => {});
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

  // Preview: what the post looks like with its text, animated and with its captions, on a loop of the post's clock.
  const preview = (() => {
    if (!spec || !look) return null;
    const bg = (ref: { assetId?: string; libraryId?: string; color?: string; prompt?: string }): PreviewBackground => {
      const m = picked(ref.assetId || ref.libraryId);
      if (m && m.kind !== "audio") return { url: m.url, kind: m.kind as "image" | "video" };
      return { color: ref.color || (ref.prompt ? "#3b2a6b" : workspace.profile.colors.primary) };
    };
    const replay = `${look.animation}:${slide}:${part}`;
    const block = (text: string, l: TextLook, end: number, start = 0): TextBlock => ({ text, look: l, start, end });
    if (spec.format === "slideshow") {
      const s = spec.slides[Math.min(slide, spec.slides.length - 1)];
      return <TextPreview blocks={[block(s.text, look, spec.secondsPerSlide)]} seconds={spec.secondsPerSlide} background={bg(s.image)} replay={replay} />;
    }
    if (spec.format === "text" || spec.format === "green_screen") {
      // A clip's own speech, where it repeats as the clip loops behind the text.
      const clip = spec.format === "text" && spec.clipAudio ? picked(spec.background.assetId) : undefined;
      const words = spec.format === "text" && clip?.words?.length ? loopedWords(clip.words, clip.duration || 0, spec.seconds) : [];
      return <TextPreview blocks={[block(spec.text, look, spec.seconds)]} seconds={spec.seconds} background={bg(spec.background)} replay={replay}
        captions={subtitleCaptions(spec.format === "text" ? spec.subtitles : null, words, look.position === "bottom" ? "top" : "bottom")} sound={!!clip} />;
    }
    if (spec.format === "hook_demo") {
      if (part === "demo") {
        const demo = picked(spec.demo.assetId);
        const start = Math.min(spec.demo.start, Math.max(0, (demo?.duration || 0) - 1));
        const length = Math.max(1, Math.min(spec.demo.seconds, (demo?.duration || spec.demo.seconds + start) - start));
        return <TextPreview blocks={[block(spec.demoText, { ...look, position: "top" }, length)]} seconds={length} replay={replay}
          background={demo ? { url: demo.url, kind: "video", start } : { color: "#1e2433" }} videoClock={!!demo} sound
          captions={subtitleCaptions(spec.subtitles, demo?.words ? clipWords(demo.words, start, length, 0) : [])} />;
      }
      const clip = "libraryId" in spec.hookClip ? picked(spec.hookClip.libraryId) : null;
      const seconds = Math.min(clip?.duration || 3, HOOK_CLIP_MAX_SECONDS);
      return <TextPreview blocks={[block(spec.hook, look, seconds)]} seconds={seconds} replay={replay} background={clip ? { url: clip.url, kind: "video" } : { color: "#1e2433" }} />;
    }
    // AI UGC: the made recording with its real word timings, or the creator's picture with a sample of the script.
    if (recordingCurrent(spec) && spec.generated?.videoAssetId && spec.generated.words.length) {
      return <TextPreview blocks={[block(spec.hook, look, 3)]} seconds={existing?.duration || 600} videoClock sound replay={replay}
        background={{ url: fileUrl(spec.generated.videoAssetId), kind: "video" }} captions={ugcCaptions} />;
    }
    const character = characters.find((c) => c.id === spec.characterId);
    return <TextPreview blocks={[block(spec.hook, look, Math.min(3, sample.seconds))]} seconds={sample.seconds} replay={replay}
      background={character ? { url: character.image, kind: "image" } : { color: "#1e2433" }} captions={ugcCaptions} />;
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
                  <CreatorField value={inputs.characterId} onClear={() => setInputs({ ...inputs, characterId: undefined })}
                    onChange={(id, c) => { setInputs({ ...inputs, characterId: id }); setCharacters((l) => [c, ...l.filter((x) => x.id !== id)]); }} />
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
              <strong>Editing: {formats[existing.format].name}</strong>
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
            <>
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
                  {spec.format === "hook_demo" && (
                    <div className="seg small-seg preview-parts" role="group" aria-label="Part to preview">
                      <button type="button" aria-pressed={part === "hook"} onClick={() => setPart("hook")}>Hook</button>
                      <button type="button" aria-pressed={part === "demo"} onClick={() => setPart("demo")}>Demo</button>
                    </div>
                  )}
                </div>
                <Inspector spec={spec} look={look} setLook={setLook} slide={slide} setSlide={setSlide} onChange={change}
                  pick={(p) => setPicker(p)} aiPrompts={aiPrompts} addCharacter={(c) => setCharacters((l) => [c, ...l.filter((x) => x.id !== c.id)])} demoSeconds={picked(spec.format === "hook_demo" ? spec.demo.assetId : undefined)?.duration} />
              </div>
              {spec.format === "ugc" && (
                <EditorSection title="Captions" hint="Word-by-word captions of what your creator says. The preview plays a sample until the voice is recorded.">
                  <CaptionStylePicker value={spec.captionStyle} onChange={(captionStyle) => change({ captionStyle } as Partial<Spec>)} />
                </EditorSection>
              )}
              {(spec.format === "hook_demo" || spec.format === "text") && speechClip && speechClip.kind === "video" && (
                <SubtitlesSection clip={speechClip} subtitles={spec.subtitles} finding={finding} onFind={findSpeech}
                  soundKept={spec.format === "hook_demo" || spec.clipAudio} where={spec.format === "hook_demo" ? "demo" : "clip"}
                  onKeepSound={() => change({ clipAudio: true } as Partial<Spec>)}
                  onChange={(subtitles) => { change({ subtitles } as Partial<Spec>); if (spec.format === "hook_demo" && subtitles.enabled) setPart("demo"); }} />
              )}
            </>
          ) : (
            <div className="empty"><Sparkles size={28} /><p>{format === "ugc" || format === "hook_demo" || format === "green_screen" ? "Choose your media on the left, then Generate." : "Generate a draft, or start typing on the left."}</p></div>
          )}
        </section>
      </div>
      {picker && "type" in picker && (
        <MediaPicker workspaceId={workspace.id} type={picker.type} allowUpload onClose={() => setPicker(null)}
          onPick={(a) => { onPick(picker.target, a.id, { url: a.url, kind: a.mime.split("/")[0] as Picked["kind"], name: a.name, duration: a.duration }, false); setPicker(null); }} />
      )}
      {picker && "library" in picker && (
        <LibraryPicker kind={picker.library} onClose={() => setPicker(null)}
          onPick={(i) => { onPick(picker.target, i.id, { url: i.url, kind: i.kind === "music" ? "audio" : "video", name: i.name, duration: i.duration }, true); setPicker(null); }} />
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

/**
 * Subtitles of a clip's speech (a demo, or a wall of text's own video with its sound kept): a switch and the caption
 * styles once speech was found; otherwise where finding it stands, and "Find speech" for files not yet listened to.
 */
function SubtitlesSection({ clip, subtitles, soundKept, where, finding, onFind, onKeepSound, onChange }: {
  clip: Picked; subtitles: Subtitles; soundKept: boolean; where: "demo" | "clip"; finding: boolean;
  onFind: () => void; onKeepSound: () => void; onChange: (s: Subtitles) => void;
}) {
  const status = clip.speech ?? null;
  if (status === "found" && clip.words?.length) {
    if (!soundKept)
      return (
        <EditorSection title="Subtitles" hint="This clip has speech. Keep its sound to add subtitles of what's said."
          action={<button type="button" className="btn sm" onClick={onKeepSound}><Volume2 size={14} /> Keep clip sound</button>} />
      );
    return (
      <EditorSection title="Subtitles" hint={`What's said in the ${where === "demo" ? "part of the demo you use" : "clip"}, timed to the voice.`}
        action={<Switch checked={subtitles.enabled} onChange={(enabled) => onChange({ ...subtitles, enabled })} label="Show subtitles" />}>
        {subtitles.enabled && <CaptionStylePicker label="Subtitle style" value={subtitles.style} onChange={(style) => onChange({ ...subtitles, style })} />}
      </EditorSection>
    );
  }
  if (status === "pending" || finding)
    return <EditorSection title="Subtitles" hint={<><span className="spinner" aria-hidden="true" /> Listening for speech in this video. It takes a minute or so.</>} />;
  if (status === "none" || status === "found") return <EditorSection title="Subtitles" hint="We didn't hear any speech in this video, so it has no subtitles." />;
  return (
    <EditorSection title="Subtitles" hint={status === "failed" ? "We couldn't listen to this video for speech. You can try again." : "We haven't listened to this video for speech yet. It's free."}
      action={<button type="button" className="btn sm" onClick={onFind} disabled={finding}><AudioLines size={14} /> Find speech</button>} />
  );
}

/** The editor's right-hand controls: text look, media swaps, slides, sound. */
function Inspector({ spec, look, setLook, slide, setSlide, onChange, pick, aiPrompts, addCharacter, demoSeconds }: {
  spec: Spec; look: TextLook; setLook: (l: TextLook) => void; slide: number; setSlide: (n: number) => void; onChange: (s: Partial<Spec>) => void;
  pick: (p: Picker) => void; aiPrompts: number; addCharacter: (c: Character) => void;
  /** Length of the chosen demo video, when known. */
  demoSeconds?: number;
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
          {Object.entries(textPresets).map(([id, p]) => {
            // A preset changes the letters, not where the text sits or how it enters.
            const next = { ...p.look, position: look.position, animation: look.animation };
            return <button key={id} onClick={() => setLook(next)} aria-pressed={JSON.stringify(next) === JSON.stringify(look)}>{p.name}</button>;
          })}
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
        <span className="small">Animation</span>
        <TextAnimationPicker look={look} onChange={(animation) => setLook({ ...look, animation })} />
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
          {/* An own video can keep its sound, and its speech can become subtitles. */}
          {spec.format === "text" && <button className="btn sm" onClick={() => pick({ type: "video", target: "background" })}>Use my video</button>}
          {spec.format === "green_screen" && <button className="btn sm" onClick={() => pick({ library: "greenscreen", target: "green" })}>Swap creator clip</button>}
          <button className="btn sm" onClick={() => onChange({ clipAudio: !spec.clipAudio } as Partial<Spec>)}>{spec.clipAudio ? <><VolumeX size={14} /> Mute clip sound</> : <><Volume2 size={14} /> Keep clip sound</>}</button>
          {range("Length", spec.seconds, spec.format === "text" ? 4 : 3, spec.format === "text" ? 30 : 20, 1, (v) => onChange({ seconds: v } as Partial<Spec>), "s")}
        </div>
      )}
      {spec.format === "hook_demo" && (
        <div className="stack" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => pick({ library: "clip", target: "hookClip" })}>Swap hook clip</button>
          <button className="btn sm" onClick={() => pick({ type: "video", target: "demo" })}>Swap demo video</button>
          {range("Demo starts at", spec.demo.start, 0, demoSeconds ? Math.max(0, Math.min(600, Math.floor(demoSeconds - 2))) : Math.max(60, spec.demo.start), 0.5, (v) => onChange({ demo: { ...spec.demo, start: v } }), "s")}
          {range("Demo length", spec.demo.seconds, 2, 45, 1, (v) => onChange({ demo: { ...spec.demo, seconds: v } }), "s")}
        </div>
      )}
      {spec.format === "ugc" && (
        <div className="stack" style={{ gap: 8 }}>
          <CreatorField value={spec.characterId} onChange={(id, c) => { addCharacter(c); onChange({ characterId: id }); }} />
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

/** Subtitles to preview: the words of the used part of a clip, in the chosen style (null when they are off). */
function subtitleCaptions(settings: Subtitles | null, words: CaptionWord[], position: CaptionDocument["position"] = "bottom"): CaptionDocument | null {
  return settings?.enabled && words.length ? styledCaptions(words, settings.style, position) : null;
}
/**
 * Up to a dozen words of a script with rough speaking times, so a caption style can be previewed before the voice
 * is recorded (the real timings replace them). Longer words take longer; a sentence end adds a pause.
 */
function sampleWords(script: string): { words: CaptionWord[]; seconds: number } {
  const words: CaptionWord[] = [];
  let t = 0.3;
  for (const text of script.split(/\s+/).filter(Boolean).slice(0, 12)) {
    const length = 0.12 + 0.055 * Math.min(12, text.length);
    words.push({ text, start: Math.round(t * 100) / 100, end: Math.round((t + length) * 100) / 100 });
    t += length + (/[.!?]$/.test(text) ? 0.35 : 0.04);
  }
  return { words, seconds: Math.max(2.5, t + 0.8) };
}
