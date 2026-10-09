import { useMemo } from "react";
import { Switch } from "../ui";
import { seconds } from "../lib";
import { TextPreview } from "./TextPreview";
import { styledCaptions, type CaptionWord } from "../../shared/captions";
import { cutWords, keptDuration, windowCuts, type KeepRange } from "../../shared/cuts";
import { clipWords } from "../../shared/speech";
import { CLIP_MAX_SECONDS, CLIP_MIN_SECONDS, CLIP_TITLE_SECONDS, trackKey, type ClipSpec, type Cuts } from "../../shared/formats";

// The clip format in the editor (Create's Clip tab and the Clips page): a preview that cuts, frames and captions the
// moment exactly as server/render-plan.ts does (shared/cuts.ts, shared/track.ts), and its controls.

/** What the editor knows of a clip's video: its link, length, and the words heard in it (on its own clock). */
export type ClipSource = { url: string; duration: number; words: CaptionWord[] };

/** The parts of [start, start + length) of a recording that instant cuts keep, on its own clock; null without cuts. */
export function previewCuts(words: CaptionWord[], start: number, length: number, cuts: Cuts): KeepRange[] | null {
  return cuts.enabled && words.length ? windowCuts(words, start, length, { maxPause: 0.6, fillers: cuts.fillers }) : null;
}

/** A clip as it will be made: the moment cut, framed on the speaker (once measured), its captions and title. */
export function ClipPreview({ spec, source }: { spec: ClipSpec; source: ClipSource | null }) {
  const start = spec.source.start;
  const length = Math.max(1, Math.min(spec.source.end, source?.duration || spec.source.end) - start);
  const words = source?.words;
  const { enabled, fillers } = spec.cuts;
  const keep = useMemo(() => previewCuts(words || [], start, length, { enabled, fillers }), [words, start, length, enabled, fillers]);
  // The preview plays the kept parts on the video's own clock (without cuts, the whole moment), and loops.
  const played = useMemo<KeepRange[]>(() => (keep || [[0, length]]).map(([a, b]) => [a + start, b + start]), [keep, start, length]);
  const spoken = useMemo(() => cutWords(clipWords(words || [], start, length, 0), keep), [words, start, length, keep]);
  const { enabled: captionsOn, style } = spec.captions;
  const captions = useMemo(() => (captionsOn && spoken.length ? styledCaptions(spoken, style) : null), [captionsOn, style, spoken]);
  const track = spec.follow && spec.tracked?.key === trackKey(spec) ? spec.tracked.track.points : null;
  const total = keptDuration(keep, length);
  return (
    <TextPreview blocks={[{ text: spec.hook, look: spec.hookLook, start: 0, end: Math.min(CLIP_TITLE_SECONDS, total) }]} seconds={total}
      replay={`${spec.hookLook.animation}:${start}:${spec.source.end}`} videoClock={!!source} sound
      background={source ? { url: source.url, kind: "video", start: played[0][0], keep: played, track } : { color: "#1e2433" }} captions={captions} />
  );
}

/** "Remove pauses" (and filler words) for a talking clip, with what it does to the length. */
export function CutsField({ cuts, onChange, before, after }: { cuts: Cuts; onChange: (c: Cuts) => void; before: number; after: number }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between small">
        <span><strong>Remove pauses</strong><br /><span className="muted">{cuts.enabled ? `${seconds(before)} → ${seconds(after)}` : "Cut long silences out"}</span></span>
        <Switch checked={cuts.enabled} onChange={(enabled) => onChange({ ...cuts, enabled })} label="Remove pauses" />
      </div>
      {cuts.enabled && (
        <div className="row between small">
          <span>Filler words too <span className="muted">(um, uh)</span></span>
          <Switch checked={cuts.fillers} onChange={(fillers) => onChange({ ...cuts, fillers })} label="Remove filler words" />
        </div>
      )}
    </div>
  );
}

/** The inspector of a clip: the moment (start and length), cuts and following the speaker. */
export function ClipInspector({ spec, source, onChange }: { spec: ClipSpec; source: ClipSource | null; onChange: (s: Partial<ClipSpec>) => void }) {
  const duration = source?.duration || spec.source.end;
  const { start, end } = spec.source, length = end - start;
  const keep = previewCuts(source?.words || [], start, length, spec.cuts);
  const move = (from: number, span: number) => {
    const s = Math.max(0, Math.min(from, duration - CLIP_MIN_SECONDS));
    onChange({ source: { ...spec.source, start: Math.round(s * 10) / 10, end: Math.round(Math.min(duration, s + span) * 10) / 10 } });
  };
  return (
    <div className="stack" style={{ gap: 10 }}>
      <strong className="small">Moment</strong>
      <label className="field"><span className="small">Starts at {seconds(start)}</span>
        <input type="range" min={0} max={Math.max(0, Math.floor(duration - CLIP_MIN_SECONDS))} step={0.5} value={start} onChange={(e) => move(Number(e.target.value), length)} />
      </label>
      <label className="field"><span className="small">Length: {Math.round(length)} s</span>
        <input type="range" min={CLIP_MIN_SECONDS} max={CLIP_MAX_SECONDS} step={1} value={Math.round(length)} onChange={(e) => move(start, Number(e.target.value))} />
      </label>
      <hr />
      {source?.words.length
        ? <CutsField cuts={spec.cuts} onChange={(cuts) => onChange({ cuts })} before={length} after={keptDuration(keep, length)} />
        : <p className="muted small">Pauses can be cut once the video's speech is found.</p>}
      <div className="row between small">
        <span><strong>Follow the speaker</strong><br /><span className="muted">Keeps their face in the vertical frame</span></span>
        <Switch checked={spec.follow} onChange={(follow) => onChange({ follow })} label="Follow the speaker" />
      </div>
      {spec.follow && spec.tracked?.key !== trackKey(spec) && <p className="muted small">The speaker is found when the clip is made. Until then the preview shows the middle.</p>}
    </div>
  );
}
