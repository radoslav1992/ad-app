import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Clapperboard, Film, Image as ImageIcon, Library, Pencil, RefreshCw, Sparkles, Trash2, Video } from "lucide-react";
import { api, errorText, fileUrl, newKey, post, put, seconds as clock, useAuth, type Asset, type LibraryItem } from "../lib";
import { Switch, useToast } from "../ui";
import { EditorSection } from "./CaptionPickers";
import { LibraryPicker, MediaPicker } from "./pickers";
import type { PreviewCutaway } from "./TextPreview";
import { recordingCurrent, specCredits, specSchema, type Spec, type UgcSpec } from "../../shared/formats";
import {
  brollCredits, brollSources, estimatedWords, placeShots, sourceCredits, type Broll, type BrollShot, type BrollSkip, type BrollSource, type PlannedShot,
} from "../../shared/broll";
import { motionFor } from "../../shared/layers";
import { creditsLabel } from "../../shared/credits";
import "./broll.css";

// AI B-roll in the editor, ported from rech-bg's studio ("B-roll с AI", src/studio/AutoBroll.tsx): "Plan B-roll" asks
// for moments from the script (free) and shows them with their shot descriptions, source and price; only "Add B-roll"
// puts them in the post. A saved post is saved at once and its run makes the shots (paid once, refunded on failure);
// a new draft makes them when it is saved & built.

type ShotMedia = { url: string; kind: "image" | "video"; name: string };
const sourceNames: Record<BrollSource, string> = { image: "AI image", clip: "AI clip", own: "My media" };
const sourceIcons: Record<BrollSource, typeof ImageIcon> = { image: ImageIcon, clip: Film, own: Library };
const skipText: Record<BrollSkip, string> = {
  missing: "its sentence is no longer in the script",
  hook: "the opening stays on your creator",
  closing: "the last sentence stays on your creator",
  short: "too little time before the end",
  crowded: "too close to another shot",
  pending: "not made yet",
};
/** What one shot still costs (nothing once made, for own media, or when it can never be shown). */
const shotCost = (shot: BrollShot, script: string) => brollCredits({ enabled: true, style: "", shots: [shot] }, script);

/**
 * An AI UGC post's B-roll on its clock: the recording's word timings when they match the script (else estimates from
 * the script), where each shot is cut in or why not, the shots' pictures, and the cut-aways the preview plays.
 */
export function useBroll(spec: Spec | null, duration?: number) {
  const ugc = spec?.format === "ugc" ? spec : null;
  const broll = ugc?.broll, script = ugc?.script || "";
  const recorded = ugc && recordingCurrent(ugc) && ugc.generated?.words.length ? ugc.generated.words : null;
  const words = useMemo(() => recorded || estimatedWords(script), [recorded, script]);
  const seconds = recorded && duration ? duration : (words.at(-1)?.end ?? 0) + 0.5;
  const placement = useMemo(() => placeShots(broll?.shots || [], script, words, seconds), [broll, script, words, seconds]);
  const [known, setKnown] = useState<Record<string, ShotMedia>>({});
  const asked = useRef(new Set<string>());
  const remember = useCallback((id: string, m: ShotMedia) => setKnown((k) => ({ ...k, [id]: m })), []);
  // Own files and library clips in the shots: whether each is a picture or a clip, and where to show it.
  useEffect(() => {
    for (const s of broll?.shots || []) {
      const id = s.source === "own" ? s.assetId : undefined;
      if (!id || asked.current.has(id)) continue;
      asked.current.add(id);
      void api<{ asset: Asset }>(`/media/${id}`)
        .then(({ asset }) => remember(id, { url: asset.url, kind: asset.mime.startsWith("video/") ? "video" : "image", name: asset.name })).catch(() => {});
    }
    if (broll?.shots.some((s) => s.libraryId) && !asked.current.has("library")) {
      asked.current.add("library");
      void api<{ items: LibraryItem[] }>("/library?kind=clip")
        .then(({ items }) => items.forEach((i) => remember(i.id, { url: i.url, kind: "video", name: i.name }))).catch(() => {});
    }
  }, [broll, remember]);
  const media = useCallback((s: BrollShot): ShotMedia | null => {
    if (s.libraryId) return known[s.libraryId] || null;
    if (!s.assetId) return null;
    if (s.source === "own") return known[s.assetId] || null;
    return { url: fileUrl(s.assetId), kind: s.source === "clip" ? "video" : "image", name: "" };
  }, [known]);
  // The preview plays the cut-aways on the recording's clock (until then the strip shows where they will go).
  const cutaways = useMemo<PreviewCutaway[]>(() => (!recorded || !broll?.enabled ? [] : placement.cuts.map((c, n) => {
    const shot = broll.shots[c.shot], m = media(shot);
    const still = m ? m.kind === "image" : shot.source !== "clip";
    return { start: c.start, end: c.end, label: shot.description, ...(m && { url: m.url, kind: m.kind }), ...(still && { motion: motionFor(n) }) };
  })), [recorded, broll, placement, media]);
  return { recorded: !!recorded, words, seconds, placement, media, remember, cutaways };
}
export type BrollState = ReturnType<typeof useBroll>;

/** Under the preview: where the picture cuts away to B-roll, on the video's clock. */
export function BrollStrip({ spec, state }: { spec: UgcSpec; state: BrollState }) {
  if (!spec.broll?.enabled || !spec.broll.shots.length) return null;
  const { cuts } = state.placement, total = Math.max(1, state.seconds);
  const label = cuts.length ? `B-roll at ${cuts.map((c) => `${clock(c.start)} to ${clock(c.end)}`).join(", ")} of ${clock(total)}` : "No B-roll can be shown yet";
  return (
    <div className="broll-strip">
      <div className="broll-track" role="img" aria-label={label}>
        {cuts.map((c) => (
          <span key={c.shot} className="broll-cut" style={{ left: `${(c.start / total) * 100}%`, width: `${((c.end - c.start) / total) * 100}%` }}>{c.shot + 1}</span>
        ))}
      </div>
      <div className="broll-legend" aria-hidden="true">
        <span>0:00</span>
        <span><i className="creator" /> Creator <i className="cut" /> B-roll{state.recorded ? "" : " (estimated)"}</span>
        <span>{clock(total)}</span>
      </div>
    </div>
  );
}

function Thumb({ media, source }: { media: ShotMedia | null; source: BrollSource }) {
  const Icon = sourceIcons[source];
  if (!media) return <span className="broll-thumb empty" aria-hidden="true"><Icon size={16} /></span>;
  return media.kind === "video"
    ? <video className="broll-thumb" src={media.url} muted playsInline preload="metadata" aria-hidden="true" />
    : <img className="broll-thumb" src={media.url} alt="" />;
}

type DraftShot = BrollShot & { use: boolean };
type Draft = { style: string; shots: DraftShot[] };

/** The B-roll section of the AI UGC editor: plan, review and price, add; then switch it off and on, or edit. */
export function BrollPanel({ spec, workspaceId, postId, premium, state, onChange }: {
  spec: UgcSpec; workspaceId: string;
  /** A saved post gets its B-roll at once (saved, made again); a new draft when it is saved & built. */
  postId?: string;
  /** The creator is the owner's own (it costs more per second when a new recording is needed). */
  premium: boolean;
  state: BrollState;
  onChange: (broll: Broll | undefined) => void;
}) {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"" | "plan" | "add">("");
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<null | { shot: number; type: "image" | "video" } | { shot: number; library: true }>(null);
  const [key, setKey] = useState(newKey);
  const broll = spec.broll, script = spec.script;

  const plan = async () => {
    setBusy("plan");
    setError("");
    try {
      const p = await post<{ style: string; shots: PlannedShot[] }>("/broll/plan", { workspaceId, postId, script });
      // Images by default: the cheapest, and they move slowly like a camera would.
      setDraft({ style: p.style, shots: p.shots.map((s) => ({ sentence: s.sentence, description: s.description, source: "image", use: true })) });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const change = (i: number, patch: Partial<DraftShot>) => setDraft((d) => d && { ...d, shots: d.shots.map((s, n) => (n === i ? { ...s, ...patch } : s)) });
  const chosen = useMemo(() => (draft?.shots || []).filter((s) => s.use).map(({ use: _use, ...s }) => s), [draft]);
  const next: Broll = { enabled: true, style: draft?.style.trim() || "", shots: chosen };
  const cost = brollCredits(next, script);
  // A saved post is saved with any other edits too: a changed script also needs a new recording.
  const total = postId ? specCredits({ ...spec, broll: next }, premium ? "custom" : "library") : cost;
  const remaining = user ? Math.max(0, user.limit - user.used) : 0;
  const ready = chosen.length > 0 && chosen.every((s) => s.description.trim().length >= 3 && (s.source !== "own" || s.assetId || s.libraryId));
  const placed = draft ? placeShots(draft.shots, script, state.words, state.seconds, (i) => draft.shots[i].use) : null;

  const add = async () => {
    if (!draft || !ready) return;
    if (!postId) {
      onChange(next);
      setDraft(null);
      toast("B-roll added. Its shots are made when you save & build.", "good");
      return;
    }
    const parsed = specSchema.safeParse({ ...spec, broll: next });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message || "Check the post's fields."); return; }
    setBusy("add");
    setError("");
    try {
      await put(`/posts/${postId}`, { spec: parsed.data, idempotencyKey: key });
      onChange(next);
      toast("B-roll added. Your post is being made again — it'll be ready in a few minutes.", "good");
      void refresh();
      navigate("/app/content");
    } catch (e) {
      // A network failure may have saved it: keep the key so a retry cannot charge twice.
      if (!(e instanceof TypeError)) setKey(newKey());
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  };

  const pickers = picker && (
    "library" in picker
      ? <LibraryPicker kind="clip" onClose={() => setPicker(null)}
        onPick={(i) => { state.remember(i.id, { url: i.url, kind: "video", name: i.name }); change(picker.shot, { libraryId: i.id, assetId: undefined }); setPicker(null); }} />
      : <MediaPicker workspaceId={workspaceId} type={picker.type} allowUpload onClose={() => setPicker(null)}
        onPick={(a) => { state.remember(a.id, { url: a.url, kind: a.mime.startsWith("video/") ? "video" : "image", name: a.name }); change(picker.shot, { assetId: a.id, libraryId: undefined }); setPicker(null); }} />
  );
  const failure = error && <p className="notice bad small" role="alert">{error}</p>;

  if (draft && placed) {
    return (
      <EditorSection title="B-roll" hint="Each shot covers its sentence for 3–5 seconds while the voice goes on. The opening and the last sentence stay on your creator.">
        <label className="field"><span className="small">Look of the AI shots <span className="muted">(for shots still to be made)</span></span>
          <input className="input" maxLength={200} value={draft.style} placeholder="e.g. warm natural light, soft colours"
            onChange={(e) => setDraft({ ...draft, style: e.target.value })} />
        </label>
        <ol className="broll-shots">
          {draft.shots.map((s, i) => {
            const cut = placed.cuts.find((c) => c.shot === i), skip = placed.skipped.find((x) => x.shot === i)?.reason;
            const price = shotCost(s, script), made = s.source !== "own" && !!s.assetId;
            return (
              <li key={i} className={s.use ? "broll-shot" : "broll-shot off"}>
                <label className="broll-check">
                  <input type="checkbox" checked={s.use} onChange={(e) => change(i, { use: e.target.checked })} />
                  <span><strong>Shot {i + 1}{cut ? ` · ${clock(cut.start)}–${clock(cut.end)}` : ""}</strong> “{s.sentence}”</span>
                </label>
                {s.use && skip && skip !== "pending" && <p className="small broll-warn">Not shown: {skipText[skip]}.</p>}
                <textarea className="textarea" rows={2} maxLength={300} value={s.description} disabled={!s.use} aria-label={`What shot ${i + 1} shows`}
                  // A new description is a new shot: a made picture no longer fits it.
                  onChange={(e) => change(i, { description: e.target.value, ...(s.source !== "own" && { assetId: undefined }) })} />
                <div className="seg small-seg broll-sources" role="group" aria-label={`Source of shot ${i + 1}`}>
                  {brollSources.map((src) => {
                    const Icon = sourceIcons[src];
                    return (
                      <button key={src} type="button" aria-pressed={s.source === src} disabled={!s.use}
                        onClick={() => s.source !== src && change(i, { source: src, assetId: undefined, libraryId: undefined })}>
                        <Icon size={14} aria-hidden="true" /> {sourceNames[src]}
                        <small>{src === "own" ? "Free" : creditsLabel(sourceCredits(src))}</small>
                      </button>
                    );
                  })}
                </div>
                {s.use && s.source === "own" && (
                  <div className="broll-own">
                    <Thumb media={state.media(s)} source="own" />
                    <span className="small truncate">{state.media(s)?.name || (s.assetId || s.libraryId ? "Chosen" : "Choose a picture or clip")}</span>
                    <button type="button" className="btn sm" onClick={() => setPicker({ shot: i, type: "image" })}><ImageIcon size={14} /> Image</button>
                    <button type="button" className="btn sm" onClick={() => setPicker({ shot: i, type: "video" })}><Video size={14} /> Video</button>
                    <button type="button" className="btn sm" onClick={() => setPicker({ shot: i, library: true })}><Film size={14} /> Library clip</button>
                  </div>
                )}
                {s.use && made && <span className="small muted">Made · kept with the post</span>}
                {s.use && s.source !== "own" && !made && !price && <span className="small muted">Not made: it can't be shown</span>}
              </li>
            );
          })}
        </ol>
        <p className="small">
          <strong>{chosen.length} shot{chosen.length === 1 ? "" : "s"} · {cost ? creditsLabel(cost) : "no credits"}</strong>
          {!postId ? " · made when you save & build" : total > cost ? ` · ${creditsLabel(total)} with the new voice and video for your edited script` : ""}
          {` · you have ${creditsLabel(remaining)}`}
        </p>
        {total > remaining && <p className="notice warn small">Not enough credits for all of these. Untick a shot, use images or your own media, or <Link to="/app/billing">upgrade</Link>.</p>}
        {failure}
        <div className="broll-actions">
          <button type="button" className="btn sm ghost" onClick={() => { setDraft(null); setError(""); }} disabled={busy !== ""}>Cancel</button>
          <button type="button" className="btn sm" onClick={plan} disabled={busy !== ""}>{busy === "plan" ? <span className="spinner" /> : <RefreshCw size={14} />} New suggestions</button>
          <button type="button" className="btn primary sm" onClick={add} disabled={busy !== "" || !ready || total > remaining || !user?.verified}>
            {busy === "add" ? <span className="spinner" /> : <Sparkles size={15} />} {postId ? `Add B-roll${total ? ` · ${creditsLabel(total)}` : ""}` : "Add to post"}
          </button>
        </div>
        {pickers}
      </EditorSection>
    );
  }

  if (!broll) {
    return (
      <EditorSection title="B-roll" hint="Cut away from your creator to shots of what they're talking about, while their voice keeps going. Planning is free; you see the price before anything is made."
        action={<button type="button" className="btn sm" onClick={plan} disabled={busy !== "" || script.trim().length < 20}>
          {busy === "plan" ? <span className="spinner" /> : <Clapperboard size={14} />} Plan B-roll
        </button>}>
        {busy === "plan" && <p className="small muted" role="status">Picking moments from the script…</p>}
        {failure}
      </EditorSection>
    );
  }

  const { cuts, skipped } = state.placement;
  return (
    <EditorSection title="B-roll"
      hint={broll.enabled
        ? `${cuts.length} of ${broll.shots.length} shot${broll.shots.length === 1 ? "" : "s"} cut in while your creator talks.`
        : "Off: the post shows only your creator. Made shots stay with the post, so turning B-roll on again is free."}
      action={<Switch checked={broll.enabled} onChange={(enabled) => onChange({ ...broll, enabled })} label="Show B-roll" />}>
      <ul className={broll.enabled ? "broll-list" : "broll-list off"}>
        {broll.shots.map((s, i) => {
          const cut = cuts.find((c) => c.shot === i), skip = skipped.find((x) => x.shot === i)?.reason;
          const price = shotCost(s, script);
          return (
            <li key={i}>
              <Thumb media={state.media(s)} source={s.source} />
              <div>
                <strong className="small">Shot {i + 1}{cut ? ` · ${clock(cut.start)}–${clock(cut.end)}` : ""} · {sourceNames[s.source]}</strong>
                <p className="small muted">“{s.sentence}”</p>
                {s.source === "own" ? <span className="chip">Your media</span>
                  : s.assetId ? <span className="chip green">Made</span>
                    : price ? <span className="chip orange">Made when you save · {creditsLabel(price)}</span> : null}
                {broll.enabled && skip && skip !== "pending" && <span className="chip red">Not shown: {skipText[skip]}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {failure}
      <div className="broll-actions">
        <button type="button" className="btn sm" onClick={() => setDraft({ style: broll.style, shots: broll.shots.map((s) => ({ ...s, use: true })) })}><Pencil size={14} /> Edit shots</button>
        <button type="button" className="btn sm ghost" onClick={() => onChange(undefined)}><Trash2 size={14} /> Remove B-roll</button>
      </div>
      {postId && <p className="small muted">Switching B-roll off or on again re-renders the post for free when you save.</p>}
    </EditorSection>
  );
}
