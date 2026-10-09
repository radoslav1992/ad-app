import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { post } from "../lib";
import { narrationCurrent, type StorySpec } from "../../shared/formats";
import { estimatedTimings, storyScript, storySegments, storyTiming, textWords, type StoryTiming } from "../../shared/story";
export { mergeScenes, moveEdge, splitScene, toggleKey } from "../../shared/story";
import type { CaptionWord } from "../../shared/captions";
import type { SpeechStatus } from "../../shared/speech";

// The narrated-video editor's model: the words on the voice's clock (recorded, transcribed, aligned or estimated), the
// same scene timing and transition overlaps the render uses, and the edits a timeline makes (shared/story.ts: scene
// edges moved word by word, split, merge), which only ever move words between scenes.

/** An owner's recording as the editor knows it: its words (transcript or aligned script) and where finding them stands. */
export type UploadTiming = { words: CaptionWord[]; source: "script" | "transcript" | "none"; speech: SpeechStatus | null; duration: number };

/**
 * The words of an owner's recording, from POST /api/story/timing: the transcript (checked again every few seconds
 * while speech is still being found), or, after `align(script)`, the script's words timed by forced alignment.
 */
export function useUploadTiming(assetId: string | undefined, script: string) {
  const [timing, setTiming] = useState<UploadTiming | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const asked = useRef("");
  const load = useCallback(async (withScript: string) => {
    if (!assetId) return;
    setBusy(true);
    setError("");
    try {
      const r = await post<UploadTiming>("/story/timing", { assetId, script: withScript });
      setTiming(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't read the words of this recording.");
    } finally {
      setBusy(false);
    }
  }, [assetId]);
  useEffect(() => {
    const key = `${assetId}:${script}`;
    if (!assetId || asked.current === key) return;
    asked.current = key;
    setTiming(null);
    void load(script);
  }, [assetId, script, load]);
  // While the recording is still being listened to, ask again.
  useEffect(() => {
    if (!assetId || timing?.speech !== "pending" || timing.source === "script") return;
    const t = setTimeout(() => void load(""), 4000);
    return () => clearTimeout(t);
  }, [assetId, timing, load]);
  return { timing, busy, error, align: load };
}

export type StoryClock = {
  /** The voice's words on its clock (empty: none known). */
  said: CaptionWord[];
  duration: number;
  /** Where the times come from: the made voice, an owner's recording, or an estimate from the script. */
  source: "voice" | "recording" | "estimate";
  timing: StoryTiming;
};
/** The scenes on the voice's clock, exactly as the render will place them (estimated before the voice is made). */
export function useStoryClock(spec: StorySpec, upload: UploadTiming | null, renderedSeconds?: number): StoryClock {
  const script = storyScript(spec.scenes);
  const recorded = narrationCurrent(spec) && spec.generated?.words.length ? spec.generated.words : null;
  return useMemo(() => {
    let said: CaptionWord[], duration: number, source: StoryClock["source"];
    if (spec.narration.kind === "upload") {
      said = upload?.words || [];
      duration = upload?.duration || (said.at(-1)?.end ?? 0) + 0.5;
      source = "recording";
    } else if (recorded) {
      said = recorded;
      duration = renderedSeconds || recorded.at(-1)!.end + 0.3;
      source = "voice";
    } else {
      said = estimatedTimings(textWords(script));
      duration = (said.at(-1)?.end ?? 1) + 0.5;
      source = "estimate";
    }
    duration = Math.max(1, duration);
    return { said, duration, source, timing: storyTiming(spec.scenes, said, duration) };
  }, [spec.narration.kind, spec.scenes, upload, recorded, renderedSeconds, script]);
}
export const segmentsOf = (spec: StorySpec, timing: StoryTiming) => storySegments(timing, spec.scenes.map((s) => s.transition));

/** "0:07.5" */
export const clockText = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${(Math.max(0, seconds) % 60).toFixed(1).padStart(4, "0")}`;

/** One clock for the preview and the timeline: the voice (when there is one to play) or a timer (an estimate). */
export function useStoryPlayer(duration: number) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const timer = useRef({ at: 0, started: 0 });
  const [playing, setPlaying] = useState(false);
  const now = useCallback(() => {
    const a = audio.current;
    if (a && a.src && a.readyState >= 1) return Math.min(duration, a.currentTime);
    if (!playing) return timer.current.at;
    const t = timer.current.at + (performance.now() - timer.current.started) / 1000;
    return Math.min(duration, t);
  }, [duration, playing]);
  const pause = useCallback(() => {
    timer.current.at = now();
    audio.current?.pause();
    setPlaying(false);
  }, [now]);
  const play = useCallback(() => {
    if (now() >= duration - 0.05) { timer.current.at = 0; if (audio.current) audio.current.currentTime = 0; }
    timer.current.started = performance.now();
    const a = audio.current;
    if (a && a.src) void a.play().catch(() => setPlaying(false));
    setPlaying(true);
  }, [now, duration]);
  const seek = useCallback((t: number) => {
    const at = Math.min(Math.max(0, t), duration);
    timer.current = { at, started: performance.now() };
    if (audio.current && audio.current.readyState >= 1) audio.current.currentTime = at;
  }, [duration]);
  // The timer stops at the end like the voice does.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => { if (now() >= duration - 0.01) { pause(); seek(duration); } }, 200);
    return () => clearInterval(id);
  }, [playing, now, duration, pause, seek]);
  return { audio, now, play, pause, seek, playing, toggle: () => (playing ? pause() : play()), duration };
}
export type StoryPlayer = ReturnType<typeof useStoryPlayer>;
