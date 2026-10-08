import { Hono } from "hono";
import type { Env } from "./types";
import { origin } from "./security";
import { pageMeta, publicPages } from "../shared/seo";
import { PRODUCT } from "../shared/brand";

/** Crawler files and the single-page app document with per-page metadata. */
export const pages = new Hono<{ Bindings: Env }>();
pages.get("/robots.txt", (c) =>
  c.text(`User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api\nDisallow: /reset\nDisallow: /verify\nSitemap: ${origin(c.env, c.req.raw)}/sitemap.xml\n`),
);
pages.get("/sitemap.xml", (c) => {
  const base = origin(c.env, c.req.raw);
  const urls = Object.entries(publicPages).map(([path, page]) => `<url><loc>${base}${path}</loc><lastmod>${page.updated}</lastmod></url>`).join("");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 200, {
    "Content-Type": "application/xml; charset=utf-8",
  });
});
const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
pages.get("*", async (c) => {
  const meta = pageMeta(c.req.path);
  const r = await c.env.ASSETS.fetch(c.req.raw);
  if (!r.headers.get("content-type")?.includes("text/html")) return r;
  const base = origin(c.env, c.req.raw);
  const url = base + (meta.route || c.req.path);
  const head = meta.indexable
    ? [
        `<link rel="canonical" href="${escapeAttr(url)}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="${escapeAttr(PRODUCT.name)}">`,
        `<meta property="og:title" content="${escapeAttr(meta.title)}">`,
        `<meta property="og:description" content="${escapeAttr(meta.description)}">`,
        `<meta property="og:url" content="${escapeAttr(url)}">`,
        `<meta name="twitter:card" content="summary">`,
      ].join("")
    : '<meta name="robots" content="noindex,nofollow">';
  // HTMLRewriter is part of the Workers runtime; outside it (tests) the document is served unchanged.
  const rewritten = typeof HTMLRewriter === "undefined" ? r : new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(meta.title); } })
    .on('meta[name="description"]', { element(el) { el.setAttribute("content", meta.description); } })
    .on("head", { element(el) { el.append(head, { html: true }); } })
    .transform(r);
  // Unknown paths still render the app's not-found page, with a real 404 status for crawlers.
  return meta.route ? rewritten : new Response(rewritten.body, { status: 404, headers: rewritten.headers });
});
