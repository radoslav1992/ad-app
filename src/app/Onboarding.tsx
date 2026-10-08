import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft, Asterisk, Bot, Briefcase, Building2, ChevronsRight, DollarSign, Facebook, FileText, Globe, ImagePlus, Instagram, Linkedin, Mail,
  MessageCircle, MousePointerClick, Podcast, Radio, Search, Sparkles, Tag, Target, Twitter, UserPlus, UserRound, Users, X, Youtube,
} from "lucide-react";
import { api, errorText, fileUrl, patch, post, put, uploadFile, useAuth, usePoll, type Workspace } from "../lib";
import { useWorkspace } from "./workspace";
import { Logo, ProgressDots, useToast } from "../ui";
import { PRODUCT } from "../../shared/brand";
import { goals, revenues, roles, sources, teamSizes, urgencies, type Onboarding as Answers } from "../../shared/onboarding";
import { businessCategories, businessCategoryNames } from "../../shared/profile";
import "./onboarding.css";

// First run: the brand (name, logo, website or description — analysed in the background), then a few questions
// about the person, then how content gets made. Eight steps; answers are saved as they are given.
const STEPS = 8;
const STEP_KEY = "pl-onboarding-step";
const sourceIcons: Record<string, ReactNode> = {
  "X (Twitter)": <Twitter />, LinkedIn: <Linkedin />, YouTube: <Youtube />, TikTok: <Radio />, Instagram: <Instagram />, Facebook: <Facebook />,
  Podcast: <Podcast />, Newsletter: <Mail />, Google: <Search />, Reddit: <Users />, ChatGPT: <Bot />, Claude: <Asterisk />, Gemini: <Sparkles />,
  "Friend/Referral": <UserPlus />, Other: <MessageCircle />,
};
function Pills<T extends string>({ options, value, onChange, cols = 3, label }: { options: readonly T[]; value: T | T[] | undefined; onChange: (v: T) => void; cols?: number; label: string }) {
  const selected = (o: T) => (Array.isArray(value) ? value.includes(o) : value === o);
  return (
    <div className={`pills cols-${cols}`} role="group" aria-label={label}>
      {options.map((o) => <button key={o} type="button" className="pill" aria-pressed={selected(o)} onClick={() => onChange(o)}>{o}</button>)}
    </div>
  );
}
const toggle = <T,>(list: T[] | undefined, v: T) => (list?.includes(v) ? list.filter((x) => x !== v) : [...(list || []), v]);

export function Onboarding() {
  const { user, refresh: refreshUser } = useAuth();
  const { workspace, refresh, select } = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStepState] = useState(() => {
    try { return Math.min(STEPS - 1, Number(sessionStorage.getItem(STEP_KEY)) || 0); } catch { return 0; }
  });
  const setStep = (n: number) => {
    setStepState(n);
    try { sessionStorage.setItem(STEP_KEY, String(n)); } catch { /* private mode */ }
    window.scrollTo(0, 0);
  };
  const [answers, setAnswers] = useState<Answers>(() => user?.onboarding || {});
  const [busy, setBusy] = useState(false);
  const [ws, setWs] = useState<Workspace | null>(workspace);
  useEffect(() => { if (workspace && !ws) setWs(workspace); }, [workspace, ws]);
  // Step 1 needs a workspace: without one, start there.
  useEffect(() => { if (!ws && step > 0) setStepState(0); }, [ws, step]);
  if (!user) return null;
  const save = (more: Partial<Answers> & { complete?: boolean }) => {
    const next = { ...answers, ...more };
    setAnswers(next);
    void put("/settings/onboarding", more).catch(() => {});
  };
  const logout = async () => {
    await post("/auth/logout").catch(() => {});
    await refreshUser();
    navigate("/");
  };
  const scanning = ws?.scan.status === "scanning";
  return (
    <div className="stage">
      <main className="onboarding">
        <button className="btn outline-light sm topright" onClick={logout}>Log out</button>
        {ws && step > 0 && ws.scan.status !== "idle" && step < 7 && <Preparing ws={ws} onUpdate={setWs} onFix={() => setStep(1)} />}
        {step === 0 && <Welcome name={user.name} ws={ws} busy={busy} onDone={async (name, company, logo) => {
          setBusy(true);
          try {
            if (name !== user.name) await patch("/settings/profile", { name });
            const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            const result = ws
              ? await patch<{ workspace: Workspace }>(`/workspaces/${ws.id}`, { name: company, logoAssetId: logo })
              : await post<{ workspace: Workspace }>("/workspaces", { name: company, logoAssetId: logo, timezone });
            setWs(result.workspace);
            select(result.workspace.id);
            await refresh();
            setStep(1);
          } catch (e) {
            toast(errorText(e), "bad");
          } finally {
            setBusy(false);
          }
        }} />}
        {step === 1 && ws && <Analyze ws={ws} busy={busy} onBack={() => setStep(0)} onDone={async (body) => {
          setBusy(true);
          try {
            const r = await post<{ workspace: Workspace }>(`/workspaces/${ws.id}/analyze`, body);
            setWs(r.workspace);
            setStep(2);
          } catch (e) {
            toast(errorText(e), "bad");
          } finally {
            setBusy(false);
          }
        }} />}
        {step === 2 && (
          <Step title="Tell us about yourself" subtitle="This helps us tailor recommendations to your stage.">
            <div className="section-label"><Users size={20} /> How big is your current team?</div>
            <Pills label="Team size" options={teamSizes} value={answers.teamSize} onChange={(v) => save({ teamSize: v })} />
            <div className="section-label" style={{ marginTop: 30 }}><DollarSign size={20} /> What is your current monthly revenue?</div>
            <Pills label="Monthly revenue" options={revenues} value={answers.revenue} onChange={(v) => save({ revenue: v })} />
            <button className="btn primary big block" style={{ marginTop: 30 }} disabled={!answers.teamSize || !answers.revenue} onClick={() => setStep(3)}>Continue</button>
            <div className="back"><button className="dim" onClick={() => setStep(1)}>Change website or description</button></div>
          </Step>
        )}
        {step === 3 && (
          <Step title="What describes you best?" subtitle="We'll customize your experience based on your role.">
            <div className="section-label"><Briefcase size={20} /> Select your role</div>
            <Pills label="Role" options={roles} value={answers.role} onChange={(v) => save({ role: v })} />
            <button className="btn primary big block" style={{ marginTop: 30 }} disabled={!answers.role} onClick={() => setStep(4)}>Continue</button>
            <Back onClick={() => setStep(2)} />
          </Step>
        )}
        {step === 4 && ws && <Business ws={ws} onBack={() => setStep(3)} onDone={async (businessModel, categories) => {
          try {
            const r = await patch<{ workspace: Workspace }>(`/workspaces/${ws.id}`, { profile: { businessModel, categories } });
            setWs({ ...r.workspace, scan: ws.scan.status === "scanning" ? ws.scan : r.workspace.scan });
          } catch (e) {
            toast(errorText(e), "bad");
            return;
          }
          setStep(5);
        }} />}
        {step === 5 && (
          <Step title="Why did you sign up?">
            <div className="section-label"><MousePointerClick size={20} /> Select one</div>
            <Pills label="Why you signed up" options={urgencies} value={answers.urgency} onChange={(v) => save({ urgency: v })} />
            <div className="section-label" style={{ marginTop: 30 }}><Target size={20} /> What do you expect from the platform? Select all that apply</div>
            <Pills label="What you expect" options={goals} value={answers.goals} onChange={(v) => save({ goals: toggle(answers.goals, v) })} />
            <button className="btn primary big block" style={{ marginTop: 30 }} disabled={!answers.urgency || !answers.goals?.length} onClick={() => setStep(6)}>Continue</button>
            <Back onClick={() => setStep(4)} />
          </Step>
        )}
        {step === 6 && (
          <Step title="How did you hear about us?">
            <div className="section-label">Select all that apply</div>
            <div className="pills cols-5" role="group" aria-label="Where you heard about us">
              {sources.map((s) => (
                <button key={s} type="button" className="pill tile" aria-pressed={!!answers.sources?.includes(s)} onClick={() => save({ sources: toggle(answers.sources, s) })}>
                  <span aria-hidden="true">{sourceIcons[s]}</span>{s}
                </button>
              ))}
            </div>
            <button className="btn primary big block" style={{ marginTop: 30 }} disabled={!answers.sources?.length} onClick={() => setStep(7)}>Continue</button>
            <Back onClick={() => setStep(5)} />
          </Step>
        )}
        {step === 7 && <TwoWays scanning={scanning} busy={busy} onBack={() => setStep(6)} onDone={async () => {
          setBusy(true);
          try {
            await put("/settings/onboarding", { complete: true });
            await refreshUser();
            try { sessionStorage.removeItem(STEP_KEY); } catch { /* private mode */ }
            navigate("/app/blitz?first=1");
          } catch (e) {
            toast(errorText(e), "bad");
          } finally {
            setBusy(false);
          }
        }} />}
        <ProgressDots count={STEPS} current={step} />
      </main>
    </div>
  );
}
function Step({ title, subtitle, children, size = "" }: { title: string; subtitle?: string; children: ReactNode; size?: string }) {
  return (
    <>
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      <section className={`frost ${size}`}>{children}</section>
    </>
  );
}
const Back = ({ onClick }: { onClick: () => void }) => <div className="back"><button onClick={onClick}><ArrowLeft size={18} /> Back</button></div>;

function Welcome({ name, ws, busy, onDone }: { name: string; ws: Workspace | null; busy: boolean; onDone: (name: string, company: string, logo: string | null) => void }) {
  const [person, setPerson] = useState(name);
  const [company, setCompany] = useState(ws?.name || "");
  const [logo, setLogo] = useState<string | null>(ws?.logoAssetId || null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const asset = await uploadFile(file);
      if (asset.status !== "ready") throw new Error(asset.error || "This image can't be used.");
      setLogo(asset.id);
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setUploading(false);
    }
  };
  return (
    <>
      <Logo light to="/app/onboarding" />
      <h1>Welcome to {PRODUCT.name}</h1>
      <div className="gradient-border" style={{ width: "min(860px, 100%)" }}><div>Everything you enter here will be used directly across the platform.</div></div>
      <form className="frost" onSubmit={(e) => { e.preventDefault(); if (person.trim() && company.trim()) onDone(person.trim(), company.trim(), logo); }}>
        <div className="two-col">
          <div className="field">
            <span className="label"><Building2 size={20} /> Company logo (optional)</span>
            <div className="logo-drop" onClick={() => !logo && input.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" && !logo) input.current?.click(); }}
              role="button" tabIndex={0} aria-label={logo ? "Company logo" : "Upload your company logo"}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files[0]); }}>
              {logo ? <img src={fileUrl(logo)} alt="Your logo" /> : uploading ? <span className="spinner big" /> : <span className="placeholder"><ImagePlus size={32} />Drop or choose an image</span>}
              {logo && <button type="button" className="remove" aria-label="Remove the logo" onClick={(e) => { e.stopPropagation(); setLogo(null); }}><X size={20} /></button>}
            </div>
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          </div>
          <div className="stack" style={{ gap: 22 }}>
            <label className="field"><span className="label"><UserRound size={20} /> Name</span><input className="input big" value={person} onChange={(e) => setPerson(e.target.value)} maxLength={80} required autoComplete="name" /></label>
            <label className="field"><span className="label"><Building2 size={20} /> Company name</span><input className="input big" value={company} onChange={(e) => setCompany(e.target.value)} maxLength={80} required autoComplete="organization" /></label>
          </div>
        </div>
        <div className="gradient-border" style={{ margin: "30px 0 26px", background: "linear-gradient(90deg,#7c5cff,#e5484d,#f5b21b,#16a34a,#f26b1d)" }}>
          <div style={{ fontWeight: 500 }}>Have multiple businesses? You can add more workspaces later in <strong>Settings › Workspaces</strong>.</div>
        </div>
        <button className="btn primary big block" disabled={busy || uploading || !person.trim() || !company.trim()}>{busy ? <span className="spinner" /> : "Continue"}</button>
      </form>
    </>
  );
}

function Analyze({ ws, busy, onBack, onDone }: { ws: Workspace; busy: boolean; onBack: () => void; onDone: (body: { website: string } | { description: string }) => void }) {
  const [mode, setMode] = useState<"website" | "description">(ws.description && !ws.website ? "description" : "website");
  // A website typed on the landing page before signing up is waiting here.
  const [website, setWebsite] = useState(() => {
    if (ws.website) return ws.website;
    try { return localStorage.getItem("pl-signup-website") || ""; } catch { return ""; }
  });
  const [description, setDescription] = useState(ws.description || "");
  const valid = mode === "website" ? website.trim().length > 3 : description.trim().length >= 20;
  return (
    <Step title="Analyze your website" subtitle="We use this to understand your brand and generate relevant content." size="narrow">
      <form onSubmit={(e) => { e.preventDefault(); if (valid) onDone(mode === "website" ? { website: website.trim() } : { description: description.trim() }); }}>
        <div className="mode-tabs" role="group" aria-label="Where we learn about your brand">
          <button type="button" className="pill" aria-pressed={mode === "website"} onClick={() => setMode("website")}><Globe size={22} /> Website</button>
          <button type="button" className="pill" aria-pressed={mode === "description"} onClick={() => setMode("description")}><FileText size={22} /> Use description instead</button>
        </div>
        {mode === "website" ? (
          <label className="field">
            <span className="label"><Globe size={20} /> Website or app store link</span>
            <input className="input big" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://yourbrand.com" inputMode="url" autoComplete="url" required />
            <span className="hint">Have an app? Paste its App Store or Google Play link.</span>
          </label>
        ) : (
          <label className="field">
            <span className="label"><FileText size={20} /> Describe your business</span>
            <textarea className="textarea input big" rows={6} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000}
              placeholder="What you sell, who it's for, what makes it different, and how you'd like to sound." required />
            <span className="hint">A few sentences are enough. You can refine everything later in Brand.</span>
          </label>
        )}
        <button className="btn primary big block" style={{ marginTop: 30 }} disabled={busy || !valid}>
          {busy ? <span className="spinner" /> : <>{mode === "website" ? "Analyse website" : "Use this description"} <ChevronsRight size={22} /></>}
        </button>
        <Back onClick={onBack} />
      </form>
    </Step>
  );
}

function Business({ ws, onBack, onDone }: { ws: Workspace; onBack: () => void; onDone: (model: "b2b" | "b2c" | "both", categories: string[]) => void }) {
  const [model, setModel] = useState(ws.profile.businessModel || "");
  const [categories, setCategories] = useState<string[]>(ws.profile.categories || []);
  const models = { b2b: "B2B", b2c: "B2C", both: "Both" } as const;
  return (
    <Step title="What type of business do you run?" subtitle="This helps us create content that resonates with your audience." size="wide">
      <div className="section-label"><Building2 size={20} /> Business model</div>
      <div className="pills cols-3" role="group" aria-label="Business model">
        {(Object.keys(models) as (keyof typeof models)[]).map((m) => <button key={m} type="button" className="pill" aria-pressed={model === m} onClick={() => setModel(m)}>{models[m]}</button>)}
      </div>
      <div className="section-label" style={{ marginTop: 30 }}><Tag size={20} /> Business category (select all that apply)</div>
      <div className="pills cols-4" role="group" aria-label="Business category">
        {businessCategories.map((c) => <button key={c} type="button" className="pill" aria-pressed={categories.includes(c)} onClick={() => setCategories(toggle(categories, c))}>{businessCategoryNames[c]}</button>)}
      </div>
      <button className="btn primary big block" style={{ marginTop: 30 }} disabled={!model || !categories.length} onClick={() => onDone(model as "b2b", categories)}>Continue</button>
      <Back onClick={onBack} />
    </Step>
  );
}

function TwoWays({ scanning, busy, onBack, onDone }: { scanning: boolean; busy: boolean; onBack: () => void; onDone: () => void }) {
  const [tab, setTab] = useState<"blitz" | "manual">("blitz");
  return (
    <Step title="Two ways to create content" size="wide">
      <div className="underline-tabs" role="tablist" style={{ margin: "-16px -16px 16px" }}>
        <button role="tab" aria-selected={tab === "blitz"} onClick={() => setTab("blitz")}>Blitz Mode</button>
        <button role="tab" aria-selected={tab === "manual"} onClick={() => setTab("manual")}>Manual Creation</button>
      </div>
      <div className="explainer" role="tabpanel">
        {tab === "blitz" ? (
          <div className="stack center" style={{ alignItems: "center", gap: 22 }}>
            <div className="swipe-demo" aria-hidden="true">
              <div className="card9 back1" />
              <div className="card9 front">wait… this app writes my posts for me??<span className="stamp">ACCEPT</span></div>
            </div>
            <strong style={{ fontSize: 20 }}>Blitz Mode</strong>
            <p className="muted" style={{ maxWidth: 460 }}>We make finished posts from your brand. Swipe right to approve and schedule, left to skip. A week of content in a few minutes.</p>
          </div>
        ) : (
          <div className="stack center" style={{ alignItems: "center", gap: 22 }}>
            <div className="editor-demo" aria-hidden="true">
              <div className="panel"><span>Format: Wall of Text</span><span>Video: reaction clip</span><span>Style: Quick thought</span><span>Prompt: pricing tips</span></div>
              <div className="phone"><div><em>pov: you finally stopped guessing your prices</em></div></div>
            </div>
            <strong style={{ fontSize: 20 }}>Manual Creation</strong>
            <p className="muted" style={{ maxWidth: 460 }}>Pick a format, a clip and a topic. We write it; you tweak the text, look and music, then save or schedule.</p>
          </div>
        )}
      </div>
      {scanning && <p className="notice" style={{ marginTop: 16 }}>We're still reading your brand — your first posts start as soon as it's done.</p>}
      <div className="row" style={{ justifyContent: "center", marginTop: 22 }}>
        <button className="btn primary big" disabled={busy} onClick={onDone}>{busy ? <span className="spinner" /> : "Continue to Dashboard"}</button>
      </div>
      <Back onClick={onBack} />
    </Step>
  );
}

/** "Preparing workspace": the brand analysis running in the background, with its two stages. */
function Preparing({ ws, onUpdate, onFix }: { ws: Workspace; onUpdate: (w: Workspace) => void; onFix: () => void }) {
  const running = ws.scan.status === "scanning";
  usePoll(async () => {
    try { onUpdate((await api<{ workspace: Workspace }>(`/workspaces/${ws.id}`)).workspace); } catch { /* next poll */ }
  }, 2500, running);
  const step = ws.scan.step;
  const websiteDone = ws.scan.status === "ready" || ["profile", "images", "done"].includes(step || "");
  const profileDone = ws.scan.status === "ready" || ["images", "done"].includes(step || "");
  if (ws.scan.status === "failed")
    return (
      <div className="preparing failed" role="status">
        <div className="ring" aria-hidden="true" />
        <div>
          <strong>We couldn't read your brand</strong>
          <span className="small">{ws.scan.error}</span>
          <div style={{ marginTop: 8 }}><button className="btn sm" onClick={onFix}>Change website or description</button></div>
        </div>
      </div>
    );
  return (
    <div className="preparing" role="status" aria-live="polite">
      {running ? <div className="ring" aria-hidden="true" /> : <div className="ring" style={{ animation: "none", borderColor: "var(--green)" }} aria-hidden="true" />}
      <div>
        <strong>{running ? "Preparing workspace" : "Workspace ready"}</strong>
        <span className="small muted" style={{ color: "#4a5263" }}>{running ? "Setting up your workspace…" : "Your brand profile is ready."}</span>
        <div className="steps">
          <span><i className={websiteDone ? "done" : ""} /> Website</span>
          <span><i className={profileDone ? "done" : ""} /> Profile</span>
        </div>
      </div>
    </div>
  );
}
