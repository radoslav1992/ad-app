import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AudioLines, Check, Clapperboard, Film, Pencil, Play, Rocket, Scissors, Sparkles } from "lucide-react";
import { Spinner, Switch, useToast } from "../ui";
import { api, errorText, newKey, number, post, seconds, useAuth, usePoll, type Asset } from "../lib";
import { useCurrentWorkspace } from "./workspace";
import { CreditBlockNotice, MediaPicker, creditBlock, useRetryKey, useSignedInUser } from "./pickers";
import { CaptionStylePicker, EditorSection } from "./CaptionPickers";
import { ClipPreview, previewCuts } from "./clip-editor";
import { specSchema, type ClipSpec } from "../../shared/formats";
import { creditsLabel, speechCredits } from "../../shared/credits";
import { keptDuration } from "../../shared/cuts";
import { planById } from "../../shared/plans";
import { SPEECH_MAX_SECONDS, type Transcript } from "../../shared/speech";
import { defaultClipOptions, momentSpec, MOMENT_COUNTS, type ClipOptions, type Moment } from "../../shared/shorts";
import "./pages.css";
import "./create.css";
import "./clips.css";

// Clips from a long video (ported from rech-bg's "Кратки клипове", ShortsTool): pick a podcast, webinar or demo call,
// have its speech transcribed (free up to 10 minutes, credits for longer ones), let the writer find its strongest
// moments, and send the chosen ones to Blitz as clips: cut, framed on the speaker, with captions and a hook title.

type Video = Asset & { transcript?: Transcript | null; moments?: Moment[] };
type Made = { state: "making" | "made" | "failed"; id?: string; error?: string };
const VIDEO_KEY = "hs-clips-video";
const remembered = () => { try { return localStorage.getItem(VIDEO_KEY); } catch { return null; } };
const remember = (id: string | null) => { try { if (id) localStorage.setItem(VIDEO_KEY, id); else localStorage.removeItem(VIDEO_KEY); } catch { /* private mode */ } };
const momentKey = (m: Moment) => `${m.start}-${m.end}`;

export function ClipsPage() {
  const user = useSignedInUser();
  const { refresh } = useAuth();
  const workspace = useCurrentWorkspace();
  const toast = useToast();
  const retry = useRetryKey();
  const [video, setVideo] = useState<Video | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<"" | "speech" | "find" | "make">("");
  const [problem, setProblem] = useState<string | null>(null);
  const [count, setCount] = useState<number>(5);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [options, setOptions] = useState<ClipOptions>(defaultClipOptions);
  const [words, setWords] = useState<Record<string, Transcript["words"]>>({});
  const [made, setMade] = useState<Record<string, Made>>({});
  const keys = useRef(new Map<string, string>());

  /** The video with its speech status and last moments (no transcript: moments load their own words). */
  const load = useCallback(async (id: string) => {
    const { asset } = await api<{ asset: Video }>(`/media/${id}?from=0&to=0`);
    setVideo(asset);
    return asset;
  }, []);
  const choose = useCallback(async (id: string) => {
    setProblem(null); setMade({}); setWords({});
    try {
      const asset = await load(id);
      remember(asset.id);
      setMoments(asset.moments || []);
      setChosen(new Set((asset.moments || []).map(momentKey)));
      setFocus(asset.moments?.[0] ? momentKey(asset.moments[0]) : null);
    } catch {
      remember(null);
      setVideo(null);
    }
  }, [load]);
  useEffect(() => { const id = remembered(); if (id) void choose(id); }, [choose]);
  // While a video is being checked or listened to, look again every few seconds.
  usePoll(() => { if (video) void load(video.id).catch(() => {}); }, 4000, !!video && (video.status === "checking" || video.speech === "pending"));

  const focused = moments.find((m) => momentKey(m) === focus) || null;
  // The words of the moment being previewed (a long video's transcript is loaded a moment at a time).
  useEffect(() => {
    if (!video || !focused || words[momentKey(focused)]) return;
    void api<{ asset: Video }>(`/media/${video.id}?from=${focused.start}&to=${focused.end}`)
      .then(({ asset }) => setWords((w) => ({ ...w, [momentKey(focused)]: asset.transcript?.words || [] }))).catch(() => {});
  }, [video, focused, words]);

  const long = !!video && video.duration > SPEECH_MAX_SECONDS;
  const cost = video && long ? speechCredits(video.duration) : 0;
  const block = long ? creditBlock(user, cost) : null;
  const findSpeech = async () => {
    if (!video) return;
    setBusy("speech"); setProblem(null);
    try {
      if (long) {
        const body = { video: video.id, credits: cost };
        await post(`/media/${video.id}/transcribe`, { idempotencyKey: retry.key(body), credits: cost });
        retry.settle();
        void refresh();
      } else await post(`/media/${video.id}/speech`);
      await load(video.id);
    } catch (e) {
      retry.settle(e);
      setProblem(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const find = async () => {
    if (!video) return;
    setBusy("find"); setProblem(null);
    try {
      const r = await post<{ moments: Moment[] }>("/shorts/moments", { workspaceId: workspace.id, assetId: video.id, count });
      setMoments(r.moments); setChosen(new Set(r.moments.map(momentKey))); setFocus(momentKey(r.moments[0])); setMade({});
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const specOf = (m: Moment) => {
    const parsed = specSchema.safeParse(momentSpec(video!.id, m, options));
    return parsed.success ? (parsed.data as ClipSpec) : null;
  };
  const postsLeft = Math.max(0, user.postsLimit - user.postsUsed);
  const picked = moments.filter((m) => chosen.has(momentKey(m)) && made[momentKey(m)]?.state !== "made");
  const make = async () => {
    setBusy("make"); setProblem(null);
    let ok = 0;
    for (const m of picked) {
      const k = momentKey(m), key = keys.current.get(k) || newKey();
      keys.current.set(k, key);
      setMade((all) => ({ ...all, [k]: { state: "making" } }));
      try {
        const spec = specOf(m);
        if (!spec) throw new Error("This moment can't be made into a clip. Find the moments again.");
        const r = await post<{ id: string }>("/posts", { workspaceId: workspace.id, spec, idempotencyKey: key });
        setMade((all) => ({ ...all, [k]: { state: "made", id: r.id } }));
        ok++;
      } catch (e) {
        // A network failure may have made it: the same key is used again, so a retry cannot make it twice.
        if (!(e instanceof TypeError)) keys.current.delete(k);
        setMade((all) => ({ ...all, [k]: { state: "failed", error: errorText(e) } }));
      }
    }
    setBusy("");
    void refresh();
    if (ok) toast(<>{ok === 1 ? "Your clip is being made." : `${ok} clips are being made.`} They'll wait for you in <Link to="/app/blitz">Blitz</Link>.</>, "good");
  };
  const preview = useMemo(() => (video && focused ? specOf(focused) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- specOf reads the video and options
    [video, focused, options]);
  const set = (change: Partial<ClipOptions>) => setOptions((o) => ({ ...o, ...change }));
  const plan = planById(user.plan);
  const speech = video?.speech ?? null;
  const toggle = (k: string) => setChosen((c) => { const next = new Set(c); if (next.has(k)) next.delete(k); else next.add(k); return next; });

  return (
    <main className="page clips">
      <div className="page-head">
        <div>
          <h1>Clips</h1>
          <p>Turn a podcast, webinar or demo call into vertical clips that follow the speaker, with captions.</p>
        </div>
        <div className="toolbar">
          <span className="chip violet"><Sparkles size={14} aria-hidden="true" />{number(Math.max(0, user.limit - user.used))} AI credits · {number(postsLeft)} posts left</span>
        </div>
      </div>

      <div className="clips-layout">
        <div className="stack">
          <section className="card stack" aria-labelledby="clips-video">
            <h2 id="clips-video"><Film size={18} aria-hidden="true" /> 1. Your long video</h2>
            {video ? (
              <div className="clips-video">
                <video src={video.url} preload="metadata" muted playsInline aria-hidden="true" />
                <div>
                  <strong>{video.name}</strong>
                  <span className="muted small">{video.status === "checking" ? "Checking the video…" : video.status === "failed" ? video.error : `${seconds(video.duration)} · ${speechLabel(speech)}`}</span>
                </div>
                <button type="button" className="btn sm" onClick={() => setPicking(true)}>Change</button>
              </div>
            ) : (
              <button type="button" className="btn primary" onClick={() => setPicking(true)}><Clapperboard size={16} aria-hidden="true" />Choose or upload a video</button>
            )}
            <p className="muted small">{plan.id === "free" ? "Videos up to 10 minutes on the free trial; paid plans take videos up to 2 hours (1.9 GB)." : "Videos up to 2 hours (1.9 GB). People should be filmed with their consent."}</p>
            {video?.status === "ready" && video.mime.startsWith("video/") && speech !== "found" && (
              <div className="clips-speech">
                {speech === "pending" ? (
                  <p className="row small" role="status"><Spinner label="Listening" /> Listening to the video. It takes about a minute for every ten minutes of it.</p>
                ) : speech === "none" ? (
                  <p className="small">We didn't hear any speech in this video, so it has no moments to cut. Try another one.</p>
                ) : video.hasAudio === false ? (
                  <p className="small">This video has no sound. Clips are cut from what people say.</p>
                ) : (
                  <>
                    <p className="small"><AudioLines size={15} aria-hidden="true" /> First we find what's said in the video: the moments come from it, and the clips get captions.
                      {speech === "failed" && " The last try didn't work."}</p>
                    <CreditBlockNotice block={block} />
                    <button type="button" className="btn primary" disabled={!!busy || !!block} onClick={findSpeech}>
                      {busy === "speech" ? <Spinner label="Starting" /> : <AudioLines size={16} aria-hidden="true" />}
                      {long ? `Transcribe · ${creditsLabel(cost)}` : "Find speech · free"}
                    </button>
                    {long && <p className="muted small">1 credit for every started 10 minutes of video; refunded if it fails.</p>}
                  </>
                )}
              </div>
            )}
          </section>

          {speech === "found" && (
            <section className="card stack" aria-labelledby="clips-moments">
              <h2 id="clips-moments"><Scissors size={18} aria-hidden="true" /> 2. The best moments</h2>
              <div className="row wrap" style={{ gap: 10 }}>
                <span className="small muted" id="clips-count">How many</span>
                <div className="seg small-seg" role="group" aria-labelledby="clips-count">
                  {MOMENT_COUNTS.map((n) => <button key={n} type="button" aria-pressed={count === n} onClick={() => setCount(n)}>{n}</button>)}
                </div>
                <button type="button" className="btn primary" disabled={!!busy || !user.verified} onClick={find}>
                  {busy === "find" ? <Spinner label="Finding moments" /> : <Sparkles size={16} aria-hidden="true" />}{moments.length ? "Find again" : "Find moments"}
                </button>
              </div>
              <p className="muted small">Free, up to 20 searches a day. Each moment lasts 15 to 60 seconds and stands on its own.</p>
              {moments.length > 0 && (
                <ol className="moments list-plain">
                  {moments.map((m) => {
                    const k = momentKey(m), state = made[k];
                    return (
                      <li key={k} className={`moment${focus === k ? " on" : ""}`}>
                        <label className="moment-pick">
                          <input type="checkbox" checked={chosen.has(k)} disabled={state?.state === "made"} onChange={() => toggle(k)} aria-label={`Make a clip of “${m.title}”`} />
                        </label>
                        <div className="moment-body">
                          <strong>{m.title}</strong>
                          <span className="muted small">{seconds(m.start)} – {seconds(m.end)} · {Math.round(m.end - m.start)} s</span>
                          {m.why && <p className="small">{m.why}</p>}
                          <p className="moment-text small">“{m.text}”</p>
                          <div className="row wrap" style={{ gap: 6 }}>
                            <button type="button" className="btn sm" aria-pressed={focus === k} onClick={() => setFocus(k)}><Play size={14} aria-hidden="true" />Preview</button>
                            <Link className="btn sm ghost" to={`/app/create?format=clip&asset=${video!.id}&start=${m.start}&end=${m.end}&title=${encodeURIComponent(m.title)}`}><Pencil size={14} aria-hidden="true" />Edit in Create</Link>
                            {state?.state === "making" && <span className="small row"><Spinner label="Sending" /> Sending…</span>}
                            {state?.state === "made" && <span className="chip green"><Check size={13} aria-hidden="true" />In Blitz</span>}
                          </div>
                          {state?.state === "failed" && <p className="notice bad small" role="alert">{state.error}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          )}

          {moments.length > 0 && speech === "found" && (
            <section className="card stack" aria-labelledby="clips-make">
              <h2 id="clips-make"><Rocket size={18} aria-hidden="true" /> 3. Make the clips</h2>
              <Option title="Remove pauses" about="Long silences are cut out, picture and sound alike." checked={options.cuts} onChange={(cuts) => set({ cuts })} />
              {options.cuts && <Option title="Filler words too" about="Um, uh and erm go as well." checked={options.fillers} onChange={(fillers) => set({ fillers })} />}
              <Option title="Follow the speaker" about="A wide video is cropped to 9:16 around the person talking." checked={options.follow} onChange={(follow) => set({ follow })} />
              <Option title="Hook title" about="The moment's title on screen for the first seconds." checked={options.title} onChange={(title) => set({ title })} />
              <EditorSection title="Caption style">
                <CaptionStylePicker value={options.style} onChange={(style) => set({ style })} />
              </EditorSection>
              {problem && <div className="notice bad" role="alert">{problem}</div>}
              <div className="cost-row">
                <span className="cost">{picked.length} clip{picked.length === 1 ? "" : "s"} · no AI credits · {picked.length} of {number(postsLeft)} posts left</span>
                <button type="button" className="btn primary" disabled={!!busy || !picked.length || picked.length > postsLeft || user.trialEnded} onClick={make}>
                  {busy === "make" ? <Spinner label="Sending" /> : <Rocket size={16} aria-hidden="true" />}Send to Blitz
                </button>
              </div>
            </section>
          )}
          {problem && !(moments.length > 0 && speech === "found") && <div className="notice bad" role="alert">{problem}</div>}
        </div>

        <aside className="clips-preview" aria-label="Clip preview">
          {preview && focused ? (
            <>
              <ClipPreview spec={preview} source={{ url: video!.url, duration: video!.duration, words: words[momentKey(focused)] || [] }} />
              <p className="muted small">{focused.title} · {seconds(keptDuration(previewCuts(words[momentKey(focused)] || [], focused.start, focused.end - focused.start, preview.cuts), focused.end - focused.start))}
                {options.follow ? " · the speaker is found when it's made" : ""}</p>
            </>
          ) : (
            <div className="phone-frame placeholder"><p>Your clip's preview<br /><span className="muted">appears here</span></p></div>
          )}
        </aside>
      </div>
      {picking && (
        <MediaPicker workspaceId={workspace.id} type="video" title="Choose a long video" onClose={() => setPicking(false)}
          onPick={(a) => { setPicking(false); setMoments([]); void choose(a.id); }} />
      )}
    </main>
  );
}

function Option({ title, about, checked, onChange }: { title: string; about: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="row between clips-option">
      <span><strong className="small">{title}</strong><br /><span className="muted small">{about}</span></span>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  );
}
function speechLabel(speech: Asset["speech"]) {
  return speech === "found" ? "speech found" : speech === "pending" ? "listening…" : speech === "none" ? "no speech heard" : speech === "failed" ? "speech not found yet" : "speech not found yet";
}
