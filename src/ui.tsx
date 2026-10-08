import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, X, AlertCircle } from "lucide-react";
import { PRODUCT } from "../shared/brand";

// Small shared components: logo, modal, toasts, switch, progress dots.

export function Logo({ to = "/", light = false }: { to?: string; light?: boolean }) {
  return (
    <Link to={to} className="logo" aria-label={`${PRODUCT.name} home`} style={{ color: light ? "#fff" : undefined }}>
      <span className="logo-mark" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 64 64"><path d="M21 44V20h13a10 10 0 0 1 0 20h-6" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" /><circle cx="21" cy="48" r="4" fill="#fff" /></svg>
      </span>
      {PRODUCT.name}
    </Link>
  );
}

/** Dialogs open at once (a picker over a dialog): the page scrolls again when the last one closes. */
let openModals = 0;
export function Modal({ title, onClose, children, footer, wide = false }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // The latest onClose, without re-running the focus effect when a parent passes a new function each render.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    // Only the top-most dialog closes on Escape.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const dialogs = document.querySelectorAll(".modal-backdrop");
      if (dialogs[dialogs.length - 1]?.contains(ref.current)) close.current();
    };
    window.addEventListener("keydown", key);
    openModals++;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      if (--openModals === 0) document.body.style.overflow = "";
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) close.current(); }}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined} tabIndex={-1} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn icon ghost" onClick={() => close.current()} aria-label="Close"><X size={20} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

type Toast = { id: number; text: ReactNode; tone: "good" | "bad" | "info" };
const ToastContext = createContext<(text: ReactNode, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: ReactNode, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 8000 : 5000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.tone === "good" ? <CheckCircle2 size={18} color="var(--green)" /> : t.tone === "bad" ? <AlertCircle size={18} color="var(--red)" /> : null}
            <div className="grow">{t.text}</div>
            <button className="btn icon ghost sm" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}><X size={14} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}
export function ProgressDots({ count, current }: { count: number; current: number }) {
  return (
    <div className="progress-dots" aria-label={`Step ${current + 1} of ${count}`}>
      {Array.from({ length: count }, (_, i) => <span key={i} aria-current={i === current ? "step" : undefined} />)}
    </div>
  );
}
export function Spinner({ big = false, label = "Loading" }: { big?: boolean; label?: string }) {
  return <span className={`spinner${big ? " big" : ""}`} role="status" aria-label={label} />;
}
