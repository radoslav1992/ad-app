import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, options: Record<string, unknown>) => string;
      remove: (id: string) => void;
      reset: () => void;
    };
  }
}
/** Cloudflare's security check (explicit render); `onToken("")` when the token expires. */
export function Turnstile({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (s: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false,
      id: string | undefined;
    const mount = () => {
      if (!cancelled && ref.current && window.turnstile)
        id = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          callback: onToken,
          "expired-callback": () => onToken(""),
          theme: "light",
        });
    };
    if (window.turnstile) mount();
    else {
      let script = document.querySelector<HTMLScriptElement>(
        "script[data-turnstile]",
      );
      if (!script) {
        script = document.createElement("script");
        script.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.dataset.turnstile = "true";
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", mount, { once: true });
    }
    return () => {
      cancelled = true;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey]);
  return <div ref={ref} className="turnstile" />;
}
