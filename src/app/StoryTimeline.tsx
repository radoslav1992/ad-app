import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Captions, Clapperboard, Mic, Music, Pause, Play, ZoomIn, ZoomOut } from "lucide-react";
import { captionGroups, keyWordIndex, type CaptionWord } from "../../shared/captions";
import { FPS, transitionInfo, type StorySegment, type StoryTiming } from "../../shared/story";
import { onFrame } from "./caption-canvas";
import { clockText, type StoryPlayer } from "./story-model";
import type { ScenePicture } from "./StoryPreview";

// The narrated video's timeline, after rech-bg's studio timeline (src/studio/ProjectTimeline.tsx, src/timeline.css):
// the whole voice on one clock with its scenes (their pictures, the edges between them and each transition's overlap),
// the subtitle groups, the voice and the music. An edge drags along the voice and snaps to the pause between two words
// (arrow keys move it a word); clicking a scene or a subtitle selects it and moves the playhead there.

const LABEL = 104;
/** The time of the edge before word `i`: the middle of the pause before it. */
const edgeTime = (words: CaptionWord[], i: number) => (words[i - 1].end + words[i].start) / 2;

export function StoryTimeline({ timing, segments, duration, pictures, thumbs, selected, player, estimated, voiceLabel, music, onSelect, onMoveEdge, onMusic }: {
  timing: StoryTiming; segments: StorySegment[]; duration: number; pictures: ScenePicture[];
  /** A still of each scene for its clip on the timeline (an AI clip's first picture), if any. */
  thumbs: (string | null)[];
  selected: number; player: StoryPlayer; estimated: boolean; voiceLabel: string;
  music: string | null;
  onSelect: (scene: number) => void;
  /** Scene `k` now starts at word `first` of the script. */
  onMoveEdge: (k: number, first: number) => void;
  onMusic: () => void;
}) {
  const [zoom, setZoom] = useState(1), [laneWidth, setLaneWidth] = useState(800);
  const tracks = useRef<HTMLDivElement>(null), playhead = useRef<HTMLDivElement>(null), clock = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = tracks.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setLaneWidth(Math.max(160, el.clientWidth - (el.querySelector<HTMLElement>(".tl-label")?.offsetWidth ?? LABEL) - 30)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const length = Math.max(1, duration);
  const pps = Math.max(8, laneWidth / length) * zoom;
  const lane = { width: `${length * pps + 24}px` };
  const at = (seconds: number, span: number) => ({ left: `${seconds * pps}px`, width: `${Math.max(2, span * pps)}px` });
  const ticks = useMemo(() => {
    const step = pps >= 60 ? 1 : pps >= 25 ? 2 : pps >= 12 ? 5 : 10;
    return Array.from({ length: Math.floor(length / step) + 1 }, (_, i) => i * step);
  }, [length, pps]);
  const { now } = player;
  // The playhead and the time follow the clock on every frame.
  useEffect(() => onFrame(() => {
    const t = now();
    const label = (tracks.current?.querySelector<HTMLElement>(".tl-label")?.offsetWidth ?? LABEL);
    if (playhead.current) playhead.current.style.transform = `translateX(${label + t * pps}px)`;
    if (clock.current) clock.current.textContent = `${clockText(t)} / ${clockText(duration)}`;
  }), [now, pps, duration]);
  const seekFrom = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    player.seek((e.clientX - rect.left) / pps);
  };
  const words = timing.words;
  const groups = useMemo(() => {
    let first = 0;
    return captionGroups(words).map((g) => { const from = first; first += g.length; return { from, words: g, key: keyWordIndex(g) }; });
  }, [words]);
  /** Where scene `k`'s first word may go: after scene k-1's first word, up to scene k's last word. */
  const range = (k: number) => [timing.scenes[k - 1].first + 1, timing.scenes[k].last] as const;
  const dragEdge = (e: ReactPointerEvent<HTMLDivElement>, k: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget, laneEl = el.parentElement!, [lo, hi] = range(k);
    el.setPointerCapture(e.pointerId);
    let current = timing.scenes[k].first;
    const move = (ev: PointerEvent) => {
      const t = (ev.clientX - laneEl.getBoundingClientRect().left) / pps;
      let best = current, gap = Infinity;
      for (let i = lo; i <= hi; i++) { const d = Math.abs(edgeTime(words, i) - t); if (d < gap) { gap = d; best = i; } }
      if (best !== current) { current = best; onMoveEdge(k, best); }
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
  };
  const nudgeEdge = (e: ReactKeyboardEvent, k: number) => {
    const step = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    const [lo, hi] = range(k), next = Math.min(hi, Math.max(lo, timing.scenes[k].first + step));
    if (next !== timing.scenes[k].first) onMoveEdge(k, next);
  };

  // Space plays and pauses anywhere in the timeline; its clips stay native buttons.
  // eslint-disable-next-line jsx-a11y/no-static-element-interactions
  return <div className="st-timeline" onKeyDown={(e) => { if (e.key === " " && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement || (e.target as HTMLElement).getAttribute?.("role") === "slider")) { e.preventDefault(); player.toggle(); } }}>
    <div className="st-timeline-bar">
      <button type="button" className="btn sm tl-play" onClick={player.toggle} aria-label={player.playing ? "Pause" : "Play"}>
        {player.playing ? <Pause size={15} /> : <Play size={15} />} {player.playing ? "Pause" : "Play"}
      </button>
      <span className="tl-timecode" ref={clock} aria-live="off">0:00.0 / {clockText(duration)}</span>
      <span className="st-timeline-title">Timeline</span>
      {estimated && <span className="chip orange">Estimated times until the voice is made</span>}
      <div className="tl-zoom">
        <button type="button" className="btn sm icon" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 1.5))}><ZoomOut size={15} /></button>
        <button type="button" className="btn sm icon" aria-label="Zoom in" disabled={zoom >= 8} onClick={() => setZoom((z) => Math.min(8, z * 1.5))}><ZoomIn size={15} /></button>
      </div>
    </div>
    <div className="tl-tracks" ref={tracks}>
      <div className="tl-inner">
        <div ref={playhead} className="tl-playhead" aria-hidden="true" />
        <div className="tl-row tl-ruler-row"><div className="tl-label" /><div className="tl-lane tl-ruler" style={lane} onPointerDown={seekFrom}>
          {ticks.map((t) => <span key={t} style={{ left: `${t * pps}px` }}>{clockText(t).replace(/\.0$/, "")}</span>)}
        </div></div>

        <div className="tl-row tl-scene-row"><div className="tl-label"><Clapperboard size={14} aria-hidden="true" /> Scenes</div><div className="tl-lane" style={lane} onPointerDown={seekFrom}>
          {timing.scenes.map((s) => {
            const pic = pictures[s.index];
            const kind = "pending" in pic ? "AI picture to make" : pic.kind === "video" ? "clip" : "picture";
            return <button type="button" key={s.index} className={`tl-clip tl-visual${selected === s.index ? " selected" : ""}${"pending" in pic ? " pending" : ""}`} style={{ ...at(s.start, s.end - s.start), ...(thumbs[s.index] && { backgroundImage: `url("${thumbs[s.index]}")` }) }}
              aria-label={`Scene ${s.index + 1}, ${clockText(s.start)} to ${clockText(s.end)}, ${kind}`} aria-pressed={selected === s.index}
              onClick={() => { onSelect(s.index); player.seek(s.start + 0.05); }}>
              <span>{s.index + 1}</span>
            </button>;
          })}
          {/* Each transition's overlap, centred on its edge. */}
          {segments.map((seg) => seg.transition && <span key={`t${seg.scene}`} className="tl-transition" style={at(seg.from / FPS, seg.transition.frames / FPS)} title={transitionInfo[seg.transition.kind].name} aria-hidden="true" />)}
          {timing.scenes.slice(1).map((s) => {
            const [lo, hi] = range(s.index), before = words[s.first - 1];
            return <div key={`e${s.index}`} role="slider" tabIndex={0} className="tl-edge" style={{ left: `${s.start * pps}px` }}
              aria-label={`Edge between scenes ${s.index} and ${s.index + 1}`} aria-valuemin={lo} aria-valuemax={hi} aria-valuenow={s.first}
              aria-valuetext={`Scene ${s.index + 1} starts at “${words[s.first]?.text ?? ""}”, after “${before?.text ?? ""}”, ${clockText(s.start)}`}
              onPointerDown={(e) => dragEdge(e, s.index)} onKeyDown={(e) => nudgeEdge(e, s.index)} />;
          })}
        </div></div>

        <div className="tl-row"><div className="tl-label"><Captions size={14} aria-hidden="true" /> Words</div><div className="tl-lane" style={lane} onPointerDown={seekFrom}>
          {groups.map((g) => {
            const scene = timing.scenes.findIndex((s) => g.from >= s.first && g.from <= s.last);
            return <button type="button" key={g.from} className={`tl-clip tl-caption${scene === selected ? " selected" : ""}`} style={at(g.words[0].start, g.words.at(-1)!.end - g.words[0].start)}
              title={g.words.map((w) => w.text).join(" ")} onClick={() => { onSelect(Math.max(0, scene)); player.seek(g.words[0].start); }}>
              <span>{g.words.map((w, i) => <Fragment key={i}>{i ? " " : ""}{i === g.key ? <b>{w.text}</b> : w.text}</Fragment>)}</span>
            </button>;
          })}
        </div></div>

        <div className="tl-row"><div className="tl-label"><Mic size={14} aria-hidden="true" /> Voice</div><div className="tl-lane" style={lane} onPointerDown={seekFrom}>
          <div className={`tl-clip tl-voice${estimated ? " estimated" : ""}`} style={at(0, duration)}><span>{voiceLabel}</span></div>
        </div></div>

        <div className="tl-row"><div className="tl-label"><Music size={14} aria-hidden="true" /> Music</div><div className="tl-lane" style={lane} onPointerDown={seekFrom}>
          {music
            ? <button type="button" className="tl-clip tl-music" style={at(0, duration)} onClick={onMusic}><span>{music} · quieter under the voice</span></button>
            : <button type="button" className="tl-add" onClick={onMusic}><Music size={13} aria-hidden="true" /> Add music</button>}
        </div></div>
      </div>
    </div>
  </div>;
}
