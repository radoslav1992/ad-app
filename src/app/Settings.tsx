import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, Building2, Check, KeyRound, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { Modal, Spinner, useToast } from "../ui";
import { ApiError, del, errorText, fileUrl, patch, post, useAuth, type Workspace } from "../lib";
import { planById } from "../../shared/plans";
import { WITHDRAWAL_DAYS } from "../../shared/withdrawal";
import { useWorkspace } from "./workspace";
import { ConfirmDialog, useSignedInUser, useStableCallback } from "./pickers";
import "./pages.css";

/** Settings: the account (name, password, deletion) and the workspaces (brands) it has. */
export function SettingsPage() {
  const { hash } = useLocation();
  // The sidebar's "Add workspace" links to #workspaces: bring that section into view and start in its name field.
  useEffect(() => {
    if (hash !== "#workspaces") return;
    const section = document.getElementById("workspaces");
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("new-workspace-name")?.focus({ preventScroll: true });
  }, [hash]);
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Your account and your workspaces.</p>
        </div>
      </div>
      <div className="settings">
        <AccountSection />
        <PasswordSection />
        <WorkspacesSection />
        <DangerSection />
      </div>
    </main>
  );
}

function AccountSection() {
  const user = useSignedInUser();
  const { refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState(false);
  const changed = name.trim() !== user.name && !!name.trim();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed) return;
    setBusy(true);
    try {
      await patch("/settings/profile", { name: name.trim() });
      await refresh();
      toast("Your name is saved.", "good");
    } catch (err) {
      toast(errorText(err), "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="account-title">
      <div className="card-head"><div><h2 id="account-title"><UserRound size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />Account</h2><p>How we address you.</p></div></div>
      <form className="form-grid" onSubmit={save}>
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" required />
        </label>
        <div className="field">
          <label className="label" htmlFor="account-email">Email {user.verified ? <span className="chip green"><Check size={12} aria-hidden="true" />Confirmed</span> : <span className="chip orange">Not confirmed</span>}</label>
          <input id="account-email" className="input" value={user.email} readOnly aria-describedby="account-email-hint" style={{ background: "var(--surface-2)" }} />
          <span id="account-email-hint" className="hint">To change your email, contact us from the <Link to="/contact" className="link">contact page</Link>.</span>
        </div>
        <div className="full row">
          <button type="submit" className="btn primary" disabled={!changed || busy}>{busy && <Spinner label="Saving" />}Save name</button>
        </div>
      </form>
    </section>
  );
}

function PasswordSection() {
  const user = useSignedInUser();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (!current) return setProblem("Enter your current password.");
    if (password.length < 10) return setProblem("Use at least 10 characters for your new password.");
    if (password !== confirm) return setProblem("The new passwords don't match.");
    if (password === current) return setProblem("Choose a password different from your current one.");
    setBusy(true);
    try {
      await post("/settings/password", { current, password });
      setCurrent(""); setPassword(""); setConfirm("");
      toast("Password changed. Other devices were signed out.", "good");
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="password-title">
      <div className="card-head"><div><h2 id="password-title"><KeyRound size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />Password</h2><p>Changing it signs you out everywhere else.</p></div></div>
      <form className="form-grid" onSubmit={submit} noValidate>
        {/* Lets password managers attach the change to the right account. */}
        <input type="text" name="username" autoComplete="username" value={user.email} readOnly hidden />
        <label className="field full">
          <span>Current password</span>
          <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" maxLength={128} />
        </label>
        <label className="field">
          <span>New password</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={128} aria-describedby="new-password-hint" />
          <span id="new-password-hint" className="hint">At least 10 characters.</span>
        </label>
        <label className="field">
          <span>Repeat new password</span>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" maxLength={128} />
        </label>
        {problem && <div className="notice bad full" role="alert">{problem}</div>}
        <div className="full row">
          <button type="submit" className="btn primary" disabled={busy || !current || !password || !confirm}>{busy && <Spinner label="Saving" />}Change password</button>
        </div>
      </form>
    </section>
  );
}

function WorkspacesSection() {
  const user = useSignedInUser();
  const { workspaces, workspace: current, select, refresh, update } = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ text: string; upgrade: boolean } | null>(null);
  const [renaming, setRenaming] = useState<Workspace | null>(null);
  const [deleting, setDeleting] = useState<Workspace | null>(null);
  const plan = planById(user.plan);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value || busy) return;
    setProblem(null);
    setBusy(true);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { workspace } = await post<{ workspace: Workspace }>("/workspaces", { name: value, timezone });
      await refresh();
      select(workspace.id);
      toast(`${workspace.name} is ready. Tell us about the brand next.`, "good");
      navigate("/app/brand");
    } catch (err) {
      setProblem({ text: errorText(err), upgrade: err instanceof ApiError && err.status === 402 });
      setBusy(false);
    }
  };
  const remove = async (w: Workspace) => {
    await del(`/workspaces/${w.id}`);
    const left = await refresh();
    if (current?.id === w.id && left[0]) select(left[0].id);
    toast(`${w.name} was deleted.`, "good");
  };
  return (
    <section className="card" id="workspaces" aria-labelledby="workspaces-title">
      <div className="card-head">
        <div>
          <h2 id="workspaces-title"><Building2 size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6 }} />Workspaces</h2>
          <p>One workspace per brand, each with its own profile, posts, accounts and schedule.</p>
        </div>
        <span className="chip">{workspaces.length} of {plan.workspaces} on {plan.name}</span>
      </div>
      <ul className="list-plain ws-list">
        {workspaces.map((w) => {
          const active = w.id === current?.id;
          return (
            <li key={w.id} className="ws-row">
              {w.logoAssetId ? <img className="ws-logo" src={fileUrl(w.logoAssetId)} alt="" /> : <span className="ws-logo" aria-hidden="true">{w.name.slice(0, 1).toUpperCase()}</span>}
              <div className="grow">
                <div className="name">{w.name}</div>
                <div className="small muted">{w.website || w.profile.product || "No website yet"}</div>
              </div>
              {active ? <span className="chip green"><Check size={12} aria-hidden="true" />Current</span> : <button type="button" className="btn sm" onClick={() => { select(w.id); toast(`Switched to ${w.name}.`, "good"); }}>Switch to</button>}
              <div className="icon-actions">
                <button type="button" className="btn icon ghost" onClick={() => setRenaming(w)} aria-label={`Rename ${w.name}`} title="Rename"><Pencil size={16} /></button>
                <button type="button" className="btn icon ghost danger" onClick={() => setDeleting(w)} aria-label={`Delete ${w.name}`} title={workspaces.length < 2 ? "You need at least one workspace" : "Delete"} disabled={workspaces.length < 2}><Trash2 size={16} /></button>
              </div>
            </li>
          );
        })}
      </ul>
      <form className="stack" onSubmit={add} style={{ marginTop: 18 }} aria-labelledby="new-workspace-title">
        <h3 id="new-workspace-title">Add a workspace</h3>
        <div className="field-row">
          <label className="grow">
            <span className="sr-only">Workspace name</span>
            <input id="new-workspace-name" className="input" value={name} onChange={(e) => { setName(e.target.value); setProblem(null); }} maxLength={80} placeholder="Brand or client name" />
          </label>
          <button type="submit" className="btn primary" disabled={!name.trim() || busy}>{busy ? <Spinner label="Adding" /> : <Plus size={16} aria-hidden="true" />}Add workspace</button>
        </div>
        {problem && (
          <div className={`notice ${problem.upgrade ? "warn" : "bad"}`} role="alert">
            {problem.text} {problem.upgrade && <Link to="/app/billing" className="link">See plans</Link>}
          </div>
        )}
      </form>
      {renaming && <RenameWorkspace workspace={renaming} onClose={() => setRenaming(null)} onSaved={(w) => { update(w); setRenaming(null); }} />}
      {deleting && (
        <DeleteWorkspace workspace={deleting} onClose={() => setDeleting(null)} onConfirm={() => remove(deleting)} />
      )}
    </section>
  );
}

function RenameWorkspace({ workspace, onClose, onSaved }: { workspace: Workspace; onClose: () => void; onSaved: (w: Workspace) => void }) {
  const toast = useToast();
  const [name, setName] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const close = useStableCallback(onClose);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { workspace: w } = await patch<{ workspace: Workspace }>(`/workspaces/${workspace.id}`, { name: name.trim() });
      toast("Workspace renamed.", "good");
      onSaved(w);
    } catch (err) {
      toast(errorText(err), "bad");
      setBusy(false);
    }
  };
  return (
    <Modal title="Rename workspace" onClose={close}>
      <form className="stack" onSubmit={save}>
        <label className="field">
          <span>Name</span>
          <input ref={input} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          <span className="hint">This also becomes the brand name used in posts.</span>
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>{busy && <Spinner label="Saving" />}Save</button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteWorkspace({ workspace, onClose, onConfirm }: { workspace: Workspace; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [typed, setTyped] = useState("");
  return (
    <ConfirmDialog title={`Delete ${workspace.name}?`} confirmLabel="Delete workspace" disabled={typed.trim() !== workspace.name.trim()} onClose={onClose} onConfirm={onConfirm}>
      <p>This permanently deletes the workspace with its posts, schedule, connected accounts, brand profile and files. It can't be undone.</p>
      <label className="field">
        <span>Type <strong>{workspace.name}</strong> to confirm</span>
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </label>
    </ConfirmDialog>
  );
}

function DangerSection() {
  const user = useSignedInUser();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const close = useStableCallback(() => { setOpen(false); setPassword(""); });
  const remove = async () => {
    if (!password) throw new Error("Enter your password to confirm.");
    await del("/settings/account", { password });
    toast("Your account was deleted. We're sorry to see you go.", "good");
    // Leave the signed-in pages first, so they don't redirect to the sign-in page once the account is gone.
    navigate("/", { replace: true });
    await refresh();
  };
  return (
    <section className="card danger-card" aria-labelledby="danger-title">
      <div className="card-head">
        <div>
          <h2 id="danger-title"><AlertTriangle size={18} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 6, color: "var(--red)" }} />Danger zone</h2>
          <p>Delete your account, every workspace, post and file. A paid plan is cancelled at once, without a refund of the rest of the month.</p>
        </div>
        <button type="button" className="btn danger" onClick={() => setOpen(true)}><Trash2 size={16} aria-hidden="true" />Delete account</button>
      </div>
      {open && (
        <ConfirmDialog title="Delete your account?" confirmLabel="Delete my account" disabled={!password} onClose={close} onConfirm={remove}>
          <p>Everything is deleted for good: workspaces, posts, files, connected accounts and creators. Any paid plan is cancelled now.</p>
          {user.hasSubscription && (
            <p className="notice warn">
              Subscribed in the last {WITHDRAWAL_DAYS} days and want a refund? <Link to="/contact?topic=withdrawal" className="link">Ask to withdraw</Link> before
              you delete your account: deleting cancels the plan without a refund.
            </p>
          )}
          <label className="field">
            <span>Your password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
        </ConfirmDialog>
      )}
    </section>
  );
}
