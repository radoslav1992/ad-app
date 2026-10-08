import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Info, Plus, RefreshCw, Unlink, X } from "lucide-react";
import { del, errorText, patch, post as send, useApi, useAuth, type Workspace } from "../lib";
import { Modal, Spinner, useToast } from "../ui";
import { useCurrentWorkspace, useWorkspace } from "./workspace";
import { AccountAvatar, PlatformIcon, handleText, type AccountsResponse, type SocialAccount } from "./ScheduleDialog";
import { isPlatform, platformIds, platforms, type PlatformId } from "../../shared/social";
import { planById } from "../../shared/plans";
import { PRODUCT } from "../../shared/brand";
import "./schedule.css";

// The workspace's connected TikTok, Instagram, YouTube and LinkedIn accounts: connect (OAuth), reconnect, disconnect,
// and the default accounts auto-scheduling posts to. The OAuth callback lands here with ?connected= or ?error=.

const beforeYouConnect: Record<PlatformId, string> = {
  tiktok: "Until our TikTok app passes TikTok's audit, posts may be published as private (visible only to you), and TikTok may ask you to set the account to private.",
  instagram: "Needs an Instagram professional account (Business or Creator); personal accounts can't connect. You can switch for free in the Instagram app's settings.",
  youtube: "Videos post as Shorts (vertical, up to 3 minutes). The Google account needs a YouTube channel. Until our app passes YouTube's audit, uploads may be private.",
  linkedin: "Posts go to your personal profile; company pages aren't supported yet. LinkedIn connections last 60 days, then you reconnect.",
};
const callbackErrors: Record<string, string> = {
  expired: "The connection took too long or its link was already used. Please connect again.",
  denied: "Access wasn't granted, so nothing was connected. Connect again and approve access to continue.",
  permissions: "Some permissions weren't granted. Connect again and allow everything we ask for, including posting. Instagram also needs a professional (Business or Creator) account.",
  no_channel: "That Google account has no YouTube channel yet. Create one on YouTube, then connect again.",
  unavailable: "Connecting this network isn't available right now. Please try again later.",
  limit: "You've reached the number of social accounts in your plan. Disconnect one or upgrade to connect more.",
  failed: "We couldn't connect the account. Please try again.",
};
const statusText: Record<string, string> = { active: "Active", expired: "Expired", revoked: "Access removed" };

type Outcome = { tone: "good" | "bad"; text: string; billing: boolean };

export function AccountsPage() {
  const workspace = useCurrentWorkspace();
  const { workspaces, select } = useWorkspace();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Back from the network's consent screen: show the workspace it was for, say what happened once, clean the address.
  const handled = useRef("");
  useEffect(() => {
    const connected = params.get("connected"), failed = params.get("error"), target = params.get("workspace");
    if (!connected && !failed) return;
    const signature = params.toString();
    if (handled.current === signature) return;
    handled.current = signature;
    if (target && target !== workspace.id && workspaces.some((w) => w.id === target)) select(target);
    if (connected) {
      const text = `${isPlatform(connected) ? platforms[connected].name : "Social"} account connected. Posts can now be scheduled to it.`;
      toast(text, "good");
      setOutcome({ tone: "good", text, billing: false });
    } else {
      const text = callbackErrors[failed || ""] || callbackErrors.failed;
      toast(text, "bad");
      setOutcome({ tone: "bad", text, billing: failed === "limit" });
    }
    setParams({}, { replace: true });
  }, [params, setParams, workspace.id, workspaces, select, toast]);
  return <AccountsScreen key={workspace.id} workspace={workspace} outcome={outcome} onDismiss={() => setOutcome(null)} />;
}

function AccountsScreen({ workspace, outcome, onDismiss }: { workspace: Workspace; outcome: Outcome | null; onDismiss: () => void }) {
  const { workspaces, update } = useWorkspace();
  const { user } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<AccountsResponse>(`/accounts?workspace=${workspace.id}`);
  const [connecting, setConnecting] = useState<PlatformId | null>(null);
  const [confirm, setConfirm] = useState<SocialAccount | null>(null);
  const [removing, setRemoving] = useState(false);
  const [savingDefaults, setSavingDefaults] = useState(false);

  useEffect(() => { if (error) toast(error, "bad"); }, [error, toast]);

  const schedule = workspace.settings.schedule;
  const accounts = data?.accounts || [];
  const limit = data?.limit ?? { max: planById(user?.plan).accounts, used: 0 };
  const paid = limit.max > 0;
  const full = paid && limit.used >= limit.max;

  async function connect(platform: PlatformId) {
    setConnecting(platform);
    try {
      const { url } = await send<{ url: string }>("/accounts/connect", { workspaceId: workspace.id, platform });
      window.location.assign(url);
    } catch (e) {
      toast(errorText(e), "bad");
      setConnecting(null);
    }
  }
  /** Saves the default accounts (the whole schedule is sent; IDs of accounts that are gone are dropped). */
  async function saveDefaults(ids: string[]) {
    const kept = ids.filter((id) => accounts.some((a) => a.id === id));
    const r = await patch<{ workspace: Workspace }>(`/workspaces/${workspace.id}`, { settings: { schedule: { ...schedule, accounts: kept } } });
    update(r.workspace);
  }
  async function toggleDefault(a: SocialAccount) {
    setSavingDefaults(true);
    try {
      const on = schedule.accounts.includes(a.id);
      await saveDefaults(on ? schedule.accounts.filter((id) => id !== a.id) : [...schedule.accounts, a.id]);
      toast(on ? `${a.name} is no longer a default account.` : `New approved posts can go to ${a.name} automatically.`, "good");
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setSavingDefaults(false);
    }
  }
  const closeConfirm = useCallback(() => setConfirm(null), []);
  async function disconnect() {
    if (!confirm) return;
    setRemoving(true);
    try {
      await del(`/accounts/${confirm.id}`);
      if (schedule.accounts.includes(confirm.id)) {
        try { await saveDefaults(schedule.accounts.filter((id) => id !== confirm.id)); } catch { /* the list is cleaned on the next save */ }
      }
      toast(`${confirm.name} was disconnected.`, "good");
      setConfirm(null);
      await reload();
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <main className="page sc-page">
      <div className="page-head">
        <div>
          <h1>Accounts</h1>
          <p>The social accounts {workspace.name} posts to. {PRODUCT.name} publishes your scheduled posts to them.</p>
        </div>
        {data && paid && (
          <div className="sc-usage">
            <span className="small muted">{limit.used} of {limit.max} social accounts used{workspaces.length > 1 ? " (all workspaces)" : ""}</span>
            <div className="meter" aria-hidden="true"><span style={{ width: `${Math.min(100, (limit.used / limit.max) * 100)}%` }} /></div>
          </div>
        )}
      </div>

      {outcome && (
        <div className={`notice ${outcome.tone} sc-notice row`} role={outcome.tone === "bad" ? "alert" : "status"}>
          <span className="grow">{outcome.text} {outcome.billing && <Link to="/app/billing">See plans</Link>}</span>
          <button type="button" className="btn icon ghost sm" onClick={onDismiss} aria-label="Dismiss"><X size={14} /></button>
        </div>
      )}
      {data && !paid && (
        <div className="notice warn sc-notice">
          Connecting social accounts and auto-publishing are part of the paid plans. Until then, download your posts and upload them yourself. <Link to="/app/billing">See plans</Link>
        </div>
      )}
      {data && full && (
        <div className="notice sc-notice">
          You've connected all {limit.max} accounts in your plan. Expired accounts can still be reconnected. <Link to="/app/billing">Upgrade for more</Link>
        </div>
      )}

      {loading && !data ? (
        <div className="loading-page"><Spinner big label="Loading accounts" /></div>
      ) : error && !data ? (
        <div className="empty">
          <p>{error}</p>
          <button type="button" className="btn" onClick={() => void reload()}>Try again</button>
        </div>
      ) : (
        <>
          <section className="card sc-defaults" aria-labelledby="sc-defaults-title">
            <div className="row between wrap">
              <div>
                <h2 id="sc-defaults-title">Auto-scheduling</h2>
                <p className="small muted">
                  {schedule.autoSchedule ? "On: " : "Off. When it's on, "}approving a post in Blitz schedules it in the next free slot on the default accounts you tick below.
                </p>
              </div>
              <Link to="/app/calendar" className="btn sm">Posting schedule</Link>
            </div>
            {schedule.autoSchedule && !accounts.some((a) => schedule.accounts.includes(a.id)) && !!accounts.length && (
              <p className="notice warn small">No default accounts yet: tick "Default for auto-scheduling" on at least one account.</p>
            )}
          </section>

          <div className="grid two sc-platforms">
            {platformIds.map((id) => {
              const facts = platforms[id];
              const configured = data?.platforms.find((p) => p.id === id)?.configured ?? false;
              const mine = accounts.filter((a) => a.platform === id);
              const reason = !configured ? `Not available yet: publishing to ${facts.name} isn't set up on this site.`
                : !paid ? "Connecting accounts needs a paid plan."
                : full ? `Your plan's ${limit.max} accounts are in use.` : null;
              const reasonId = `sc-connect-${id}-reason`;
              return (
                <section key={id} className="card sc-platform" aria-labelledby={`sc-platform-${id}`}>
                  <div className="sc-platform-head">
                    <PlatformIcon platform={id} size={40} />
                    <div className="grow">
                      <h2 id={`sc-platform-${id}`}>{facts.name}</h2>
                      <p className="small muted">{facts.note}</p>
                    </div>
                    <button type="button" className="btn primary sm" onClick={() => void connect(id)} disabled={!!reason || !!connecting}
                      aria-describedby={reason ? reasonId : undefined}>
                      {connecting === id ? <Spinner label="Opening" /> : <Plus size={14} aria-hidden="true" />} Connect{mine.length ? " another" : ""}
                    </button>
                  </div>
                  {reason && (
                    <p id={reasonId} className="small muted sc-reason">
                      {reason} {(!paid || full) && configured && <Link to="/app/billing">See plans</Link>}
                    </p>
                  )}
                  <p className="sc-before small"><Info size={14} aria-hidden="true" /> <span><strong>Before you connect:</strong> {beforeYouConnect[id]}</span></p>
                  {mine.length ? (
                    <ul className="sc-acc-list">
                      {mine.map((a) => {
                        const active = a.status === "active";
                        const checkId = `sc-default-${a.id}`;
                        return (
                          <li key={a.id} className="sc-acc">
                            <div className="row">
                              <AccountAvatar name={a.name} platform={a.platform} />
                              <div className="grow sc-acc-text">
                                <strong>{a.name}</strong>
                                <span className="small muted">{handleText(a.handle) || facts.name} · connected {new Date(a.createdAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                              </div>
                              <span className={`chip ${active ? "green" : "red"}`}>{statusText[a.status] || a.status}</span>
                            </div>
                            {!active && (
                              <p className="small notice bad">
                                {a.status === "revoked" ? `Access was removed on ${facts.name}.` : "The connection expired."} Scheduled posts to it can't go out until you reconnect.
                              </p>
                            )}
                            <div className="row wrap between">
                              <label className="check" htmlFor={checkId}>
                                <input id={checkId} type="checkbox" checked={schedule.accounts.includes(a.id)} disabled={savingDefaults} onChange={() => void toggleDefault(a)} />
                                Default for auto-scheduling
                              </label>
                              <span className="row">
                                {!active && (
                                  <button type="button" className="btn sm primary" onClick={() => void connect(id)} disabled={!configured || !paid || !!connecting}>
                                    {connecting === id ? <Spinner label="Opening" /> : <RefreshCw size={14} aria-hidden="true" />} Reconnect
                                  </button>
                                )}
                                <button type="button" className="btn sm danger" onClick={() => setConfirm(a)}><Unlink size={14} aria-hidden="true" /> Disconnect</button>
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="small muted sc-none">No {facts.name} account connected to {workspace.name}.</p>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      {confirm && (
        <Modal title={`Disconnect ${confirm.name}?`} onClose={closeConfirm}
          footer={<>
            <button type="button" className="btn ghost" onClick={closeConfirm} disabled={removing}>Keep it</button>
            <button type="button" className="btn danger" onClick={() => void disconnect()} disabled={removing}>
              {removing ? <Spinner label="Disconnecting" /> : <Unlink size={16} aria-hidden="true" />} Disconnect
            </button>
          </>}>
          <div className="stack">
            <p>
              Posts scheduled to this {platforms[confirm.platform].name} account are canceled, and its publishing history leaves the calendar.
              Posts already published stay on {platforms[confirm.platform].name}.
            </p>
            <p className="small muted">You can connect it again at any time. An account can't be disconnected while a post is being published to it.</p>
          </div>
        </Modal>
      )}
    </main>
  );
}
