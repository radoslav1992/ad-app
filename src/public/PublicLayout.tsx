import { useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { Logo } from "../ui";
import { api, useAuth } from "../lib";
import { PRODUCT } from "../../shared/brand";
import "./public.css";

// The public site's frame (navigation, footer) and the small helpers its pages share.

/** GET /api/public/config */
export type PublicConfig = {
  turnstileSiteKey: string | null;
  registrationEnabled: boolean;
  billingEnabled: boolean;
  mediaEnabled: boolean;
  company: { name: string | null; address: string | null; email: string | null };
};
let cachedConfig: PublicConfig | null = null;
let pendingConfig: Promise<PublicConfig> | null = null;
function loadPublicConfig() {
  pendingConfig ??= api<PublicConfig>("/public/config").then(
    (c) => (cachedConfig = c),
    (e) => {
      pendingConfig = null;
      throw e;
    },
  );
  return pendingConfig;
}
/** The site's public settings (sign-ups open, security check, company details), loaded once per visit. */
export function usePublicConfig() {
  const [config, setConfig] = useState<PublicConfig | null>(cachedConfig);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (cachedConfig) {
      setConfig(cachedConfig);
      return;
    }
    let live = true;
    loadPublicConfig().then(
      (c) => { if (live) { setConfig(c); setFailed(false); } },
      () => { if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, [attempt]);
  return { config, failed, retry: () => { setFailed(false); setAttempt((a) => a + 1); } };
}

/** A form's error, announced to screen readers when it appears. */
export function FormError({ error }: { error: string | null }) {
  return (
    <div aria-live="assertive" aria-atomic="true">
      {error && <p className="notice bad">{error}</p>}
    </div>
  );
}

export function PublicLayout() {
  const { user } = useAuth();
  const { config } = usePublicConfig();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);
  const features = { pathname: "/", hash: "#features" };
  const owner = config?.company.name || PRODUCT.name;
  return (
    <div className="stage public">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="pub-header">
        <div className="pub-wrap pub-nav">
          <Logo light />
          <nav className="pub-links" aria-label="Main">
            <Link to={features}>Features</Link>
            <NavLink to="/pricing">Pricing</NavLink>
            <NavLink to="/contact">Contact</NavLink>
          </nav>
          <div className="pub-actions">
            {user ? (
              <Link className="btn white" to="/app">Open app</Link>
            ) : (
              <>
                <Link className="btn text-light" to="/login">Log in</Link>
                <Link className="btn white" to="/register">Start free</Link>
              </>
            )}
          </div>
          <button
            ref={toggle}
            type="button"
            className="btn outline-light icon menu-toggle"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen(!open)}
          >
            {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
            <span className="sr-only">{open ? "Close menu" : "Menu"}</span>
          </button>
        </div>
        <nav id={menuId} className="pub-wrap mobile-menu" aria-label="Mobile" hidden={!open}>
          <ul>
            <li><Link to={features} onClick={() => setOpen(false)}>Features</Link></li>
            <li><Link to="/pricing">Pricing</Link></li>
            <li><Link to="/contact">Contact</Link></li>
          </ul>
          <div className="menu-actions">
            {user ? (
              <Link className="btn white" to="/app" style={{ gridColumn: "1 / -1" }}>Open app</Link>
            ) : (
              <>
                <Link className="btn outline-light" to="/login">Log in</Link>
                <Link className="btn white" to="/register">Start free</Link>
              </>
            )}
          </div>
        </nav>
      </header>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="pub-footer">
        <div className="pub-wrap">
          <div className="foot-grid">
            <div className="foot-brand">
              <Logo light />
              <p>{PRODUCT.tagline}. Written and made for your brand, approved by you, published on schedule.</p>
            </div>
            <nav aria-label="Product">
              <h2>Product</h2>
              <ul>
                <li><Link to={features}>Features</Link></li>
                <li><Link to="/pricing">Pricing</Link></li>
                {user ? (
                  <li><Link to="/app">Open app</Link></li>
                ) : (
                  <>
                    <li><Link to="/register">Start free</Link></li>
                    <li><Link to="/login">Log in</Link></li>
                  </>
                )}
              </ul>
            </nav>
            <nav aria-label="Legal">
              <h2>Legal</h2>
              <ul>
                <li><Link to="/terms">Terms of Service</Link></li>
                <li><Link to="/privacy">Privacy Policy</Link></li>
              </ul>
            </nav>
            <nav aria-label="Company">
              <h2>Company</h2>
              <ul>
                <li><Link to="/contact">Contact</Link></li>
                {config?.company.email && <li><a href={`mailto:${config.company.email}`}>{config.company.email}</a></li>}
              </ul>
            </nav>
          </div>
          <div className="foot-base">
            <p>© {new Date().getFullYear()} {owner}</p>
            <p>TikTok, Instagram, YouTube and LinkedIn are trademarks of their owners. {PRODUCT.name} is not affiliated with them.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
