import { useEffect, useId, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, CircleCheck, Eye, EyeOff, Globe, KeyRound, MailCheck, MailWarning, Sparkles } from "lucide-react";
import { ApiError, errorText, post, useAuth } from "../lib";
import { Logo, Spinner } from "../ui";
import { Turnstile } from "../Turnstile";
import { FormError, usePublicConfig } from "./PublicLayout";
import { PRODUCT } from "../../shared/brand";
import { plans, TRIAL_DAYS } from "../../shared/plans";
import "./public.css";

// Sign in, sign up, password reset and email confirmation: full pages on the dark stage with a frosted card.

type Mode = "login" | "register" | "forgot" | "reset" | "verify";

/**
 * What the visitor typed on the home page (?website=) and the plan they picked on the pricing page (?plan=) survive
 * the email confirmation in this browser; onboarding and billing read them from here.
 */
export const SIGNUP_WEBSITE_KEY = "pl-signup-website";
export const SIGNUP_PLAN_KEY = "pl-signup-plan";
const remember = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
};

/** A path on this site to continue to after signing in; anything else (other sites, the sign-in pages) is ignored. */
function safeNext(next: string | null) {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (/^\/(login|register)(\/|\?|$)/.test(next)) return null;
  return next;
}
const withNext = (path: string, next: string) => (next === "/app" ? path : `${path}${path.includes("?") ? "&" : "?"}next=${encodeURIComponent(next)}`);

function Shell({ title, lead, children, foot }: { title: ReactNode; lead?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="stage auth-page">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="wrap auth-top">
        <Logo light />
        <Link className="btn outline-light sm" to="/"><ArrowLeft size={16} aria-hidden="true" /> Back to site</Link>
      </header>
      <main id="main" className="auth-main" tabIndex={-1}>
        <h1>{title}</h1>
        {lead && <p className="lead">{lead}</p>}
        <div className="frost auth-card">{children}</div>
        {foot && <div className="auth-foot">{foot}</div>}
      </main>
    </div>
  );
}
function Loading({ label = "Loading" }: { label?: string }) {
  return <div className="center-row" style={{ padding: "24px 0" }}><Spinner big label={label} /></div>;
}
/** A finished state inside the card: icon, title, text and actions. */
function State({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="stack" role="status">
      <span className="center-icon" aria-hidden="true">{icon}</span>
      <h2 className="state-title">{title}</h2>
      {children}
    </div>
  );
}

function TextField({ label, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <input className="input" {...input} />
    </label>
  );
}
function PasswordField({ label, value, onChange, autoComplete, hint, aside }: {
  label: string; value: string; onChange: (v: string) => void; autoComplete: "current-password" | "new-password"; hint?: string; aside?: ReactNode;
}) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const creating = autoComplete === "new-password";
  return (
    <div className="field">
      <div className="label-row">
        <label className="label" htmlFor={id}>{label}</label>
        {aside}
      </div>
      <div className="pw-wrap">
        <input
          id={id}
          className="input"
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          required
          minLength={creating ? 10 : undefined}
          maxLength={128}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button type="button" className="pw-toggle" aria-label="Show password" aria-pressed={shown} onClick={() => setShown(!shown)}>
          {shown ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
        </button>
      </div>
      {hint && <small className="hint" id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
/** Cloudflare's check; a token works once, so `round` changes to show a fresh one. */
function SecurityCheck({ siteKey, round, onToken }: { siteKey: string | null | undefined; round: number; onToken: (t: string) => void }) {
  if (!siteKey) return null;
  return (
    <div>
      <span className="sr-only">Security check</span>
      <Turnstile key={round} siteKey={siteKey} onToken={onToken} />
    </div>
  );
}
/** Token state for SecurityCheck: `spent()` after each submit that used it. */
function useCheck() {
  const [token, setToken] = useState("");
  const [round, setRound] = useState(0);
  const spent = () => {
    setToken("");
    setRound((r) => r + 1);
  };
  return { token, setToken, round, spent };
}

function Login({ next }: { next: string }) {
  const { user, loading, refresh } = useAuth();
  const { config } = usePublicConfig();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState(false);
  const check = useCheck();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (user) return <Navigate to={next} replace />;
  const siteKey = challenge ? config?.turnstileSiteKey : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (siteKey && !check.token) return setError("Please complete the security check.");
    setBusy(true);
    setError(null);
    try {
      await post("/auth/login", { email: email.trim(), password, ...(check.token && { turnstileToken: check.token }) });
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.data?.code === "TURNSTILE_REQUIRED") setChallenge(true);
      setError(errorText(err));
      setBusy(false);
      if (check.token) check.spent();
    }
  };
  return (
    <Shell
      title="Welcome back"
      lead="Log in to review, edit and schedule your posts."
      foot={<p>New to {PRODUCT.name}? <Link to={withNext("/register", next)}>Create an account</Link></p>}
    >
      {loading ? <Loading /> : (
        <form onSubmit={submit}>
          <TextField label="Email" type="email" name="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
          <PasswordField
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            aside={<Link className="text-link small" to="/forgot">Forgot password?</Link>}
          />
          <SecurityCheck siteKey={siteKey} round={check.round} onToken={check.setToken} />
          <FormError error={error} />
          <button className="btn primary big block" type="submit" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
        </form>
      )}
    </Shell>
  );
}

function Register({ next }: { next: string }) {
  const { user, loading, refresh } = useAuth();
  const { config, failed, retry } = usePublicConfig();
  const [params] = useSearchParams();
  const website = (params.get("website") ?? "").trim().slice(0, 300);
  const plan = plans.find((p) => p.price > 0 && p.id === params.get("plan"));
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accept, setAccept] = useState(false);
  const check = useCheck();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ email: string; emailSent: boolean } | null>(null);
  const [retrying, setRetrying] = useState<"idle" | "busy" | "sent">("idle");
  useEffect(() => {
    if (website) remember(SIGNUP_WEBSITE_KEY, website);
    if (plan) remember(SIGNUP_PLAN_KEY, plan.id);
  }, [website, plan]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!accept) return setError("Please accept the Terms of Service and Privacy Policy to continue.");
    if (config?.turnstileSiteKey && !check.token) return setError("Please complete the security check.");
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ ok: boolean; emailSent: boolean }>("/auth/register", {
        name: name.trim(), email: email.trim(), password, acceptTerms: true, ...(check.token && { turnstileToken: check.token }),
      });
      setResult({ email: email.trim(), emailSent: r.emailSent !== false });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      if (check.token) check.spent();
    }
  };
  // The confirmation email failed: sign in with the details just entered and ask for the email again.
  const sendAgain = async () => {
    setRetrying("busy");
    setError(null);
    try {
      await post("/auth/login", { email: email.trim(), password });
      await post("/auth/resend");
      await refresh();
      setRetrying("sent");
    } catch (err) {
      setError(errorText(err));
      setRetrying("idle");
    }
  };

  const loginLink = withNext(`/login${result ? `?email=${encodeURIComponent(result.email)}` : ""}`, next);
  const lead = `Free ${TRIAL_DAYS}-day trial · No credit card`;
  if (result) {
    return (
      <Shell title="Check your email" foot={<p>Wrong address? <Link to="/register" onClick={() => setResult(null)}>Start again</Link></p>}>
        {result.emailSent ? (
          <State icon={<MailCheck size={28} />} title="One last step">
            <p className="state-text">
              We've sent an email to <strong>{result.email}</strong>. Open the link in it to confirm your address, then log in to set up your brand. The link
              works for 24 hours.
            </p>
            <p className="state-text small muted">Nothing there? Check your spam folder. You can also log in now and confirm your email later.</p>
            <Link className="btn primary big block" to={loginLink}>Log in</Link>
          </State>
        ) : retrying === "sent" ? (
          <State icon={<MailCheck size={28} />} title="Email sent">
            <p className="state-text">We've sent the confirmation link to <strong>{result.email}</strong>. You're signed in, so you can start right away.</p>
            <Link className="btn primary big block" to={next}>Continue</Link>
          </State>
        ) : (
          <State icon={<MailWarning size={28} />} title="Your account is ready">
            <p className="state-text">
              But we couldn't send the confirmation email to <strong>{result.email}</strong> just now. Let's try again.
            </p>
            <FormError error={error} />
            <button className="btn primary big block" type="button" onClick={sendAgain} disabled={retrying === "busy"}>
              {retrying === "busy" ? "Sending…" : "Send the email again"}
            </button>
            <Link className="btn block" to={loginLink}>Log in instead</Link>
          </State>
        )}
      </Shell>
    );
  }
  if (user) {
    return (
      <Shell title="You're already signed in">
        <State icon={<CircleCheck size={28} />} title={user.name || user.email}>
          <p className="state-text">You're signed in as <strong>{user.email}</strong>.</p>
          <Link className="btn primary big block" to={next}>Open the app</Link>
          <button
            type="button"
            className="btn block"
            onClick={async () => {
              await post("/auth/logout").catch(() => {});
              await refresh();
            }}
          >
            Log out to create another account
          </button>
        </State>
      </Shell>
    );
  }
  if (!config || loading) {
    return (
      <Shell title="Create your account" lead={lead}>
        {failed ? (
          <div className="stack">
            <p className="notice bad" role="alert">We can't reach the server. Check your connection and try again.</p>
            <button className="btn primary block" type="button" onClick={retry}>Try again</button>
          </div>
        ) : <Loading />}
      </Shell>
    );
  }
  if (!config.registrationEnabled) {
    return (
      <Shell title="Sign-ups open soon" lead={`We're getting ${PRODUCT.name} ready for more brands.`} foot={<p>Already have an account? <Link to={withNext("/login", next)}>Log in</Link></p>}>
        <State icon={<Sparkles size={28} />} title="Want to be among the first?">
          <p className="state-text">Send us a note with your website and we'll write to you as soon as new accounts open.</p>
          <Link className="btn primary big block" to="/contact">Contact us</Link>
        </State>
      </Shell>
    );
  }
  return (
    <Shell title="Create your account" lead={lead} foot={<p>Already have an account? <Link to={withNext("/login", next)}>Log in</Link></p>}>
      {(website || plan) && (
        <p className="website-note">
          <Globe size={18} aria-hidden="true" />
          <span>
            {website && <>We'll start with <strong>{website}</strong> once you're in.</>}
            {website && plan && " "}
            {plan && <>You picked <strong>{plan.name}</strong>: start with the free trial and upgrade in Billing whenever you're ready.</>}
          </span>
        </p>
      )}
      <form onSubmit={submit}>
        <TextField label="Your name" name="name" autoComplete="name" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField label="Work email" type="email" name="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        <PasswordField label="Password" autoComplete="new-password" value={password} onChange={setPassword} hint="At least 10 characters." />
        <label className="check">
          <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} required />
          <span>
            I agree to the <a className="text-link" href="/terms" target="_blank" rel="noreferrer">Terms of Service<span className="sr-only"> (opens in a new tab)</span></a>{" "}
            and <a className="text-link" href="/privacy" target="_blank" rel="noreferrer">Privacy Policy<span className="sr-only"> (opens in a new tab)</span></a>.
          </span>
        </label>
        <SecurityCheck siteKey={config.turnstileSiteKey} round={check.round} onToken={check.setToken} />
        <FormError error={error} />
        <button className="btn primary big block" type="submit" disabled={busy}>{busy ? "Creating your account…" : "Create account"}</button>
      </form>
    </Shell>
  );
}

function Forgot() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/forgot", { email: email.trim() });
      setSent(email.trim());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      title={sent ? "Check your email" : "Forgot your password?"}
      lead={sent ? undefined : "Enter your email and we'll send you a link to choose a new one."}
      foot={<p>Remembered it? <Link to="/login">Log in</Link></p>}
    >
      {sent ? (
        <State icon={<MailCheck size={28} />} title="Link on its way">
          <p className="state-text">
            If there's an account for <strong>{sent}</strong>, you'll get an email with a link to choose a new password. The link works for one hour.
          </p>
          <p className="state-text small muted">Nothing there after a few minutes? Check your spam folder or try again.</p>
          <button className="btn block" type="button" onClick={() => setSent(null)}>Try another address</button>
        </State>
      ) : (
        <form onSubmit={submit}>
          <TextField label="Email" type="email" name="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
          <FormError error={error} />
          <button className="btn primary big block" type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
        </form>
      )}
    </Shell>
  );
}

function Reset() {
  const { refresh } = useAuth();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (token.length !== 64) {
    return (
      <Shell title="This link is incomplete">
        <State icon={<KeyRound size={28} />} title="Let's get you a new one">
          <p className="state-text">Open the link from the email again, or ask for a new link. Each link works once, for one hour.</p>
          <Link className="btn primary big block" to="/forgot">Send a new link</Link>
        </State>
      </Shell>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== repeat) return setError("The two passwords don't match.");
    setBusy(true);
    setError(null);
    try {
      await post("/auth/reset", { token, password });
      setDone(true);
      // Changing the password signs out every session, this one included.
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title={done ? "Password changed" : "Choose a new password"} foot={done ? undefined : <p><Link to="/forgot">Need a new link?</Link></p>}>
      {done ? (
        <State icon={<CircleCheck size={28} />} title="You're all set">
          <p className="state-text">Your new password is saved and you've been signed out everywhere. Log in with the new password.</p>
          <Link className="btn primary big block" to="/login">Log in</Link>
        </State>
      ) : (
        <form onSubmit={submit}>
          <PasswordField label="New password" autoComplete="new-password" value={password} onChange={setPassword} hint="At least 10 characters." />
          <PasswordField label="Repeat the new password" autoComplete="new-password" value={repeat} onChange={setRepeat} />
          <FormError error={error} />
          <button className="btn primary big block" type="submit" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
        </form>
      )}
    </Shell>
  );
}

// One request per link, even when the page mounts twice (React's strict mode, back and forward).
const verifications = new Map<string, Promise<unknown>>();
function Verify() {
  const { user, loading, refresh } = useAuth();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const valid = token.length === 64;
  const [status, setStatus] = useState<"working" | "done" | "failed">(valid ? "working" : "failed");
  const [error, setError] = useState<string | null>(null);
  const [resend, setResend] = useState<"idle" | "busy" | "sent">("idle");
  const [resendError, setResendError] = useState<string | null>(null);
  useEffect(() => {
    if (!valid) return;
    let live = true;
    let run = verifications.get(token);
    if (!run) {
      run = post("/auth/verify", { token });
      verifications.set(token, run);
    }
    run.then(
      () => {
        if (!live) return;
        setStatus("done");
        void refresh();
      },
      (err) => {
        if (!live) return;
        setStatus("failed");
        setError(errorText(err));
      },
    );
    return () => { live = false; };
  }, [token, valid, refresh]);
  const sendNew = async () => {
    setResend("busy");
    setResendError(null);
    try {
      await post("/auth/resend");
      setResend("sent");
    } catch (err) {
      setResendError(errorText(err));
      setResend("idle");
    }
  };

  if (status === "working" || (status === "failed" && loading)) {
    return <Shell title="Confirm your email"><Loading label="Confirming your email" /></Shell>;
  }
  if (status === "done" || user?.verified) {
    return (
      <Shell title="Email confirmed">
        <State icon={<CircleCheck size={28} />} title="Thanks, you're confirmed">
          <p className="state-text">
            {user ? "Your email address is confirmed. Let's make your first posts." : "Your email address is confirmed. Log in to set up your brand and make your first posts."}
          </p>
          <Link className="btn primary big block" to={user ? "/app" : "/login"}>Continue</Link>
        </State>
      </Shell>
    );
  }
  // The link failed, or this page was opened without one.
  return (
    <Shell title={valid ? "This link didn't work" : "Confirm your email"}>
      {user ? (
        resend === "sent" ? (
          <State icon={<MailCheck size={28} />} title="New link sent">
            <p className="state-text">Check <strong>{user.email}</strong> for the new link. It works for 24 hours.</p>
            <Link className="btn block" to="/app">Back to the app</Link>
          </State>
        ) : (
          <State icon={<MailWarning size={28} />} title="Get a new link">
            <p className="state-text">
              {error ? `${error} ` : ""}We'll send a fresh confirmation link to <strong>{user.email}</strong>.
            </p>
            <FormError error={resendError} />
            <button className="btn primary big block" type="button" onClick={sendNew} disabled={resend === "busy"}>
              {resend === "busy" ? "Sending…" : "Send a new link"}
            </button>
            <Link className="btn block" to="/app">Back to the app</Link>
          </State>
        )
      ) : (
        <State icon={<MailWarning size={28} />} title={valid ? "Link expired or used" : "Link incomplete"}>
          <p className="state-text">
            {error || "This confirmation link is incomplete."} Log in and we'll send you a new one.
          </p>
          <Link className="btn primary big block" to="/login?next=%2Fverify">Log in</Link>
        </State>
      )}
    </Shell>
  );
}

export function AuthPage({ mode }: { mode: Mode }) {
  const [params] = useSearchParams();
  const next = safeNext(params.get("next")) ?? "/app";
  if (mode === "login") return <Login next={next} />;
  if (mode === "register") return <Register next={next} />;
  if (mode === "forgot") return <Forgot />;
  if (mode === "reset") return <Reset />;
  return <Verify />;
}
