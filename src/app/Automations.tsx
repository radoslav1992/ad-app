import { useState } from "react";
import { Link } from "react-router-dom";
import { Zap } from "lucide-react";
import { errorText, patch, type Workspace } from "../lib";
import { useCurrentWorkspace, useWorkspace } from "./workspace";
import { Switch, useToast } from "../ui";
import { formatIds, formats, type FormatId } from "../../shared/formats";

// Automations: a fresh batch every day for review, and approved posts that schedule themselves.
export function Automations() {
  const workspace = useCurrentWorkspace();
  const { update } = useWorkspace();
  const toast = useToast();
  const [settings, setSettings] = useState(workspace.settings);
  const [busy, setBusy] = useState(false);
  const save = async (next = settings) => {
    setBusy(true);
    try {
      const r = await patch<{ workspace: Workspace }>(`/workspaces/${workspace.id}`, { settings: next });
      update(r.workspace);
      setSettings(r.workspace.settings);
      toast("Saved.", "good");
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setBusy(false);
    }
  };
  const a = settings.automation;
  const formatsOn = settings.formats as FormatId[];
  return (
    <main className="page">
      <div className="page-head">
        <div><h1>Automations</h1><p>Let {workspace.name}'s content run itself.</p></div>
      </div>
      <div className="grid two">
        <section className="card stack">
          <div className="row between">
            <div className="row"><span className="logo-mark" style={{ background: "var(--violet)", color: "#fff" }}><Zap size={18} /></span><h2>Daily posts</h2></div>
            <Switch checked={a.enabled} onChange={(v) => void save({ ...settings, automation: { ...a, enabled: v } })} label="Daily posts" />
          </div>
          <p className="muted">Every day we write and render new posts for you to review in Blitz — only while fewer than {a.postsPerDay * 2} are still waiting, so nothing piles up.</p>
          <label className="field"><span>Posts per day: {a.postsPerDay}</span>
            <input type="range" min={1} max={10} value={a.postsPerDay} onChange={(e) => setSettings({ ...settings, automation: { ...a, postsPerDay: Number(e.target.value) } })} />
          </label>
          <div className="row between">
            <div><strong>Use AI credits</strong><p className="muted small">AI images and talking creators where your media doesn't fit.</p></div>
            <Switch checked={a.useCredits} onChange={(v) => setSettings({ ...settings, automation: { ...a, useCredits: v } })} label="Use AI credits" />
          </div>
          <span className="label">Formats</span>
          <div className="stack" style={{ gap: 8 }}>
            {formatIds.map((f) => (
              <label key={f} className="check">
                <input type="checkbox" checked={formatsOn.includes(f)} onChange={() => setSettings({ ...settings, formats: formatsOn.includes(f) ? formatsOn.filter((x) => x !== f) : [...formatsOn, f] })} />
                <span>{formats[f].name} <span className="muted small">— {formats[f].short}</span></span>
              </label>
            ))}
          </div>
          <button className="btn primary" disabled={busy || !formatsOn.length} onClick={() => save()}>Save</button>
        </section>
        <section className="card stack">
          <div className="row between">
            <h2>Auto-schedule approved posts</h2>
            <Switch checked={settings.schedule.autoSchedule} onChange={(v) => void save({ ...settings, schedule: { ...settings.schedule, autoSchedule: v } })} label="Auto-schedule" />
          </div>
          <p className="muted">When you approve a post in Blitz, it takes the next free posting time on your default accounts.</p>
          <p className="small">Posting times: {settings.schedule.times.join(", ") || "none"} · {settings.schedule.timezone}</p>
          <p className="small">Default accounts: {settings.schedule.accounts.length || "none yet"}</p>
          <div className="row"><Link className="btn" to="/app/calendar">Posting schedule</Link><Link className="btn" to="/app/accounts">Accounts</Link></div>
        </section>
      </div>
    </main>
  );
}
