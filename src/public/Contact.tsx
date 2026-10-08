import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Building2, CircleCheck, Mail, MapPin } from "lucide-react";
import { errorText, post, useAuth } from "../lib";
import { Turnstile } from "../Turnstile";
import { FormError, usePublicConfig } from "./PublicLayout";
import { PRODUCT } from "../../shared/brand";
import "./public.css";

// The contact form (POST /api/contact) with the company's details from the site configuration.

/** Mirrors contactTopics in server/routes/public.ts. */
const topics = [
  ["question", "Question"],
  ["billing", "Billing"],
  ["partnership", "Partnership"],
  ["abuse", "Report abuse"],
  ["other", "Other"],
] as const;
type Topic = (typeof topics)[number][0];
const MESSAGE_MAX = 4000;

export function Contact() {
  const { user } = useAuth();
  const { config } = usePublicConfig();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [topic, setTopic] = useState<Topic>("question");
  const [message, setMessage] = useState("");
  const [token, setToken] = useState("");
  const [check, setCheck] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const done = useRef<HTMLDivElement>(null);
  const siteKey = config?.turnstileSiteKey || null;
  // The signed-in state can arrive after the first render.
  useEffect(() => {
    if (!user) return;
    setName((v) => v || user.name);
    setEmail((v) => v || user.email);
  }, [user]);
  useEffect(() => { if (sent) done.current?.focus(); }, [sent]);
  const company = config?.company;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (siteKey && !token) return setError("Please complete the security check below.");
    setBusy(true);
    setError(null);
    try {
      await post("/contact", { name: name.trim(), email: email.trim(), topic, message: message.trim(), ...(token && { turnstileToken: token }) });
      setSent(email.trim());
      setMessage("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      // A security-check token works once.
      if (token) {
        setToken("");
        setCheck((c) => c + 1);
      }
    }
  };

  return (
    <div className="wrap">
      <header className="page-head">
        <span className="kicker">Contact</span>
        <h1>Get in touch</h1>
        <p className="lead">Questions about {PRODUCT.name}, billing, partnerships or something that needs our attention — write to us and we'll reply by email.</p>
      </header>
      <div className="contact-grid">
        <div className="frost">
          {sent ? (
            <div className="stack center" role="status" ref={done} tabIndex={-1}>
              <span className="icon-tile navy" style={{ margin: "0 auto" }}><CircleCheck size={24} aria-hidden="true" /></span>
              <h2 style={{ color: "#11151f", fontSize: 26 }}>Message sent</h2>
              <p>Thanks for writing. We'll reply to <strong>{sent}</strong> as soon as we can.</p>
              <div className="center-row">
                <button type="button" className="btn primary" onClick={() => setSent(null)}>Send another message</button>
                <Link className="btn" to="/">Back to the home page</Link>
              </div>
            </div>
          ) : (
            <form className="form-grid" onSubmit={submit}>
              <label className="field">
                <span className="label">Your name</span>
                <input className="input" name="name" autoComplete="name" required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">Email</span>
                <input className="input" name="email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <label className="field full">
                <span className="label">Topic</span>
                <select className="select" name="topic" value={topic} onChange={(e) => setTopic(e.target.value as Topic)}>
                  {topics.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </label>
              <label className="field full">
                <span className="label">Message</span>
                <textarea
                  className="textarea"
                  name="message"
                  required
                  minLength={10}
                  maxLength={MESSAGE_MAX}
                  rows={7}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  aria-describedby="message-count"
                />
                <span className="count" id="message-count">{message.length.toLocaleString("en-US")} / {MESSAGE_MAX.toLocaleString("en-US")} characters</span>
              </label>
              {topic === "abuse" && (
                <p className="notice full">Please include links to the posts or accounts involved, and what is wrong with them.</p>
              )}
              {siteKey && (
                <div className="full">
                  <Turnstile key={check} siteKey={siteKey} onToken={setToken} />
                </div>
              )}
              <div className="full">
                <FormError error={error} />
              </div>
              <div className="full row wrap between">
                <p className="small muted">
                  We use your details only to answer you. See our <Link className="text-link" to="/privacy">Privacy Policy</Link>.
                </p>
                <button className="btn primary big" type="submit" disabled={busy}>
                  {busy ? "Sending…" : "Send message"}
                </button>
              </div>
            </form>
          )}
        </div>
        <aside className="contact-side" aria-label="Company details">
          {company && (company.name || company.address || company.email) && (
            <div className="glass">
              <h2>Company</h2>
              <address>
                {company.name && <div><Building2 size={18} aria-hidden="true" /><span>{company.name}</span></div>}
                {company.address && <div><MapPin size={18} aria-hidden="true" /><span style={{ whiteSpace: "pre-line" }}>{company.address}</span></div>}
                {company.email && <div><Mail size={18} aria-hidden="true" /><a href={`mailto:${company.email}`}>{company.email}</a></div>}
              </address>
            </div>
          )}
          <div className="glass">
            <h2>Quick answers</h2>
            <ul>
              <li><Link to="/pricing">Plans, posts and AI credits</Link></li>
              <li><Link to={{ pathname: "/", hash: "#faq" }}>Frequently asked questions</Link></li>
              <li><Link to="/terms">Terms of Service</Link></li>
              <li><Link to="/privacy">Privacy Policy</Link></li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
