import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Camera, Clock, Crown, Mic, Pencil, Plus, Sparkles, Trash2, UserRound, Wand2 } from "lucide-react";
import { Modal, Spinner, useToast } from "../ui";
import { api, del, errorText, number, patch, post, useApi, useAuth, usePoll, type Asset, type Character } from "../lib";
import { AVATAR_STEP, IMAGE_CREDITS, VOICE_CHARS, avatarRates, creditsLabel, talkingCredits } from "../../shared/credits";
import { useCurrentWorkspace } from "./workspace";
import {
  ConfirmDialog, CreditBlockNotice, Empty, MediaPicker, Tabs, creditBlock, tabPanel, useRetryKey, useSignedInUser, useStableCallback,
} from "./pickers";
import "./pages.css";

type Making = { id: string; name: string };
type Filter = "all" | "library" | "own";
type Gender = "" | "female" | "male";
const genders: { id: Gender; label: string }[] = [{ id: "", label: "Not specified" }, { id: "female", label: "Female" }, { id: "male", label: "Male" }];
const MIN_PHOTO = 400;
/** A 30-second script (about 450 characters) for the price example. */
const SAMPLE = "x".repeat(450);

/** AI creators for AI UGC posts: the shared library and the person's own (from a description or a photo). */
export function CharactersPage() {
  const user = useSignedInUser();
  const { refresh } = useAuth();
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi<{ characters: Character[]; making: Making[] }>("/characters");
  const [filter, setFilter] = useState<Filter>("all");
  const [gender, setGender] = useState<Gender>("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Character | null>(null);
  const [deleting, setDeleting] = useState<Character | null>(null);
  const making = data?.making || [];
  usePoll(reload, 4000, making.length > 0);

  // A creator that was being made and no longer is: say whether it worked (a failed one is refunded).
  const wasMaking = useRef<Making[]>([]);
  useEffect(() => {
    if (!data) return;
    const gone = wasMaking.current.filter((m) => !data.making.some((x) => x.id === m.id));
    wasMaking.current = data.making;
    if (!gone.length) return;
    void refresh();
    void api<{ runs: { id: string; status: string }[] }>("/studio/runs").then(({ runs }) => {
      for (const m of gone) {
        const failed = runs.find((r) => r.id === m.id)?.status === "failed";
        toast(failed ? `We couldn't make ${m.name || "your creator"}. The credit was refunded. Try a different description.` : `${m.name || "Your creator"} is ready.`, failed ? "bad" : "good");
      }
    }).catch(() => {});
  }, [data, refresh, toast]);

  const all = data?.characters || [];
  const counts = { all: all.length, library: all.filter((c) => !c.own).length, own: all.filter((c) => c.own).length };
  const shown = all.filter((c) => (filter === "all" || (filter === "own") === c.own) && (!gender || c.gender === gender));
  const sampleLibrary = talkingCredits(SAMPLE, "library"), sampleCustom = talkingCredits(SAMPLE, "custom");

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Creators</h1>
          <p>AI creators who talk about your product straight to camera, for AI UGC posts.</p>
        </div>
        <div className="toolbar">
          <button type="button" className="btn primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />New creator</button>
        </div>
      </div>

      <div className="row between wrap" style={{ marginBottom: 16 }}>
        <Tabs label="Show creators" idBase="creators" value={filter} onChange={setFilter} items={[
          { id: "all", label: "All", count: counts.all }, { id: "library", label: "Library", count: counts.library }, { id: "own", label: "Yours", count: counts.own },
        ]} />
        <label className="row small">
          <span className="muted">Gender</span>
          <select className="select" style={{ width: "auto", padding: "8px 12px" }} value={gender} onChange={(e) => setGender(e.target.value as Gender)}>
            <option value="">Any</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
        </label>
      </div>

      <div {...tabPanel("creators", filter)}>
        {loading ? (
          <div className="creator-grid" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <div key={i} className="skeleton" style={{ aspectRatio: "3 / 4.9" }} />)}</div>
        ) : error ? (
          <div className="notice bad" role="alert">{error} <button type="button" className="link" onClick={() => void reload()}>Try again</button></div>
        ) : !shown.length && !(filter !== "library" && making.length) ? (
          filter === "own" ? (
            <Empty icon={<UserRound size={24} />} title="You haven't made a creator yet"
              action={<button type="button" className="btn primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden="true" />Make your first creator</button>}>
              Describe someone and we'll make them, or turn your own photo into a talking creator.
            </Empty>
          ) : (
            <Empty icon={<UserRound size={24} />} title={gender ? "No creators match this filter" : "No creators yet"}
              action={gender ? <button type="button" className="btn" onClick={() => setGender("")}>Show everyone</button> : <button type="button" className="btn primary" onClick={() => setCreating(true)}>New creator</button>}>
              {gender ? "Try another filter." : "Library creators are on their way. Meanwhile, make your own."}
            </Empty>
          )
        ) : (
          <ul className="creator-grid list-plain">
            {filter !== "library" && making.map((m) => (
              <li key={m.id} className="creator-card" aria-busy="true">
                <div className="creator-portrait making"><Spinner big label={`Making ${m.name}`} /><span>Making {m.name || "your creator"}…<br /><span className="small">About a minute</span></span></div>
                <div className="creator-body"><h3>{m.name || "New creator"}</h3><span className="chip">Yours</span></div>
              </li>
            ))}
            {shown.map((c) => (
              <CreatorCard key={c.id} creator={c} onEdit={() => setEditing(c)} onDelete={() => setDeleting(c)} />
            ))}
          </ul>
        )}
      </div>

      <section className="section card" aria-labelledby="pricing-title">
        <div className="card-head">
          <div>
            <h2 id="pricing-title">How talking creators are priced</h2>
            <p>AI UGC posts spend AI credits for the voice and the talking video. Everything else in a post is free.</p>
          </div>
          <Link to="/app/billing" className="btn sm">Plans & credits</Link>
        </div>
        <div className="grid two">
          <ul className="list-plain price-list">
            <li><Mic size={16} aria-hidden="true" /><span><strong>Voice:</strong> 1 credit per started {VOICE_CHARS} characters of script.</span></li>
            <li><UserRound size={16} aria-hidden="true" /><span><strong>Library creators:</strong> {avatarRates.library} credits per started {AVATAR_STEP} seconds of video.</span></li>
            <li><Crown size={16} aria-hidden="true" /><span><strong>Premium and your own creators:</strong> {avatarRates.custom} credits per started {AVATAR_STEP} seconds, as they're animated from a photo.</span></li>
          </ul>
          <ul className="list-plain price-list">
            <li><Clock size={16} aria-hidden="true" /><span><strong>Example:</strong> a 30-second script (about 450 characters) costs {creditsLabel(sampleLibrary)} with a library creator, or {creditsLabel(sampleCustom)} with a premium or your own.</span></li>
            <li><Wand2 size={16} aria-hidden="true" /><span><strong>Making a creator</strong> from a description costs {creditsLabel(IMAGE_CREDITS)}. From your own photo it's free.</span></li>
            <li><Sparkles size={16} aria-hidden="true" /><span>You have <strong>{number(Math.max(0, user.limit - user.used))}</strong> AI credits left this period.</span></li>
          </ul>
        </div>
      </section>

      {creating && <NewCreatorModal onClose={() => setCreating(false)} onStarted={() => { setCreating(false); setFilter((f) => (f === "library" ? "all" : f)); void reload(); void refresh(); }} />}
      {editing && (
        <EditCreatorModal creator={editing} onClose={() => setEditing(null)} onSaved={(c) => {
          setData((d) => (d ? { ...d, characters: d.characters.map((x) => (x.id === c.id ? c : x)) } : d));
          setEditing(null);
        }} />
      )}
      {deleting && (
        <ConfirmDialog title="Delete this creator?" onClose={() => setDeleting(null)} onConfirm={async () => {
          await del(`/characters/${deleting.id}`);
          setData((d) => (d ? { ...d, characters: d.characters.filter((x) => x.id !== deleting.id) } : d));
          toast(`${deleting.name} was deleted.`, "good");
        }}>
          <p><strong>{deleting.name}</strong> can't be used in new posts any more. Posts already made with them stay as they are.</p>
        </ConfirmDialog>
      )}
    </main>
  );
}

function CreatorCard({ creator: c, onEdit, onDelete }: { creator: Character; onEdit: () => void; onDelete: () => void }) {
  return (
    <li className="creator-card">
      <div className="creator-portrait">
        <img src={c.image} alt={`Portrait of ${c.name}`} loading="lazy" decoding="async" />
        <div className="badge-row">
          <span className="chip dark">{c.own ? "Yours" : "Library"}</span>
          {c.premium && (
            <span className="chip orange" title={`Costs ${avatarRates.custom} credits per started ${AVATAR_STEP} seconds instead of ${avatarRates.library}`}>
              <Crown size={12} aria-hidden="true" />Premium
            </span>
          )}
        </div>
      </div>
      <div className="creator-body">
        <h3 title={c.name}>{c.name}</h3>
        {c.description ? <p className="creator-desc">{c.description}</p> : <p className="creator-desc">No description.</p>}
        {c.premium && <span className="sr-only">Premium: costs {avatarRates.custom} credits per started {AVATAR_STEP} seconds.</span>}
        <div className="creator-actions">
          <Link to={`/app/create?format=ugc&character=${c.id}`} className="btn sm primary">Use in a post</Link>
          {c.own && (
            <>
              <button type="button" className="btn icon ghost" onClick={onEdit} aria-label={`Edit ${c.name}`} title="Edit"><Pencil size={16} /></button>
              <button type="button" className="btn icon ghost danger" onClick={onDelete} aria-label={`Delete ${c.name}`} title="Delete"><Trash2 size={16} /></button>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function GenderSelect({ id, value, onChange }: { id: string; value: Gender; onChange: (g: Gender) => void }) {
  return (
    <label className="field" htmlFor={id}>
      <span>Gender</span>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as Gender)}>
        {genders.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
      </select>
    </label>
  );
}

function NewCreatorModal({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
  const user = useSignedInUser();
  const workspace = useCurrentWorkspace();
  const toast = useToast();
  const retry = useRetryKey();
  const [mode, setMode] = useState<"describe" | "photo">("describe");
  const [name, setName] = useState("");
  const [gender, setGender] = useState<Gender>("");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<Asset | null>(null);
  const [consent, setConsent] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const close = useStableCallback(() => { if (!busy) onClose(); });
  const block = creditBlock(user, IMAGE_CREDITS);
  const desc = description.trim(), nm = name.trim();
  const smallPhoto = !!photo && Math.min(photo.width, photo.height) < MIN_PHOTO;
  const canDescribe = !block && !!nm && desc.length >= 10;
  const canPhoto = !!nm && !!photo && !smallPhoto && consent;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setProblem(null);
    if (!nm) { setProblem("Give your creator a name."); return; }
    if (mode === "describe") {
      if (block) return;
      if (desc.length < 10) { setProblem("Describe your creator in at least 10 characters."); return; }
      setBusy(true);
      const body = { name: nm, gender, description: desc };
      try {
        await post("/characters/generate", { ...body, idempotencyKey: retry.key(body) });
        retry.settle();
        toast(`We're making ${nm}. It takes about a minute.`, "good");
        onStarted();
      } catch (err) {
        retry.settle(err);
        setProblem(errorText(err));
        setBusy(false);
      }
    } else {
      if (!photo) { setProblem("Choose a photo."); return; }
      if (smallPhoto) { setProblem(`Use a sharper photo (at least ${MIN_PHOTO} pixels on each side).`); return; }
      if (!consent) { setProblem("Confirm you have permission to use this person's likeness."); return; }
      setBusy(true);
      try {
        await post("/characters/photo", { name: nm, gender, description: desc, assetId: photo.id, consent: true });
        toast(`${nm} is ready to use.`, "good");
        onStarted();
      } catch (err) {
        setProblem(errorText(err));
        setBusy(false);
      }
    }
  };

  // The photo picker replaces this dialog while it's open (two dialogs would both close on Escape).
  if (picking) {
    return (
      <MediaPicker workspaceId={workspace.id} type="image" title="Choose a photo of the person"
        onPick={(a) => { setPhoto(a); setPicking(false); setProblem(null); }} onClose={() => setPicking(false)} />
    );
  }
  let tip: ReactNode = null;
  if (mode === "photo" && smallPhoto) tip = <div className="notice warn">This photo is {photo?.width} × {photo?.height} pixels. Use one at least {MIN_PHOTO} pixels on each side.</div>;

  return (
    <Modal title="New creator" onClose={close} footer={
      <>
        <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
        <button type="submit" form="new-creator" className="btn primary" disabled={busy || (mode === "describe" ? !canDescribe : !canPhoto)}>
          {busy ? <Spinner label="Working" /> : mode === "describe" ? <Wand2 size={16} aria-hidden="true" /> : <Camera size={16} aria-hidden="true" />}
          {mode === "describe" ? "Make creator" : "Create from photo"}
        </button>
      </>
    }>
      <div style={{ marginBottom: 18 }}>
        <Tabs label="How to make the creator" idBase="new-creator" value={mode} onChange={(m) => { setMode(m); setProblem(null); }} items={[
          { id: "describe", label: <><Wand2 size={14} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />Describe</> },
          { id: "photo", label: <><Camera size={14} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />From a photo</> },
        ]} />
      </div>
      <div {...tabPanel("new-creator", mode)}>
        <form id="new-creator" className="stack" onSubmit={submit} noValidate>
          {mode === "photo" && (
            <div className="photo-pick">
              <button type="button" className={`photo-slot${photo ? " filled" : ""}`} onClick={() => setPicking(true)} aria-label={photo ? `Change the photo (${photo.name})` : "Choose a photo"}>
                {photo ? <img src={photo.url} alt="" /> : <><Camera size={26} aria-hidden="true" />Choose a photo</>}
              </button>
              <div className="stack">
                <p className="small muted">A clear, front-facing photo of one person from the chest up, in good light. Upload one or pick it from your Library. It's free.</p>
                {photo && <button type="button" className="btn sm" onClick={() => setPicking(true)} style={{ alignSelf: "flex-start" }}>Change photo</button>}
                <label className="check">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span>This is me, or I have the person's permission to make AI videos of them.</span>
                </label>
              </div>
            </div>
          )}
          {tip}
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="e.g. Maya" required />
            </label>
            <GenderSelect id="new-creator-gender" value={gender} onChange={setGender} />
            <label className="field full">
              <span>{mode === "describe" ? "Description" : "Description (optional)"} <span className="counter">{desc.length}/300</span></span>
              <textarea className="textarea" rows={4} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder={mode === "describe" ? "Age, look, clothes and setting, e.g. Woman in her late 20s with curly dark hair and a denim jacket, filming in a bright kitchen" : "e.g. Our founder, friendly and direct"} />
              {mode === "describe" && <span className="hint">At least 10 characters. The more specific, the better the portrait.</span>}
            </label>
          </div>
          {mode === "describe" && (
            <>
              <CreditBlockNotice block={block} />
              <div className="cost"><Sparkles size={14} aria-hidden="true" />Costs <strong>{creditsLabel(IMAGE_CREDITS)}</strong> · {number(Math.max(0, user.limit - user.used))} left</div>
            </>
          )}
          {problem && <div className="notice bad" role="alert">{problem}</div>}
        </form>
      </div>
    </Modal>
  );
}

function EditCreatorModal({ creator, onClose, onSaved }: { creator: Character; onClose: () => void; onSaved: (c: Character) => void }) {
  const [name, setName] = useState(creator.name);
  const [description, setDescription] = useState(creator.description);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const close = useStableCallback(onClose);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await patch(`/characters/${creator.id}`, { name: name.trim(), description: description.trim() });
      toast("Saved.", "good");
      onSaved({ ...creator, name: name.trim(), description: description.trim() });
    } catch (err) {
      toast(errorText(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title={`Edit ${creator.name}`} onClose={close} footer={
      <>
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="submit" form="edit-creator" className="btn primary" disabled={busy || !name.trim()}>{busy && <Spinner label="Saving" />}Save</button>
      </>
    }>
      <form id="edit-creator" className="stack" onSubmit={save}>
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <img src={creator.image} alt={`Portrait of ${creator.name}`} style={{ width: 96, aspectRatio: "3 / 4", objectFit: "cover", borderRadius: 12, flex: "none" }} />
          <div className="stack grow">
            <label className="field">
              <span>Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
            </label>
            <label className="field">
              <span>Description <span className="counter">{description.trim().length}/300</span></span>
              <textarea className="textarea" rows={3} maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </div>
        </div>
      </form>
    </Modal>
  );
}
