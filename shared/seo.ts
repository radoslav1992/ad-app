import { PRODUCT } from "./brand";

// Titles and descriptions per public page; the Worker puts them into the HTML for crawlers and link previews, and the
// app updates them on navigation.
export const publicPages: Record<string, { title: string; description: string; updated: string }> = {
  "/": {
    title: `${PRODUCT.name} — ${PRODUCT.tagline}`,
    description: PRODUCT.pitch,
    updated: "2026-10-08",
  },
  "/pricing": {
    title: `Pricing — ${PRODUCT.name}`,
    description: "Start free. Starter $29, Growth $49 and Pro $149 a month for daily short-form posting across your brands.",
    updated: "2026-10-08",
  },
  "/terms": { title: `Terms of Service — ${PRODUCT.name}`, description: `The terms for using ${PRODUCT.name}.`, updated: "2026-10-08" },
  "/privacy": { title: `Privacy Policy — ${PRODUCT.name}`, description: `How ${PRODUCT.name} handles your data.`, updated: "2026-10-08" },
  "/contact": { title: `Contact — ${PRODUCT.name}`, description: `Questions about ${PRODUCT.name}? Write to us.`, updated: "2026-10-08" },
};
const privatePages: Record<string, string> = {
  "/login": "Sign in",
  "/register": "Create your account",
  "/forgot": "Forgot password",
  "/reset": "Choose a new password",
  "/verify": "Confirm your email",
};
export type PageMeta = { title: string; description: string; route: string | null; indexable: boolean };
/** The page's metadata; `route` is null for paths the app does not know (a real 404). */
export function pageMeta(path: string): PageMeta {
  const clean = path.replace(/\/+$/, "") || "/";
  const page = publicPages[clean];
  if (page) return { title: page.title, description: page.description, route: clean, indexable: true };
  if (privatePages[clean]) return { title: `${privatePages[clean]} — ${PRODUCT.name}`, description: PRODUCT.pitch, route: clean, indexable: false };
  if (clean === "/app" || clean.startsWith("/app/")) return { title: PRODUCT.name, description: PRODUCT.pitch, route: "/app", indexable: false };
  return { title: `Page not found — ${PRODUCT.name}`, description: PRODUCT.pitch, route: null, indexable: false };
}
