import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Download, Image as ImageIcon, RefreshCw, Sparkles, UserRound, Wand2 } from "lucide-react";
import { Modal, Spinner, useToast } from "../ui";
import { errorText, number, post, useApi, useAuth, usePoll, type Asset } from "../lib";
import { IMAGE_CREDITS, creditsLabel } from "../../shared/credits";
import { useCurrentWorkspace } from "./workspace";
import { CreditBlockNotice, Empty, GridSkeleton, ago, creditBlock, useRetryKey, useSignedInUser, useStableCallback } from "./pickers";
import "./pages.css";

type Run = { id: string; kind: "image" | "character"; status: "queued" | "running" | "completed" | "failed"; credits: number; failed: boolean; label: string; createdAt: number };
const working = (r: Run) => r.status === "queued" || r.status === "running";
/** AI images are named after their prompt ("AI image: …"). */
const promptOf = (a: Asset) => a.name.replace(/^AI image:\s*/i, "");

/** AI Studio: stand-alone AI images from a prompt (for slides and backgrounds), with the recent AI work. */
export function StudioPage() {
  const user = useSignedInUser();
  const { refresh } = useAuth();
  const workspace = useCurrentWorkspace();
  const toast = useToast();
  const retry = useRetryKey();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Asset | null>(null);
  const runs = useApi<{ runs: Run[] }>("/studio/runs");
  const images = useApi<{ assets: Asset[] }>(`/media?workspace=${workspace.id}&type=image&source=library&limit=200`);
  const { reload: reloadRuns, data: runData } = runs;
  const { reload: reloadImages } = images;
  const active = !!runData?.runs.some(working);
  usePoll(reloadRuns, 3000, active);

  // When a run we saw working finishes: show the new image, update the credits (a failed run is refunded).
  const seen = useRef(new Map<string, Run["status"]>());
  useEffect(() => {
    if (!runData) return;
    let done = 0, failed = 0, creators = 0;
    for (const r of runData.runs) {
      const before = seen.current.get(r.id);
      if ((before === "queued" || before === "running") && !working(r)) {
        if (r.status === "failed") failed++;
        else if (r.kind === "character") creators++;
        else done++;
      }
      seen.current.set(r.id, r.status);
    }
    if (!done && !failed && !creators) return;
    void reloadImages();
    void refresh();
    if (failed) toast(failed === 1 ? "One AI job didn't finish. Its credit was refunded." : `${failed} AI jobs didn't finish. Their credits were refunded.`, "bad");
    else if (done) toast(done === 1 ? "Your image is ready." : `${done} images are ready.`, "good");
    else toast(creators === 1 ? "Your new creator is ready." : "Your new creators are ready.", "good");
  }, [runData, reloadImages, refresh, toast]);

  const left = Math.max(0, user.limit - user.used);
  const block = creditBlock(user, IMAGE_CREDITS);
  const text = prompt.trim();
  const generate = async (e: FormEvent) => {
    e.preventDefault();
    if (block || busy) return;
    if (text.length < 3) { setProblem("Describe the image in a few words."); return; }
    setProblem(null);
    setBusy(true);
    const body = { prompt: text, workspaceId: workspace.id };
    try {
      await post("/studio/image", { ...body, idempotencyKey: retry.key(body) });
      retry.settle();
      setPrompt("");
      toast("We're making your image. It usually takes under a minute.", "good");
      await Promise.all([reloadRuns(), refresh()]);
    } catch (err) {
      retry.settle(err);
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const product = workspace.profile.product || workspace.profile.name || workspace.name;
  const ideas = [
    `A bright lifestyle photo of someone using ${product}, natural light, shot on a phone`,
    "A cosy desk with a laptop, coffee and plants, morning light, photo",
    "A blurred city street at night with neon reflections, vertical background",
  ];
  const generated = (images.data?.assets || []).filter((a) => a.kind === "ai_image" && a.status === "ready");
  const recent = runData?.runs || [];

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>AI Studio</h1>
          <p>Describe a picture and we'll make it, ready for slides and backgrounds.</p>
        </div>
        <div className="toolbar">
          <span className="chip violet"><Sparkles size={14} aria-hidden="true" />{number(left)} AI credits left</span>
          <Link to="/app/billing" className="btn sm">Get more credits</Link>
        </div>
      </div>

      <div className="studio-layout">
        <form className="card stack" onSubmit={generate} aria-labelledby="studio-form-title">
          <div>
            <h2 id="studio-form-title">New AI image</h2>
            <p className="muted small" style={{ marginTop: 4 }}>Portrait 9:16, made for TikTok, Reels and Shorts. Finished images land in your Library.</p>
          </div>
          <label className="field">
            <span>Describe the image <span className="counter">{text.length}/400</span></span>
            <textarea
              className="textarea" rows={4} maxLength={400} value={prompt} placeholder="e.g. A flat lay of a skincare set on pink marble, soft daylight, top view"
              onChange={(e) => { setPrompt(e.target.value); setProblem(null); }} aria-invalid={!!problem} aria-describedby={problem ? "studio-error" : undefined} disabled={busy}
            />
          </label>
          <div>
            <div className="hint" style={{ marginBottom: 8 }}>Need an idea?</div>
            <div className="suggestions">
              {ideas.map((idea) => (
                <button key={idea} type="button" className="chip" onClick={() => { setPrompt(idea); setProblem(null); }}>{idea}</button>
              ))}
            </div>
          </div>
          {problem && <div id="studio-error" className="notice bad" role="alert">{problem}</div>}
          <CreditBlockNotice block={block} />
          <div className="cost-row">
            <span className="cost">Costs <strong>{creditsLabel(IMAGE_CREDITS)}</strong> · {number(left)} left</span>
            <button type="submit" className="btn primary" disabled={!!block || busy || text.length < 3}>
              {busy ? <Spinner label="Starting" /> : <Wand2 size={16} aria-hidden="true" />}Generate image
            </button>
          </div>
        </form>

        <div className="stack">
          <section className="card" aria-labelledby="runs-title">
            <div className="card-head" style={{ marginBottom: 6 }}>
              <h2 id="runs-title">Recent AI work</h2>
              <button type="button" className="btn icon ghost" onClick={() => void reloadRuns()} aria-label="Refresh recent AI work"><RefreshCw size={16} /></button>
            </div>
            {runs.loading ? (
              <div className="stack">{Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton" style={{ height: 44 }} />)}</div>
            ) : runs.error ? (
              <div className="notice bad" role="alert">{runs.error}</div>
            ) : !recent.length ? (
              <p className="muted small">Nothing yet. Images and creators show up here while they're being made.</p>
            ) : (
              <ul className="list-plain" aria-live="polite">
                {recent.slice(0, 8).map((r) => (
                  <li key={r.id} className="run-item">
                    <span className="run-icon" aria-hidden="true">{r.kind === "image" ? <ImageIcon size={16} /> : <UserRound size={16} />}</span>
                    <div className="grow">
                      <div className="run-label" title={r.label}>{r.label || (r.kind === "image" ? "AI image" : "AI creator")}</div>
                      <div className="small muted">{r.kind === "image" ? "Image" : "Creator"} · {ago(r.createdAt)}</div>
                    </div>
                    <RunStatus run={r} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <Link to="/app/characters" className="card link-card">
            <span className="icon-tile" aria-hidden="true"><UserRound size={22} /></span>
            <span className="grow">
              <strong style={{ display: "block" }}>AI creators</strong>
              <span className="small muted">Make a talking creator for AI UGC videos, from a description or a photo.</span>
            </span>
            <ArrowRight size={18} aria-hidden="true" />
          </Link>
        </div>
      </div>

      <section className="section" aria-labelledby="generated-title">
        <div className="section-head">
          <div>
            <h2 id="generated-title">Your AI images</h2>
            <p>Use one in a post, or download it.</p>
          </div>
        </div>
        {images.loading ? (
          <GridSkeleton count={6} tall />
        ) : images.error ? (
          <div className="notice bad" role="alert">{images.error} <button type="button" className="link" onClick={() => void reloadImages()}>Try again</button></div>
        ) : !generated.length ? (
          <Empty icon={<Sparkles size={24} />} title="No AI images yet">
            Describe a picture above. It appears here and in your Library when it's ready.
          </Empty>
        ) : (
          <ul className="lib-grid list-plain">
            {generated.map((a) => (
              <li key={a.id} className="lib-card">
                <div className="lib-media" style={{ aspectRatio: a.width && a.height ? `${a.width} / ${a.height}` : "9 / 16" }}>
                  <img src={a.url} alt={promptOf(a)} loading="lazy" decoding="async" />
                  <button type="button" className="open" onClick={() => setViewing(a)} aria-label={`View ${promptOf(a)}`} />
                </div>
                <div className="lib-card-body">
                  <div className="lib-card-name" title={promptOf(a)}>{promptOf(a)}</div>
                  <div className="lib-card-meta">{ago(a.createdAt)}</div>
                </div>
                <div className="lib-card-actions">
                  <Link to={`/app/create?image=${a.id}`} className="btn sm primary">Use in a post</Link>
                  <a className="btn icon ghost push" href={`${a.url}?download=1`} download aria-label={`Download ${promptOf(a)}`} title="Download"><Download size={16} /></a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {viewing && <ImageModal asset={viewing} onClose={() => setViewing(null)} />}
    </main>
  );
}

function RunStatus({ run }: { run: Run }) {
  if (run.status === "queued") return <span className="chip"><Spinner label="Queued" />Queued</span>;
  if (run.status === "running") return <span className="chip orange"><Spinner label="Making" />Making…</span>;
  if (run.status === "failed") return <span className="chip red" title={run.credits ? "The credit was refunded." : undefined}>Failed{run.credits ? " · refunded" : ""}</span>;
  return <span className="chip green">Done</span>;
}

function ImageModal({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const close = useStableCallback(onClose);
  return (
    <Modal title="AI image" onClose={close} wide>
      <div className="lightbox">
        <img src={asset.url} alt={promptOf(asset)} />
        <p className="muted center" style={{ maxWidth: 560 }}>{promptOf(asset)}</p>
        <div className="row wrap" style={{ justifyContent: "center" }}>
          <Link to={`/app/create?image=${asset.id}`} className="btn primary">Use in a post</Link>
          <a className="btn" href={`${asset.url}?download=1`} download><Download size={16} aria-hidden="true" />Download</a>
        </div>
      </div>
    </Modal>
  );
}
