import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Copy, ImagePlus, Plus, Save, Trash2, Wand2, X } from "lucide-react";
import { errorText, fileUrl, patch, type Workspace } from "../lib";
import { Switch, useToast } from "../ui";
import { EditorSection, useRadioKeys } from "./CaptionPickers";
import { MediaPicker } from "./pickers";
import { reducedMotion } from "./caption-canvas";
import { SlideCanvas } from "./carousel-canvas";
import { useWorkspace } from "./workspace";
import {
  aspectInfo, captionWithCta, carouselAspects, carouselFonts, carouselThemeIds, carouselThemes, colourMood, ctaPresets, ctaTypes, fontNames,
  CAROUSEL_MAX_SLIDES, CAROUSEL_MIN_SLIDES, SLIDE_BODY_MAX, SLIDE_LABEL_MAX, SLIDE_TITLE_MAX, KEYWORD,
  type CarouselCta, type CarouselKit, type CarouselSlide, type CarouselTheme, type SlideKind,
} from "../../shared/carousel";
import { pendingMedia, type CarouselSpec } from "../../shared/formats";
import { IMAGE_CREDITS, REFERENCE_IMAGE_CREDITS, creditsLabel } from "../../shared/credits";
import { PRODUCT } from "../../shared/brand";
import "./carousel.css";

// The Carousel tab of Create: a phone preview that swipes like Instagram, the slides (add, duplicate, move, delete),
// the selected slide's words and picture, the call to action, the theme and shape, and the brand kit. Every slide is
// drawn by the layout the render uses (shared/carousel.ts), so what is shown is what gets posted.

type FontId = (typeof carouselFonts)[number];
const kindNames: Record<SlideKind, string> = { cover: "Cover", content: "Point", cta: "Call to action" };
const labelHints: Record<SlideKind, string> = {
  cover: "A small kicker above the hook, e.g. \"5 tips\" (optional)",
  content: "A number (\"01\") shows big; a word (\"Myth\") shows as a tag (optional)",
  cta: "A small kicker above the closing line (optional)",
};
const blankSlide = (kind: SlideKind): CarouselSlide => ({ kind, title: kind === "cta" ? "Want more like this?" : "One clear point", body: "", label: "" });

/** The Instagram-like phone: the slides side by side, swiped (or scrolled, or moved with the buttons), with dots. */
export function CarouselPhone({ spec, current, onCurrent }: { spec: CarouselSpec; current: number; onCurrent: (i: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const settle = useRef(0);
  const n = spec.slides.length;
  // Moved from outside (the slide list, the buttons): scroll there.
  useEffect(() => {
    const t = track.current;
    if (!t || !t.clientWidth) return;
    const x = current * t.clientWidth;
    if (Math.abs(t.scrollLeft - x) > 2) t.scrollTo({ left: x, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [current, n]);
  // Swiped: the slide it comes to rest on is chosen once the scrolling stops.
  const onScroll = () => {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const t = track.current;
      if (!t || !t.clientWidth) return;
      const i = Math.max(0, Math.min(n - 1, Math.round(t.scrollLeft / t.clientWidth)));
      if (i !== current) onCurrent(i);
    }, 120);
  };
  useEffect(() => () => window.clearTimeout(settle.current), []);
  const handle = spec.brand.handle || "your.brand";
  return (
    <div className="cr-phone">
      <div className="cr-phone-head" aria-hidden="true">
        {spec.brand.logoId ? <img src={fileUrl(spec.brand.logoId)} alt="" className="cr-avatar" /> : <span className="cr-avatar">{handle.replace(/^@/, "")[0]?.toUpperCase()}</span>}
        <strong>{handle.replace(/^@/, "")}</strong>
      </div>
      <div className="cr-stage">
        <div ref={track} className="cr-track" onScroll={onScroll} role="group" aria-roledescription="carousel"
          aria-label={`Preview, slide ${current + 1} of ${n}. Swipe, or use the buttons and dots to move between slides.`}>
          {spec.slides.map((_, i) => (
            <div key={i} className="cr-slot" aria-hidden={i !== current}><SlideCanvas spec={spec} index={i} /></div>
          ))}
        </div>
        {current > 0 && <button type="button" className="slide-arrow left" onClick={() => onCurrent(current - 1)} aria-label="Previous slide"><ChevronLeft size={20} /></button>}
        {current < n - 1 && <button type="button" className="slide-arrow right" onClick={() => onCurrent(current + 1)} aria-label="Next slide"><ChevronRight size={20} /></button>}
        <span className="cr-count" aria-hidden="true">{current + 1}/{n}</span>
      </div>
      <div className="cr-dots">
        {spec.slides.map((_, i) => (
          <button key={i} type="button" className={i === current ? "on" : undefined} onClick={() => onCurrent(i)} aria-label={`Show slide ${i + 1}`} aria-current={i === current ? "true" : undefined}><span /></button>
        ))}
      </div>
    </div>
  );
}

/** The themes, each a live tile: a point of this carousel drawn in that theme with this kit. */
function ThemePicker({ spec, onChange }: { spec: CarouselSpec; onChange: (theme: CarouselTheme) => void }) {
  const radio = useRadioKeys(carouselThemeIds, spec.theme, onChange);
  // A point without a picture shows the theme best; else the first point, else the cover.
  const sample = Math.max(0, spec.slides.findIndex((s) => s.kind === "content" && !s.image), spec.slides.findIndex((s) => s.kind === "content"));
  return (
    <div className="style-grid cr-themes" role="radiogroup" aria-label="Theme">
      {carouselThemeIds.map((t, i) => (
        <button key={t} type="button" className="style-tile" {...radio(t, i)} aria-label={`${carouselThemes[t].name}: ${carouselThemes[t].description}`}>
          <SlideCanvas spec={{ ...spec, theme: t }} index={sample} className="cr-tile" />
          <span className="style-name">{carouselThemes[t].name}</span>
          <span className="style-about">{carouselThemes[t].description}</span>
        </button>
      ))}
    </div>
  );
}

/** A colour with what it tends to suggest (a rule of thumb), and an optional "theme's own" choice. */
function ColourField({ label, value, onChange, fallback, onReset }: { label: string; value: string; onChange: (v: string) => void; fallback?: string; onReset?: () => void }) {
  return (
    <div className="cr-colour">
      <label className="row small color-field"><input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} /><span>{label}</span><code>{value.toUpperCase()}</code></label>
      <span className="muted small">{fallback ?? colourMood(value)}</span>
      {onReset && <button type="button" className="btn sm ghost" onClick={onReset}>Use the theme's</button>}
    </div>
  );
}

export function CarouselEditor({ spec, onChange, workspace, creditsLeft }: {
  spec: CarouselSpec; onChange: (spec: CarouselSpec) => void; workspace: Workspace; creditsLeft: number | null;
}) {
  const toast = useToast();
  const { update } = useWorkspace();
  const [current, setCurrent] = useState(0);
  const [picker, setPicker] = useState<null | "slide" | "logo" | "reference">(null);
  const [savingKit, setSavingKit] = useState(false);
  const index = Math.min(current, spec.slides.length - 1), slide = spec.slides[index];
  const set = (patchSpec: Partial<CarouselSpec>) => onChange({ ...spec, ...patchSpec });
  const setSlides = (slides: CarouselSlide[], select = index) => { onChange({ ...spec, slides }); setCurrent(Math.max(0, Math.min(slides.length - 1, select))); };
  const setSlide = (p: Partial<CarouselSlide>) => setSlides(spec.slides.map((s, i) => (i === index ? { ...s, ...p } : s)));
  const setKit = (p: Partial<CarouselKit>) => set({ brand: { ...spec.brand, ...p } });
  // The caption ends with the same call to action as the last slide.
  const setCta = (next: CarouselCta) => set({ cta: next, caption: captionWithCta(spec.caption, next, spec.cta) });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= spec.slides.length) return;
    const slides = [...spec.slides];
    [slides[from], slides[to]] = [slides[to], slides[from]];
    setSlides(slides, to);
  };
  const add = () => {
    // A new point goes after the selected slide, and before a call to action at the end.
    const at = slide.kind === "cta" ? index : index + 1;
    setSlides([...spec.slides.slice(0, at), blankSlide("content"), ...spec.slides.slice(at)], at);
  };
  const pending = pendingMedia(spec).length;
  const perImage = spec.brand.referenceId ? REFERENCE_IMAGE_CREDITS : IMAGE_CREDITS;
  const image = slide.image;
  const [ai, setAi] = useState(false);
  useEffect(() => { setAi(false); }, [index]);
  const saveKit = async () => {
    setSavingKit(true);
    try {
      const r = await patch<{ workspace: Workspace }>(`/workspaces/${workspace.id}`, { settings: { carousel: spec.brand } });
      update(r.workspace);
      toast("Saved. New carousels start with this kit.", "good");
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setSavingKit(false);
    }
  };
  const fonts = spec.brand.fonts;
  return (
    <div className="cr-editor">
      <div className="preview-grid cr-grid">
        <div className="preview-phone">
          <CarouselPhone spec={spec} current={index} onCurrent={setCurrent} />
          <p className="muted small cr-note">The preview uses the fonts and layout of the finished slides.</p>
        </div>
        <div className="inspector stack cr-inspector">
          <ol className="cr-slides" aria-label="Slides">
            {spec.slides.map((s, i) => (
              <li key={i} className={i === index ? "on" : undefined}>
                <button type="button" className="cr-slide-pick" onClick={() => setCurrent(i)} aria-current={i === index ? "true" : undefined}>
                  <span className="cr-slide-n">{i + 1}</span>
                  <span className="cr-slide-text"><span className="cr-kind">{kindNames[s.kind]}{s.image ? " · picture" : ""}</span>{s.title || s.body || "Empty slide"}</span>
                </button>
                <span className="cr-slide-tools">
                  <button type="button" className="btn icon sm ghost" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move slide ${i + 1} up`}><ArrowUp size={14} /></button>
                  <button type="button" className="btn icon sm ghost" disabled={i === spec.slides.length - 1} onClick={() => move(i, i + 1)} aria-label={`Move slide ${i + 1} down`}><ArrowDown size={14} /></button>
                  <button type="button" className="btn icon sm ghost" disabled={spec.slides.length >= CAROUSEL_MAX_SLIDES} onClick={() => setSlides([...spec.slides.slice(0, i + 1), { ...s }, ...spec.slides.slice(i + 1)], i + 1)} aria-label={`Duplicate slide ${i + 1}`}><Copy size={14} /></button>
                  <button type="button" className="btn icon sm ghost" disabled={spec.slides.length <= CAROUSEL_MIN_SLIDES} onClick={() => setSlides(spec.slides.filter((_, k) => k !== i), Math.min(i, spec.slides.length - 2))} aria-label={`Delete slide ${i + 1}`}><Trash2 size={14} /></button>
                </span>
              </li>
            ))}
          </ol>
          <button type="button" className="btn sm" disabled={spec.slides.length >= CAROUSEL_MAX_SLIDES} onClick={add}><Plus size={14} /> Add a slide{spec.slides.length >= CAROUSEL_MAX_SLIDES ? " (10 at most)" : ""}</button>
          <hr />
          <div className="stack cr-fields" style={{ gap: 10 }}>
            <div className="row between"><strong className="small">Slide {index + 1}</strong>
              <label className="row small" style={{ gap: 6 }}><span>Kind</span>
                <select className="select sm" value={slide.kind} onChange={(e) => setSlide({ kind: e.target.value as SlideKind })}>
                  {(Object.keys(kindNames) as SlideKind[]).map((k) => <option key={k} value={k}>{kindNames[k]}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span className="small">{slide.kind === "cover" ? "Hook" : slide.kind === "cta" ? "Closing line" : "Point"}</span>
              <textarea className="textarea" rows={2} maxLength={SLIDE_TITLE_MAX} value={slide.title} onChange={(e) => setSlide({ title: e.target.value })} />
            </label>
            <label className="field"><span className="small">{slide.kind === "content" ? "Explanation" : "Subtitle"} <span className="muted">(optional)</span></span>
              <textarea className="textarea" rows={3} maxLength={SLIDE_BODY_MAX} value={slide.body} onChange={(e) => setSlide({ body: e.target.value })} />
            </label>
            <label className="field"><span className="small">Label</span>
              <input className="input" maxLength={SLIDE_LABEL_MAX} value={slide.label} placeholder={slide.kind === "content" ? `0${index}` : ""} onChange={(e) => setSlide({ label: e.target.value })} />
              <span className="hint">{labelHints[slide.kind]}</span>
            </label>
            <div className="stack" style={{ gap: 6 }}>
              <span className="small">Picture</span>
              {image?.assetId && <div className="row cr-picked"><img src={fileUrl(image.assetId)} alt="" /><span className="small muted grow">{image.prompt ? "AI picture" : "Your picture"}</span></div>}
              {(ai || (image?.prompt && !image.assetId)) && (
                <label className="field"><span className="small">Describe the AI picture <span className="muted">· {creditsLabel(perImage)}</span></span>
                  <textarea className="textarea" rows={3} maxLength={400} value={image?.prompt || ""} placeholder="A striking photo of a laptop on a sunny desk, one clear subject, room for big words"
                    onChange={(e) => setSlide({ image: e.target.value ? { prompt: e.target.value } : undefined })} />
                </label>
              )}
              <div className="row wrap" style={{ gap: 6 }}>
                <button type="button" className="btn sm" onClick={() => setPicker("slide")}><ImagePlus size={14} /> {image?.assetId && !image.prompt ? "Swap picture" : "My picture"}</button>
                <button type="button" className="btn sm" onClick={() => { setAi(true); if (image?.assetId && image.prompt) setSlide({ image: { prompt: image.prompt } }); }}>
                  <Wand2 size={14} /> {image?.assetId && image.prompt ? `New AI picture · ${creditsLabel(perImage)}` : "AI picture"}
                </button>
                {image && <button type="button" className="btn sm ghost" onClick={() => { setAi(false); setSlide({ image: undefined }); }}><X size={14} /> No picture</button>}
              </div>
              {slide.kind === "cover" && <span className="hint">{spec.cover === "image" ? "A bold hook over an eye-catching picture stops the scroll." : "The cover shows its picture under the hook (see Design)."}</span>}
            </div>
          </div>
        </div>
      </div>

      <EditorSection title="Call to action" hint="On the last slide, and at the end of the caption. Ask for one thing.">
        <div className="seg small-seg cr-cta" role="group" aria-label="Call to action">
          {ctaTypes.map((t) => <button key={t} type="button" aria-pressed={spec.cta.type === t} onClick={() => setCta({ type: t, text: ctaPresets[t].text, keyword: t === "comment" ? spec.cta.keyword || "GUIDE" : spec.cta.keyword })}>{ctaPresets[t].name}</button>)}
        </div>
        <div className="row wrap cr-cta-fields">
          <label className="field grow"><span className="small">Words</span>
            <input className="input" maxLength={120} value={spec.cta.text} onChange={(e) => setCta({ ...spec.cta, text: e.target.value })} />
            {spec.cta.type === "comment" && <span className="hint">{KEYWORD} is where the keyword goes.</span>}
          </label>
          {spec.cta.type === "comment" && (
            <label className="field"><span className="small">Keyword</span>
              <input className="input cr-keyword" maxLength={20} value={spec.cta.keyword} onChange={(e) => setCta({ ...spec.cta, keyword: e.target.value.toUpperCase().replace(/[^\p{L}\p{N}_-]/gu, "") })} />
            </label>
          )}
        </div>
        {!spec.slides.some((s) => s.kind === "cta") && <p className="notice small">No slide is a call to action yet: set the last slide's kind to "Call to action".</p>}
        {spec.cta.type === "comment" && <p className="muted small">Sending the link to everyone who comments is up to you: automatic direct messages aren't part of {PRODUCT.name} yet.</p>}
      </EditorSection>

      <EditorSection title="Design" hint="The theme, the shape and the cover. Colours come from your brand kit below; words always stay readable.">
        <ThemePicker spec={spec} onChange={(theme) => set({ theme })} />
        <div className="cr-design-row">
          <div className="seg small-seg" role="group" aria-label="Shape">
            {carouselAspects.map((a) => <button key={a} type="button" aria-pressed={spec.aspect === a} onClick={() => set({ aspect: a })}>{aspectInfo[a].name}</button>)}
          </div>
          <span className="muted small">{aspectInfo[spec.aspect].note}.</span>
        </div>
        <div className="cr-design-row">
          <div className="seg small-seg" role="group" aria-label="Cover">
            <button type="button" aria-pressed={spec.cover === "image"} onClick={() => set({ cover: "image" })}>Picture behind the hook</button>
            <button type="button" aria-pressed={spec.cover === "page"} onClick={() => set({ cover: "page" })}>Picture under the hook</button>
          </div>
        </div>
        <div className="row between"><span className="small">Slide numbers ("3/7")</span><Switch checked={spec.numbers} onChange={(numbers) => set({ numbers })} label="Slide numbers" /></div>
        <div className="row between"><span className="small">"Swipe" on the cover</span><Switch checked={spec.swipe} onChange={(swipe) => set({ swipe })} label="Swipe cue on the cover" /></div>
      </EditorSection>

      <EditorSection title="Brand kit" hint="On every slide of this carousel. Save it to start new carousels with it."
        action={<button type="button" className="btn sm" disabled={savingKit} onClick={saveKit}>{savingKit ? <span className="spinner" /> : <Save size={14} />} Save as my default</button>}>
        <div className="cr-kit">
          <label className="field"><span className="small">Handle or website</span>
            <input className="input" maxLength={40} value={spec.brand.handle} placeholder="@yourbrand" onChange={(e) => setKit({ handle: e.target.value })} />
          </label>
          <div className="stack" style={{ gap: 6 }}>
            <span className="small">Logo</span>
            {workspace.logoAssetId || spec.brand.logoId ? (
              <div className="row between">
                <span className="row small" style={{ gap: 8 }}>{(spec.brand.logoId || workspace.logoAssetId) && <img src={fileUrl(spec.brand.logoId || workspace.logoAssetId)} alt="" className="cr-logo" />}In the footer</span>
                <Switch checked={!!spec.brand.logoId} onChange={(on) => setKit({ logoId: on ? spec.brand.logoId || workspace.logoAssetId || undefined : undefined })} label="Show the logo" />
              </div>
            ) : <button type="button" className="btn sm" onClick={() => setPicker("logo")}><ImagePlus size={14} /> Choose a logo</button>}
          </div>
          <ColourField label="Brand colour" value={spec.brand.primary} onChange={(primary) => setKit({ primary })} />
          <ColourField label="Second colour" value={spec.brand.accent} onChange={(accent) => setKit({ accent })} />
          {spec.brand.background
            ? <ColourField label="Page colour" value={spec.brand.background} onChange={(background) => setKit({ background })} onReset={() => setKit({ background: null })} />
            : <div className="row between"><span className="small">Page colour <span className="muted">· the theme's</span></span><button type="button" className="btn sm" onClick={() => setKit({ background: "#ffffff" })}>Choose</button></div>}
          <div className="row wrap" style={{ gap: 10 }}>
            <label className="field grow"><span className="small">Headings</span>
              <select className="select" value={fonts?.title ?? ""} onChange={(e) => setKit({ fonts: e.target.value ? { title: e.target.value as FontId, body: fonts?.body ?? "regular" } : null })}>
                <option value="">The theme's</option>
                {carouselFonts.map((f) => <option key={f} value={f}>{fontNames[f]}</option>)}
              </select>
            </label>
            <label className="field grow"><span className="small">Text</span>
              <select className="select" value={fonts?.body ?? ""} onChange={(e) => setKit({ fonts: e.target.value ? { title: fonts?.title ?? "sans", body: e.target.value as FontId } : null })}>
                <option value="">The theme's</option>
                {carouselFonts.map((f) => <option key={f} value={f}>{fontNames[f]}</option>)}
              </select>
            </label>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <span className="small">Character or mascot <span className="muted">(optional)</span></span>
            {spec.brand.referenceId ? (
              <div className="row cr-picked"><img src={fileUrl(spec.brand.referenceId)} alt="" /><span className="small grow">Every AI picture keeps this character: {creditsLabel(REFERENCE_IMAGE_CREDITS)} each instead of {IMAGE_CREDITS}.</span>
                <button type="button" className="btn sm ghost" onClick={() => setKit({ referenceId: undefined })}><X size={14} /> Remove</button></div>
            ) : (
              <>
                <button type="button" className="btn sm" onClick={() => setPicker("reference")}><ImagePlus size={14} /> Choose a picture of it</button>
                <span className="hint">A clear picture of one character on a plain background works best. AI pictures with it cost {creditsLabel(REFERENCE_IMAGE_CREDITS)} each.</span>
              </>
            )}
          </div>
        </div>
      </EditorSection>

      <EditorSection title="Plan and price" hint="Text, themes and edits are free. Only new AI pictures use credits, when you save.">
        <div className="cr-price">
          <span>{pending ? `${pending} AI picture${pending === 1 ? "" : "s"} × ${creditsLabel(perImage)}` : "No AI pictures to make"}</span>
          <strong>{creditsLabel(pending * perImage)}</strong>
          {creditsLeft !== null && <span className="muted small">{creditsLabel(creditsLeft)} left</span>}
        </div>
        <p className="muted small">Posts as an Instagram carousel, a TikTok photo post and a LinkedIn multi-image post (YouTube takes videos only). Instagram can't add music to carousels through its API: to add a trending sound, download the slides and post them from the Instagram app.</p>
      </EditorSection>

      {picker && (
        <MediaPicker workspaceId={workspace.id} type="image" allowUpload title={picker === "logo" ? "Choose a logo" : picker === "reference" ? "Choose your character" : "Choose a picture"} onClose={() => setPicker(null)}
          onPick={(a) => {
            if (picker === "slide") setSlide({ image: { assetId: a.id } });
            else if (picker === "logo") setKit({ logoId: a.id });
            else setKit({ referenceId: a.id });
            setPicker(null);
          }} />
      )}
    </div>
  );
}
