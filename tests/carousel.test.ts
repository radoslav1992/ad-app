import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../server/index";
import { ContentGeneration } from "../server/content-workflow";
import { planCarousel, planRender, type PlanContext } from "../server/render-plan";
import { conceptToSpec, feasible, type Concept } from "../server/ideas";
import { falRequest } from "../server/providers/fal";
import { instagramInsights } from "../server/social/instagram";
import { unfit, type PostRow } from "../server/social/post";
import { autoSchedule } from "../server/publishing";
import { Publication } from "../server/publish-workflow";
import { seal } from "../server/crypto";
import { SITE, call, signedIn, subscribe, testEnv } from "./helpers";
import {
  BLACK, INK, WHITE, captionWithCta, carouselAspects, carouselFrames, carouselPalette, carouselSlide, carouselThemeIds, colourMood, contrast, ctaLine,
  defaultKit, luminance, mix, wrapText, type CarouselInput, type CarouselTheme,
} from "../shared/carousel";
import { estimatedSeconds, pendingMedia, referencedAssets, specCredits, specHook, specSchema, type CarouselSpec } from "../shared/formats";
import { jpegInfo, jpegsToPdf } from "../shared/pdf";
import { textWidth } from "../shared/caption-fonts";
import { RATE_HINTS, rates } from "../shared/analytics";
import { IMAGE_CREDITS, REFERENCE_IMAGE_CREDITS } from "../shared/credits";
import type { CaptionItem, CaptionText } from "../shared/caption-scene";

// Carousels (shared/carousel.ts): the shared layout (fit, contrast, footer), the format and its prices, the render plan
// and the run that makes the slides, publishing per network, the PDF, the writer, Instagram saves and migration 0006.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const LONG_TITLE = "One price for every client, no matter how big the job is or how many seats they use every single month of the year";
const LONG_BODY = ("A ten-person team and a five-hundred-person company do not get the same value from the same work. Tier your prices by seats, " +
  "usage or results, and say what each tier includes so nobody has to ask twice. Supercalifragilisticexpialidociousandthensomemorelettersthatneverend.").slice(0, 300);
const carousel = (extra: Record<string, unknown> = {}) => specSchema.parse({
  format: "carousel",
  slides: [
    { kind: "cover", title: "5 pricing mistakes that quietly cost agencies money", label: "Pricing guide", image: { assetId: id(1) } },
    { kind: "content", label: "01", title: "Charging by the hour", body: "Price the outcome, not the time it took." },
    { kind: "content", label: "Myth", title: "Clients won't pay for AI work", body: "They pay for results.", image: { assetId: id(2) } },
    { kind: "cta", title: "Want the template?", body: "Every number we use, in one sheet." },
  ],
  cta: { type: "comment", keyword: "template", text: "Comment {KEYWORD} and I'll send you the link" },
  brand: { handle: "@guide", primary: "#f26b1d", accent: "#1e2433" },
  ...extra,
}) as CarouselSpec;
/** A JPEG header declaring width×height (enough for imageInfo and the PDF writer). */
function jpeg(width = 1080, height = 1350) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, ...new Array(40).fill(0)]);
}

describe("the slide layout", () => {
  const texts = (items: CaptionItem[]) => items.filter((i): i is CaptionText => i.kind === "text");
  const bounds = (t: CaptionText) => { const w = textWidth(t.text, t.size, t.font); return { left: t.x - w / 2, right: t.x + w / 2, top: t.y - t.size * 0.62, bottom: t.y + t.size * 0.42 }; };
  const input = (theme: CarouselTheme, aspect: (typeof carouselAspects)[number], kind: "cover" | "content" | "cta", title: string, body: string, label: string, picture: boolean): CarouselInput => ({
    ...carousel({ theme, aspect }),
    slides: [{ kind, title, body, label, ...(picture && { image: { assetId: id(1) } }) }, { kind: "content", title: "Next", body: "", label: "" }],
  });

  it("keeps every word inside the margins and above the footer, shrinking titles and wrapping long words", () => {
    let checked = 0;
    for (const theme of carouselThemeIds) for (const aspect of carouselAspects) for (const kind of ["cover", "content", "cta"] as const)
      for (const picture of [false, true]) for (const [title, body, label] of [["Short title", "", ""], ["Charging by the hour", "Price the outcome, not the time.", "01"], [LONG_TITLE, LONG_BODY, "Before and after"], ["W".repeat(120), "W".repeat(300), "W".repeat(24)]]) {
        const l = carouselSlide(input(theme, aspect, kind, title, body, label, picture), 0, { logo: 3 });
        const { width: W, height: H } = carouselFrames[aspect];
        const y1 = H - W * 0.15, x0 = W * 0.085 - 1, x1 = W - W * 0.085 + 1;
        expect([l.width, l.height]).toEqual([W, H]);
        for (const t of texts(l.items)) {
          const b = bounds(t);
          expect(b.left, `${theme} ${aspect} ${kind} ${t.text}`).toBeGreaterThanOrEqual(x0);
          expect(b.right, `${theme} ${aspect} ${kind} ${t.text}`).toBeLessThanOrEqual(x1);
          // Words of the slide (layers up to 3) end above the footer; the footer's sit inside the frame.
          if (t.layer <= 3) expect(b.bottom, `${theme} ${aspect} ${kind} ${picture} ${t.text}`).toBeLessThanOrEqual(y1 + 1);
          expect(b.top).toBeGreaterThanOrEqual(0);
          expect(b.bottom).toBeLessThanOrEqual(H);
        }
        // A picture under the words starts below them, keeps at least a third of the slide's room, and ends above the footer.
        if (l.mode === "boxed") {
          const lowest = Math.max(...texts(l.items).filter((t) => t.layer <= 3).map((t) => bounds(t).bottom));
          expect(l.picture!.y).toBeGreaterThan(lowest);
          expect(l.picture!.h).toBeGreaterThanOrEqual((y1 - W * 0.085) * 0.3);
          expect(l.picture!.y + l.picture!.h).toBeLessThanOrEqual(y1 + 0.01);
        }
        checked++;
      }
    expect(checked).toBe(6 * 2 * 3 * 2 * 4);
  });

  it("shrinks a long title rather than overflowing, and splits a word wider than the line", () => {
    const size = (title: string) => texts(carouselSlide(input("clean", "4:5", "content", title, "", "", false), 0).items).find((t) => t.layer === 3)!.size;
    expect(size(LONG_TITLE)).toBeLessThan(size("Short title"));
    const lines = wrapText("W".repeat(60), 80, 500, "sans");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("W".repeat(60));
    expect(lines.every((l) => textWidth(l, 80, "sans") <= 500)).toBe(true);
    expect(wrapText("one two\nthree", 40, 2000, "regular")).toEqual(["one two", "three"]);
  });

  it("puts the cover's picture behind the hook by default, under it on request, and full-bleed everywhere in Photo", () => {
    const spec = carousel();
    const cover = carouselSlide(spec, 0);
    expect(cover.mode).toBe("full");
    expect(cover.picture).toEqual({ x: 0, y: 0, w: 1080, h: 1350, radius: 0 });
    // Over a picture the words are white, on a black shade.
    expect(texts(cover.items).filter((t) => t.layer === 3 && t.size > 60).map((t) => t.fill)).toEqual([WHITE, WHITE, WHITE, WHITE]);
    expect(cover.items.filter((i) => i.kind === "box" && i.color === BLACK).length).toBe(2);
    expect(carouselSlide({ ...spec, cover: "page" }, 0).mode).toBe("boxed");
    expect(carouselSlide(spec, 2).mode).toBe("boxed");
    expect(carouselSlide(spec, 2).picture!.radius).toBeGreaterThan(0);
    expect(carouselSlide({ ...spec, theme: "photo" }, 2).mode).toBe("full");
    expect(carouselSlide(spec, 1).mode).toBe("page");
    expect(carouselSlide(spec, 1).picture).toBeNull();
    // A picture that could not be used: the slide is laid out without it.
    expect(carouselSlide(spec, 2, { picture: false }).mode).toBe("page");
  });

  it("writes the handle, the logo, the page and the swipe cue in the footer", () => {
    const spec = carousel();
    const words = (i: number, s: CarouselInput = spec, logo: number | null = null) => texts(carouselSlide(s, i, { logo }).items).filter((t) => t.layer === 5).map((t) => t.text);
    expect(words(0)).toEqual(["Swipe", "@guide"]);
    expect(words(1)).toEqual(["2/4", "@guide"]);
    expect(words(0, { ...spec, swipe: false })).toEqual(["1/4", "@guide"]);
    expect(words(1, { ...spec, numbers: false })).toEqual(["@guide"]);
    // A long handle is made smaller, then shortened, never run into the page number.
    const long = words(1, { ...spec, brand: { ...spec.brand, handle: "@".padEnd(40, "W") } }, 4);
    expect(long[1].endsWith("…")).toBe(true);
    const withLogo = carouselSlide(spec, 1, { logo: 2 });
    expect(withLogo.logo).toMatchObject({ x: expect.any(Number), w: expect.any(Number), h: expect.any(Number) });
    expect(withLogo.logo!.w / withLogo.logo!.h).toBeCloseTo(2, 5);
    // On a picture the logo sits on a white chip (most logos are dark on clear).
    expect(carouselSlide(spec, 0, { logo: 2 }).items.some((i) => i.kind === "box" && i.color === WHITE && i.layer === 4)).toBe(true);
    expect(carouselSlide(spec, 1, { logo: 2 }).items.some((i) => i.kind === "box" && i.color === WHITE && i.layer === 4)).toBe(false);
  });

  it("draws the call to action as a button, or 'Comment' with the keyword big", () => {
    const spec = carousel();
    const last = texts(carouselSlide(spec, 3).items).filter((t) => t.layer === 3).map((t) => t.text).join(" ");
    expect(last).toBe("Want the template? Every number we use, in one sheet. Comment TEMPLATE and I'll send you the link");
    const link = texts(carouselSlide({ ...spec, cta: { type: "link", text: "Link in bio", keyword: "" } }, 3).items).filter((t) => t.layer === 3).map((t) => t.text);
    expect(link.at(-1)).toBe("Link in bio");
  });
});

describe("colours and contrast", () => {
  const brands = ["#7c5cff", "#c6f432", "#ffffff", "#000000", "#777777", "#767676", "#f2c94c", "#1e2433", "#f26b1d", "#2d6cdf", "#e5484d", "#16a34a", "#fafafa", "#0f1115"];
  it("keeps every text colour readable on its page, for any brand colours and page colour", () => {
    for (const theme of carouselThemeIds) for (const primary of brands) for (const accent of [brands[(brands.indexOf(primary) + 3) % brands.length]])
      for (const background of [null, "#ffffff", "#777777", "#0c0d10", primary]) {
        const p = carouselPalette(theme, { primary, accent, background });
        const where = `${theme} ${primary} ${accent} ${background}`;
        for (const c of [p.title, p.body, p.muted]) expect(contrast(c, p.background), where).toBeGreaterThanOrEqual(4.5);
        expect(contrast(p.accent, p.background), where).toBeGreaterThanOrEqual(3);
        expect(contrast(p.onAccent, p.accent), where).toBeGreaterThanOrEqual(4.5);
        if (p.highlight) expect(contrast(p.title, p.highlight), where).toBeGreaterThanOrEqual(4.5);
      }
  });

  it("falls back to ink or white, and darkens a Bold page that neither reads on", () => {
    expect(carouselPalette("bold", { primary: "#c6f432", accent: "#000000", background: null })).toMatchObject({ background: "#c6f432", title: INK });
    expect(carouselPalette("bold", { primary: "#1e2433", accent: "#000000", background: null })).toMatchObject({ background: "#1e2433", title: WHITE });
    const grey = carouselPalette("bold", { primary: "#7a7a7a", accent: "#000000", background: null });
    expect(grey.background).not.toBe("#7a7a7a");
    expect(contrast(grey.title, grey.background)).toBeGreaterThanOrEqual(4.5);
    // A brand colour too pale for white pages is not used for words there.
    expect(carouselPalette("clean", { primary: "#f2c94c", accent: "#1e2433", background: null }).accent).toBe("#1e2433");
    expect(carouselPalette("clean", { primary: "#fafafa", accent: "#fbfbfb", background: null }).accent).toBe(INK);
  });

  it("keeps words over a picture readable even when the picture is white", () => {
    for (const theme of carouselThemeIds) {
      const l = carouselSlide(carousel({ theme }), 0);
      // What shows through both shades at most, on a white picture.
      const through = l.items.filter((i) => i.kind === "box" && i.color === BLACK).reduce((t, i) => t * (1 - (i.alpha ?? 1)), 1);
      const page = mix(WHITE, BLACK, 1 - through);
      for (const t of l.items.filter((i): i is CaptionText => i.kind === "text" && i.fill !== null)) {
        // Words in a pill sit on the pill's own colour.
        const pill = l.items.find((b) => b.kind === "box" && b.layer === t.layer - 1 && Math.abs(b.y - t.y) < b.h / 2 && Math.abs(b.x - t.x) < b.w / 2 && b.color !== BLACK);
        expect(contrast(t.fill!, pill && pill.kind === "box" ? pill.color : page), `${theme} ${t.text}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(luminance(WHITE)).toBe(1);
  });

  it("suggests what a colour tends to mean, as a rule of thumb", () => {
    expect([colourMood("#16a34a"), colourMood("#2d6cdf"), colourMood("#7c5cff"), colourMood("#f26b1d"), colourMood("#e5484d"), colourMood("#f5d90a"), colourMood("#0c0d10"), colourMood("#9aa0a6")])
      .toEqual(["Green: growth and health.", "Blue: trust and calm.", "Purple: luxury and imagination.", "Orange: creativity and fun.", "Red: energy and action.", "Yellow: happiness and optimism.", "Black: sophistication and exclusivity.", "A neutral: it lets the words and pictures lead."]);
  });
});

describe("the format", () => {
  it("defaults to 4:5, an image cover and a save CTA, and keeps emoji out of the words", () => {
    const s = specSchema.parse({ format: "carousel", slides: [{ kind: "cover", title: "Hello 👋 world" }, { kind: "content", title: "Point", label: "🔥01" }] }) as CarouselSpec;
    expect(s).toMatchObject({ aspect: "4:5", theme: "clean", cover: "image", numbers: true, swipe: true, cta: { type: "save", keyword: "" } });
    expect(s.slides[0].title).toBe("Hello world");
    expect(s.slides[1].label).toBe("01");
    expect(specSchema.safeParse({ format: "carousel", slides: [{ title: "Only one" }] }).success).toBe(false);
    expect(specSchema.safeParse({ format: "carousel", slides: Array.from({ length: 11 }, () => ({ title: "x" })) }).success).toBe(false);
    expect(specSchema.safeParse({ format: "carousel", slides: [{ title: "a", image: {} }, { title: "b" }] }).success).toBe(false);
    expect((specSchema.parse({ format: "carousel", slides: [{ title: "a" }, { title: "b" }], cta: { type: "comment", keyword: "gu ide!" } }) as CarouselSpec).cta.keyword).toBe("GUIDE");
  });

  it("charges 1 credit per AI picture at the slide's shape, 2 when it keeps a reference character, nothing else", () => {
    const spec = carousel({ aspect: "1:1", slides: [...carousel().slides, { kind: "content", title: "AI", image: { prompt: "A plant on a sunny desk" } }, { kind: "content", title: "AI 2", image: { prompt: "A laptop on a desk", assetId: id(9) } }] });
    expect(pendingMedia(spec)).toEqual([{ kind: "image", prompt: "A plant on a sunny desk", path: ["slides", 4, "image"], aspect: "1:1" }]);
    expect(specCredits(spec)).toBe(IMAGE_CREDITS);
    const kept = { ...spec, brand: { ...spec.brand, referenceId: id(7) } };
    expect(pendingMedia(kept)[0]).toMatchObject({ aspect: "1:1", reference: id(7) });
    expect(specCredits(kept)).toBe(REFERENCE_IMAGE_CREDITS);
    expect(specCredits(carousel())).toBe(0);
    expect(estimatedSeconds(spec)).toBe(0);
    expect(referencedAssets({ ...kept, brand: { ...kept.brand, logoId: id(8) } }).sort()).toEqual([id(1), id(2), id(7), id(8), id(9)].sort());
    expect(specHook(spec)).toBe("5 pricing mistakes that quietly cost agencies money");
  });

  it("asks nano-banana for the slide's shape, and the edit model with the reference for a character", () => {
    expect(falRequest("image", "A plant", { aspect: "4:5" }).body).toMatchObject({ aspect_ratio: "4:5", resolution: "2K" });
    expect(falRequest("image", "A plant").body.aspect_ratio).toBe("9:16");
    const r = falRequest("image", "The mascot waving on a beach", { aspect: "4:5", reference: "https://site/api/render-inputs/r/0?token=t" });
    expect(r.model).toBe("fal-ai/nano-banana-pro/edit");
    expect(r.body).toMatchObject({ image_urls: ["https://site/api/render-inputs/r/0?token=t"], num_images: 1, aspect_ratio: "4:5", resolution: "1K", output_format: "jpeg", limit_generations: true });
    expect((r.body as any).prompt).toContain("The mascot waving on a beach");
    expect((r.body as any).system_prompt).toMatch(/reference/);
  });

  it("ends the caption with the slide's call to action, replacing the previous one", () => {
    const comment = { type: "comment" as const, text: "Comment {KEYWORD} and I'll send you the link", keyword: "GUIDE" };
    const save = { type: "save" as const, text: "Save this for later", keyword: "" };
    expect(ctaLine(comment)).toBe("Comment GUIDE and I'll send you the link");
    expect(ctaLine({ ...comment, text: "Comment below" })).toBe("Comment below GUIDE");
    const first = captionWithCta("Five mistakes to avoid.", comment);
    expect(first).toBe("Five mistakes to avoid.\n\nComment GUIDE and I'll send you the link");
    expect(captionWithCta(first, comment)).toBe(first);
    expect(captionWithCta(first, save, comment)).toBe("Five mistakes to avoid.\n\nSave this for later");
    expect(captionWithCta("", save)).toBe("Save this for later");
  });

  it("starts a new carousel with the workspace's saved kit, else its watermark or website, logo and colours", () => {
    const w = { name: "Guide", website: "https://www.guide.com/about", logoAssetId: id(3), profile: { colors: { primary: "#112233", accent: "#445566" } }, settings: { watermark: "", carousel: null } };
    expect(defaultKit(w)).toMatchObject({ handle: "guide.com", logoId: id(3), primary: "#112233", accent: "#445566", background: null, fonts: null });
    expect(defaultKit({ ...w, settings: { watermark: "@guide", carousel: null } }).handle).toBe("@guide");
    expect(defaultKit({ ...w, logoAssetId: "not-a-uuid" }).logoId).toBeUndefined();
    const saved = { handle: "@saved", background: "#ffffff", primary: "#000000", accent: "#ffffff", fonts: { title: "serif" as const, body: "regular" as const } };
    expect(defaultKit({ ...w, settings: { watermark: "", carousel: saved as any } })).toMatchObject(saved);
  });
});

describe("the render plan", () => {
  const ctx: PlanContext = {
    media: {
      [id(1)]: { key: "media/u/beach.jpg", kind: "image", duration: 0, width: 1600, height: 1200 },
      [id(2)]: { key: "media/u/plant.jpg", kind: "image", duration: 0, width: 1200, height: 1200, ai: true },
      [id(4)]: { key: "media/u/logo.png", kind: "image", duration: 0, width: 640, height: 200 },
    },
    accent: "#7c5cff", watermark: "corner mark",
  };
  it("makes stills only, at 4:5 or 1:1: page colour, the picture in its box, the logo and the words", () => {
    const spec = carousel({ brand: { handle: "@guide", primary: "#f26b1d", accent: "#1e2433", logoId: id(4) } });
    const p = planCarousel(spec, ctx);
    expect(p).toMatchObject({ operation: "stills", width: 1080, height: 1350, synthetic: true });
    expect(p.keys).toEqual(["media/u/beach.jpg", "media/u/logo.png", "media/u/plant.jpg"]);
    expect(p.slides).toHaveLength(4);
    expect(p.slides[0]).toMatchObject({ color: "#ffffff", input: 0, box: { x: 0, y: 0, w: 1080, h: 1350, radius: 0 }, logo: { input: 1 } });
    expect(p.slides[1].input).toBeUndefined();
    expect(p.slides[1].box).toBeUndefined();
    expect(p.slides[2]).toMatchObject({ input: 2, box: { radius: 32 } });
    for (const s of p.slides) {
      for (const v of Object.values(s.box ?? {})) expect(Number.isInteger(v)).toBe(true);
      expect(s.logo!.w / s.logo!.h).toBeCloseTo(3.2, 1);
      expect(s.ass).toContain("PlayResX: 1080\nPlayResY: 1350");
      // The footer's handle stands in for the corner watermark of videos.
      expect(s.ass).not.toContain("corner mark");
    }
    expect(p.slides[3].ass).toContain("TEMPLATE");
    const square = planCarousel({ ...carousel({ aspect: "1:1" }), slides: carousel().slides.slice(1) }, ctx);
    expect(square).toMatchObject({ width: 1080, height: 1080, synthetic: true });
    expect(planCarousel({ ...carousel(), slides: carousel().slides.slice(0, 2) }, ctx).synthetic).toBe(false);
    // Never a video.
    expect(() => planRender(spec, ctx)).toThrow("MEDIA_INPUT");
    expect(() => planCarousel(spec, { ...ctx, media: {} })).toThrow("MEDIA_INPUT");
  });
});

/** A fake renderer container: completes jobs at once; a stills job has a file per slide. */
function renderer(log: any[] = []) {
  const jobs = new Map<string, any>();
  return {
    log,
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (url: string, init: any = {}) => {
        const path = new URL(url).pathname.split("/").filter(Boolean);
        if (init.method === "POST") { const p = JSON.parse(init.body); log.push(p); jobs.set(p.id, p); return Response.json({ status: "running" }, { status: 202 }); }
        if (init.method === "DELETE") return Response.json({});
        const job = jobs.get(path[1]);
        if (!job) return new Response("{}", { status: 404 });
        if (path[2] === "file") return new Response(jpeg());
        return Response.json({ status: "completed", duration: 0, files: job.slides?.length ?? 2 });
      },
    }),
  };
}
const step = { do: async (_name: string, a: any, b?: any) => (b ?? a)(), sleep: async () => {} };
function fal() {
  const calls: { method: string; url: string; body?: any }[] = [];
  let n = 0;
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = String(input?.url ?? input), method = init.method || "GET";
    calls.push({ method, url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const m = url.match(/^https:\/\/queue\.fal\.run\/(.+?)(\/requests\/.*)?$/);
    if (m && method === "POST") { const r = `r${++n}`; return Response.json({ request_id: r, status_url: `https://queue.fal.run/${m[1]}/requests/${r}/status`, response_url: `https://queue.fal.run/${m[1]}/requests/${r}` }); }
    if (m && url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    if (m) return Response.json({ images: [{ url: "https://v3.fal.media/files/slide.jpg" }] });
    if (url === "https://v3.fal.media/files/slide.jpg") return new Response(jpeg(1080, 1350));
    throw new Error("unexpected " + url);
  });
  return calls;
}

describe("carousels in the content run", () => {
  it("makes AI pictures at 4:5 with the reference character, renders only stills and saves the slides as the post", async () => {
    const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true", FAL_KEY: "fal", MEDIA_RENDERER: renderer() });
    const user = signedIn(sqlite);
    subscribe(sqlite, user.id, "starter");
    const w = (await call(worker, env, "POST", "/api/workspaces", { name: "Guide" }, user.cookie)).data.workspace;
    const own = async (name: string, mime = "image/jpeg") => {
      const a = crypto.randomUUID(), key = `media/${user.id}/${a}.jpg`;
      await env.MEDIA.put(key, jpeg(800, 800));
      sqlite.prepare("INSERT INTO media_assets(id,user_id,workspace_id,kind,name,object_key,mime,bytes,width,height,status,created_at,updated_at) VALUES (?,?,?,'upload',?,?,?,64,800,800,'ready',1,1)").run(a, user.id, w.id, name, key, mime);
      return a;
    };
    const mascot = await own("Mascot"), logo = await own("Logo"), video = await own("Clip", "video/mp4");
    const calls = fal();
    const spec = carousel({
      slides: [
        { kind: "cover", title: "Our mascot's 3 tips", image: { prompt: "The mascot on a beach at sunset" } },
        { kind: "content", label: "01", title: "Tip one", body: "Short and clear." },
        { kind: "content", label: "02", title: "Tip two", image: { prompt: "The mascot at a desk" } },
        { kind: "cta", title: "More?" },
      ],
      brand: { handle: "@guide", primary: "#f26b1d", accent: "#1e2433", logoId: logo, referenceId: mascot },
    });
    // A carousel only takes pictures.
    const refused = await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec: { ...spec, brand: { ...spec.brand, logoId: video } }, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(refused.status).toBe(400);
    const created = await call(worker, env, "POST", "/api/posts", { workspaceId: w.id, spec, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(created.status).toBe(201);
    expect(created.data.credits).toBe(2 * REFERENCE_IMAGE_CREDITS);
    const run = async () => { for (const c of env.CONTENT.created.splice(0)) await new ContentGeneration({} as any, env).run({ payload: c.params } as any, step as any); };
    await run();
    const submits = calls.filter((c) => c.method === "POST");
    expect(submits.map((c) => c.url)).toEqual(["https://queue.fal.run/fal-ai/nano-banana-pro/edit", "https://queue.fal.run/fal-ai/nano-banana-pro/edit"]);
    expect(submits[0].body).toMatchObject({ aspect_ratio: "4:5", image_urls: [expect.stringMatching(/\/api\/render-inputs\/[0-9a-f-]{36}\/\d+\?token=/)] });
    const post = (await call(worker, env, "GET", `/api/posts/${created.data.id}`, undefined, user.cookie)).data.post;
    expect(post).toMatchObject({ renderStatus: "ready", videoAssetId: null, duration: 0, aspect: "4:5" });
    expect(post.slides).toHaveLength(4);
    expect(post.coverAssetId).toBe(post.slides[0]);
    expect(post.spec.slides[0].image).toMatchObject({ assetId: expect.any(String), prompt: "The mascot on a beach at sunset" });
    const log = env.MEDIA_RENDERER.log;
    expect(log.map((p: any) => p.operation)).toEqual(["stills"]);
    expect(log[0]).toMatchObject({ width: 1080, height: 1350, synthetic: true });
    expect(log[0].slides[0].box).toEqual({ x: 0, y: 0, w: 1080, h: 1350, radius: 0 });
    const files = sqlite.prepare("SELECT kind,width,height,meta FROM media_assets WHERE post_id=? AND kind='slide'").all(post.id) as any[];
    expect(files).toHaveLength(4);
    expect(files.every((f) => f.width === 1080 && f.height === 1350 && f.meta === '{"ai":true}')).toBe(true);
    // A text edit makes the slides again for free.
    const edited = await call(worker, env, "PUT", `/api/posts/${post.id}`, { spec: { ...post.spec, slides: post.spec.slides.map((s: any, i: number) => (i === 1 ? { ...s, title: "Tip one, better" } : s)) }, idempotencyKey: crypto.randomUUID() }, user.cookie);
    expect(edited.data).toMatchObject({ rendering: true, credits: 0 });
    await run();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(env.MEDIA_RENDERER.log.map((p: any) => p.operation)).toEqual(["stills", "stills"]);
    // The PDF: one page per slide.
    const pdf = await worker.fetch(new Request(`${SITE}/api/posts/${post.id}/pdf`, { headers: { Cookie: user.cookie } }), env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    const text = new TextDecoder("latin1").decode(await pdf.arrayBuffer());
    expect(text.match(/\/Type \/Page /g)).toHaveLength(4);
  });
});

describe("the PDF", () => {
  it("reads a JPEG's size and writes a valid PDF with a page per slide, the JPEGs as they are", () => {
    expect(jpegInfo(jpeg(1080, 1350))).toEqual({ width: 1080, height: 1350, components: 3 });
    expect(jpegInfo(new Uint8Array([1, 2, 3]))).toBeNull();
    const pages = [jpeg(1080, 1350), jpeg(1080, 1080)];
    const bytes = jpegsToPdf(pages, "Five (tips)");
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 1080 1350]");
    expect(text).toContain("/MediaBox [0 0 1080 1080]");
    expect(text).toContain("/Title (Five \\(tips\\))");
    expect(text.match(/\/Filter \/DCTDecode/g)).toHaveLength(2);
    // Every xref offset points at its object.
    const xref = Number(text.match(/startxref\n(\d+)/)![1]);
    const table = text.slice(xref).split("\n").slice(3).filter((l) => /^\d{10} 00000 n $/.test(l)).map((l) => Number(l.slice(0, 10)));
    expect(table).toHaveLength(3 + 2 * 3);
    table.forEach((offset, i) => expect(text.slice(offset, offset + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(() => jpegsToPdf([new Uint8Array([1, 2])])).toThrow();
  });
});

describe("publishing", () => {
  const row = (extra: Partial<PostRow> = {}): PostRow => ({
    id: "p", user_id: "u", workspace_id: "w", format: "carousel", spec: "{}", hook: "", caption: "", title: "", status: "approved", render_status: "ready",
    video_asset: null, cover_asset: "a", slides: JSON.stringify(["a", "b", "c"]), duration: 0, ...extra,
  });
  it("goes out as photos on Instagram, TikTok and LinkedIn, and never to YouTube", () => {
    expect(unfit(row(), "instagram")).toBeNull();
    expect(unfit(row(), "tiktok")).toBeNull();
    expect(unfit(row(), "linkedin")).toBeNull();
    expect(unfit(row(), "youtube")).toBe("YouTube takes videos only, so a carousel can't go there. Post it to Instagram, TikTok or LinkedIn.");
    expect(unfit(row({ slides: "[]" }), "instagram")).toBe("This post has no slides to send to Instagram.");
    // A slideshow still goes to YouTube as its video.
    expect(unfit(row({ format: "slideshow", video_asset: "v", duration: 12 }), "youtube")).toBeNull();
  });

  const KEYS = { TIKTOK_CLIENT_KEY: "k", TIKTOK_CLIENT_SECRET: "s", INSTAGRAM_APP_ID: "i", INSTAGRAM_APP_SECRET: "s", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", LINKEDIN_CLIENT_ID: "l", LINKEDIN_CLIENT_SECRET: "s" };
  async function setup() {
    const { env, sqlite } = testEnv(KEYS);
    const user = signedIn(sqlite);
    subscribe(sqlite, user.id, "starter");
    const workspace = crypto.randomUUID(), t = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO workspaces(id,user_id,name,settings,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(workspace, user.id, "Brand", JSON.stringify({ schedule: { timezone: "UTC", times: ["09:00"] } }), t, t);
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,posts_quota) VALUES (?,?,?,?,?)").run(`${user.id}:trial`, user.id, "free", 10, 15);
    sqlite.prepare("INSERT INTO media_limits(user_id,max_bytes) VALUES (?,?)").run(user.id, 1024 ** 3);
    const post = crypto.randomUUID(), slides: string[] = [];
    sqlite.prepare("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,hook,caption,status,render_status,duration,created_at,updated_at) VALUES (?,?,?,?,'carousel',?,?,?,'approved','ready',0,?,?)")
      .run(post, user.id, workspace, `${user.id}:trial`, JSON.stringify({ caption: "Five tips.", hashtags: ["#tips"], title: "" }), "Five tips", "Five tips.", t, t);
    for (let i = 0; i < 10; i++) {
      const a = crypto.randomUUID(), key = `media/${user.id}/${post}/${a}`;
      sqlite.prepare("INSERT INTO media_assets(id,user_id,workspace_id,post_id,kind,name,object_key,mime,bytes,created_at,updated_at) VALUES (?,?,?,?,'slide','s',?,'image/jpeg',64,?,?)").run(a, user.id, workspace, post, key, t, t);
      await env.MEDIA.put(key, jpeg(), { httpMetadata: { contentType: "image/jpeg" } });
      slides.push(a);
    }
    sqlite.prepare("UPDATE posts SET slides=?,cover_asset=? WHERE id=?").run(JSON.stringify(slides), slides[0], post);
    const account = async (platform: string) => {
      const a = crypto.randomUUID();
      sqlite.prepare("INSERT INTO social_accounts(id,user_id,workspace_id,platform,external_id,name,handle,credentials,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'active',?,?)")
        .run(a, user.id, workspace, platform, platform === "instagram" ? "555" : `${platform}-user`, platform, "brand", await seal(env, { accessToken: `${platform}-access`, refreshToken: "r", expiresAt: t + 86400 * 30 }), t, t);
      return a;
    };
    return { env, sqlite, user, workspace, post, slides, account };
  }

  it("is refused for a YouTube account when scheduled, and skipped by auto-scheduling", async () => {
    const s = await setup();
    const youtube = await s.account("youtube"), instagram = await s.account("instagram");
    const r = await call(worker, s.env, "POST", `/api/posts/${s.post}/schedule`, { accountIds: [youtube] }, s.user.cookie);
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/YouTube takes videos only/);
    s.sqlite.prepare("UPDATE workspaces SET settings=? WHERE id=?").run(JSON.stringify({ schedule: { timezone: "UTC", times: ["12:00"], autoSchedule: true, accounts: [youtube, instagram] } }), s.workspace);
    expect(await autoSchedule(s.env, s.user.id, s.post)).toBe(1);
    expect((s.sqlite.prepare("SELECT platform FROM publications WHERE post_id=?").all(s.post) as any[]).map((p) => p.platform)).toEqual(["instagram"]);
  });

  it("posts an Instagram carousel of all ten slides", async () => {
    const s = await setup();
    const account = await s.account("instagram");
    const pub = crypto.randomUUID(), t = Math.floor(Date.now() / 1000);
    s.sqlite.prepare("INSERT INTO publications(id,user_id,workspace_id,post_id,account_id,platform,scheduled_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(pub, s.user.id, s.workspace, s.post, account, "instagram", t - 5, "publishing", t, t);
    s.sqlite.prepare("UPDATE publications SET token=?,claimed_at=?,attempts=1 WHERE id=?").run("a".repeat(64), t, pub);
    const bodies: URLSearchParams[] = [];
    let n = 100;
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const url = String(input), method = (init.method || "GET").toUpperCase();
      if (method === "POST" && url.endsWith("/555/media")) { bodies.push(init.body); return Response.json({ id: String(n++) }); }
      if (method === "POST" && url.endsWith("/555/media_publish")) return Response.json({ id: "900" });
      if (url.startsWith("https://graph.instagram.com/v23.0/110")) return Response.json({ status_code: "FINISHED" });
      if (url.startsWith("https://graph.instagram.com/v23.0/900")) return Response.json({ permalink: "https://www.instagram.com/p/X/" });
      throw new Error(`unexpected ${method} ${url}`);
    });
    await new Publication({} as any, s.env).run({ payload: { publicationId: pub }, instanceId: `pub-${pub}-1` } as any, step as any);
    expect(s.sqlite.prepare("SELECT status,external_id FROM publications WHERE id=?").get(pub)).toEqual({ status: "published", external_id: "900" });
    expect(bodies).toHaveLength(11);
    expect(bodies.slice(0, 10).every((b) => b.get("is_carousel_item") === "true" && /\/\d\.jpg\?token=/.test(b.get("image_url")!))).toBe(true);
    expect(bodies[10].get("media_type")).toBe("CAROUSEL");
    expect(bodies[10].get("children")!.split(",")).toHaveLength(10);
    expect(bodies.some((b) => b.get("video_url"))).toBe(false);
  });
});

describe("the writer", () => {
  const catalog = { images: [{ ref: "img1", id: id(1), name: "Hero" }], videos: [], clips: [], greens: [], music: [], characters: [] };
  const profile = { name: "Guide", colors: { primary: "#f26b1d", accent: "#1e2433" } } as any;
  const concept = (extra: Partial<Concept> = {}): Concept => ({
    format: "carousel", pattern: "mistakes", topic: "Pricing", why: "Saves time.", text: "", slides: [], background: "", greenScreen: "", hookClip: "", demo: "", demoText: "",
    script: "", character: "", voice: "", music: "", caption: "Most agencies underprice AI work. Here is what to fix.", hashtags: ["#ai"], title: "",
    theme: "bold", ctaType: "comment", ctaKeyword: "price list",
    cards: [
      { kind: "content", title: "5 pricing mistakes 💸", body: "", label: "", image: "ai: a striking photo of a calculator on a desk" },
      ...Array.from({ length: 10 }, (_, i) => ({ kind: "content", title: `Point ${i + 1}`, body: "One idea.", label: `0${i + 1}`, image: i === 0 ? "img1" : "" })),
      { kind: "cta", title: "Want the list?", body: "We'll send it.", label: "", image: "img1" },
    ],
    ...extra,
  });
  const request = (useCredits: boolean) => ({ catalog, useCredits, caps: { aiMedia: true, talking: false }, mention: true, profile, kit: undefined });

  it("follows the formula: the cover first, one point a slide, the call to action last, ten slides at most", () => {
    const spec = conceptToSpec(concept(), "carousel", request(true)) as CarouselSpec;
    expect(spec.slides).toHaveLength(10);
    expect(spec.slides.map((s) => s.kind)).toEqual(["cover", ...Array(8).fill("content"), "cta"]);
    expect(spec.slides[0]).toMatchObject({ title: "5 pricing mistakes", image: { prompt: "a striking photo of a calculator on a desk" } });
    expect(spec.slides[1].image).toEqual({ assetId: id(1) });
    expect(spec.slides[9].image).toBeUndefined();
    expect(spec).toMatchObject({ theme: "bold", aspect: "4:5", cover: "image", cta: { type: "comment", keyword: "PRICELIST" } });
    // The caption ends with the same call to action as the last slide.
    expect(spec.caption).toBe("Most agencies underprice AI work. Here is what to fix.\n\nComment PRICELIST and I'll send you the link");
    expect(specCredits(spec)).toBe(IMAGE_CREDITS);
  });

  it("uses AI pictures only with AI credits, and picks a theme that fits the pictures it has", () => {
    const spec = conceptToSpec(concept({ theme: "photo" }), "carousel", request(false)) as CarouselSpec;
    // Without credits the cover falls back to the owner's image; Photo needs pictures on most slides.
    expect(spec.slides[0].image).toEqual({ assetId: id(1) });
    expect(pendingMedia(spec)).toEqual([]);
    expect(spec.theme).toBe("dark");
    const plain = conceptToSpec(concept({ ctaType: "comment", ctaKeyword: "" }), "carousel", { ...request(false), mention: false }) as CarouselSpec;
    expect(plain.cta.type).toBe("save");
    expect(conceptToSpec(concept({ cards: [{ kind: "cover", title: "Only", body: "", label: "", image: "" }] }), "carousel", request(true))).toBeNull();
    expect(feasible(["carousel"], catalog, { aiMedia: false, talking: false }, false).ok).toEqual(["carousel"]);
  });

  it("writes carousels through the API with the brand kit, the formula and the keywords in the caption", async () => {
    const { env, sqlite } = testEnv({ MEDIA_ENABLED: "true" });
    const user = signedIn(sqlite);
    subscribe(sqlite, user.id, "starter");
    const w = (await call(worker, env, "POST", "/api/workspaces", { name: "Guide" }, user.cookie)).data.workspace;
    await call(worker, env, "PATCH", `/api/workspaces/${w.id}`, { settings: { watermark: "@guide" } }, user.cookie);
    const seen: any[] = [];
    env.AI.run = async (_m: string, input: any) => {
      seen.push(input);
      return { status: "completed", output_text: JSON.stringify({ posts: [concept({ theme: "quote" })] }) };
    };
    const r = await call(worker, env, "POST", `/api/workspaces/${w.id}/ideas`, { count: 1, formats: ["carousel"], useCredits: false }, user.cookie);
    expect(r.status).toBe(200);
    expect(r.data.specs[0]).toMatchObject({ format: "carousel", theme: "quote", brand: { handle: "@guide" } });
    expect(seen[0].instructions).toMatch(/carousel \(an Instagram carousel/);
    expect(seen[0].instructions).toMatch(/3–5 niche keywords/);
    expect(seen[0].instructions).toMatch(/AI images and clips are NOT allowed/);
    // A saved kit pointing at someone else's picture is refused.
    const bad = await call(worker, env, "PATCH", `/api/workspaces/${w.id}`, { settings: { carousel: { handle: "@x", referenceId: id(5) } } }, user.cookie);
    expect(bad.status).toBe(400);
  });
});

describe("Instagram saves", () => {
  it("reads the saved insight and shows save and share rates against the rules of thumb", () => {
    expect(instagramInsights({ data: [{ name: "views", values: [{ value: 1000 }] }, { name: "shares", values: [{ value: 50 }] }, { name: "saved", values: [{ value: 80 }] }] }))
      .toEqual({ views: 1000, shares: 50, saves: 80 });
    expect(rates({ views: 1000, saves: 80, shares: 30 })).toEqual({ saves: 0.08, shares: 0.03 });
    expect(rates({ views: null, saves: 5, shares: 1 })).toEqual({ saves: null, shares: null });
    expect(rates({ views: 1000, saves: null, shares: null })).toEqual({ saves: null, shares: null });
    expect(RATE_HINTS).toEqual({ saves: 0.07, shares: 0.04 });
  });
});

describe("migration 0006 (posts without a format list, Instagram saves)", () => {
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const sql = (f: string) => readFileSync(new URL(f, dir), "utf8");
  /** A database with every migration before 0006 and rows in posts and every table that points at them. */
  function before() {
    const db = new DatabaseSync(":memory:");
    for (const f of files.filter((f) => f < "0006")) db.exec(sql(f));
    db.exec(`
      INSERT INTO users(id,email,name,password_hash,created_at) VALUES ('u','u@x.com','U','x',1);
      INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES ('w','u','W',1,1);
      INSERT INTO usage_windows(id,user_id,plan,quota,used,posts_quota,posts_used) VALUES ('u:trial','u','free',10,0,4,0);
      INSERT INTO media_limits(user_id,max_bytes) VALUES ('u',1000000);
      INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,created_at,updated_at) VALUES ('p1','u','w','u:trial','story','{}',1,1),('p2','u','w','u:trial','clip','{}',2,2);
      INSERT INTO runs(id,user_id,post_id,window_id,idempotency_key,kind,initial,credits,status,created_at,updated_at) VALUES ('r1','u','p1','u:trial','k1','post',1,3,'completed',1,1),('r2','u','p2','u:trial','k2','post',1,2,'running',2,2),('r3','u',NULL,'u:trial','k3','speech',0,1,'completed',3,3);
      INSERT INTO media_assets(id,user_id,workspace_id,post_id,kind,name,object_key,mime,bytes,status,created_at,updated_at) VALUES ('m1','u','w','p1','render','Video','media/u/m1.mp4','video/mp4',100,'ready',1,1),('m2','u','w',NULL,'upload','Upload','media/u/m2.mp4','video/mp4',100,'uploading',1,1);
      INSERT INTO media_parts(asset_id,part,etag,bytes) VALUES ('m2',1,'e',50);
      INSERT INTO social_accounts(id,user_id,workspace_id,platform,external_id,name,credentials,created_at,updated_at) VALUES ('a','u','w','instagram','x','A','c',1,1);
      INSERT INTO publications(id,user_id,workspace_id,post_id,account_id,platform,scheduled_at,status,views,shares,created_at,updated_at) VALUES ('pub1','u','w','p1','a','instagram',5,'published',42,3,1,1);
      INSERT INTO tracked_links(code,workspace_id,post_id,platform,created_at) VALUES ('c1','w','p1','instagram',1);
    `);
    return db;
  }
  const dump = (db: DatabaseSync) => Object.fromEntries(["posts", "runs", "media_assets", "media_parts", "publications", "usage_windows", "cleanup_tasks", "tracked_links"]
    .map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  const schema = (db: DatabaseSync) => db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name IN ('posts','runs','media_assets','publications') AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name").all() as any[];
  /** As D1 applies a migration: one transaction, foreign keys enforced. */
  const apply = (db: DatabaseSync, text: string) => { db.exec("PRAGMA foreign_keys=ON; BEGIN"); try { db.exec(text); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } };

  it("keeps every row of posts and what points at them, and every index and trigger word for word", () => {
    const db = before();
    const rows = dump(db), indexes = schema(db);
    apply(db, sql("0006_carousels.sql"));
    const after = dump(db);
    // Publications gain an empty saves column; everything else is exactly as it was.
    expect(after.publications).toEqual(rows.publications.map((p: any) => ({ ...p, saves: null })));
    expect({ ...after, publications: [] }).toEqual({ ...rows, publications: [] });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(schema(db)).toEqual(indexes);
    expect(indexes.map((x) => x.name)).toEqual(expect.arrayContaining(["post_busy", "post_count", "post_quota", "posts_review", "posts_workspace"]));
    for (const child of ["runs", "media_assets", "publications"]) expect((db.prepare(`PRAGMA foreign_key_list(${child})`).all() as any[]).some((f) => f.table === "posts")).toBe(true);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%_copy'").all()).toEqual([]);
  });

  it("takes carousels (and any later format), and its triggers and cascades still work", () => {
    const db = before();
    apply(db, sql("0006_carousels.sql"));
    expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name='posts'").get()).toEqual({ sql: expect.stringContaining("format TEXT NOT NULL, spec") });
    db.prepare("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,created_at,updated_at) VALUES ('p3','u','w','u:trial','carousel','{}',3,3)").run();
    db.prepare("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,created_at,updated_at) VALUES ('p4','u','w','u:trial','a_later_format','{}',3,3)").run();
    expect(db.prepare("SELECT posts_used FROM usage_windows").get()).toEqual({ posts_used: 4 });
    expect(() => db.prepare("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,created_at,updated_at) VALUES ('p5','u','w','u:trial','text','{}',3,3)").run()).toThrow(/POSTS_EXCEEDED/);
    expect(() => db.prepare("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,status,created_at,updated_at) VALUES ('p6','u','w','u:trial','text','{}','maybe',3,3)").run()).toThrow(/CHECK|POSTS_EXCEEDED/);
    db.prepare("UPDATE publications SET saves=12 WHERE id='pub1'").run();
    expect(db.prepare("SELECT saves FROM publications").get()).toEqual({ saves: 12 });
    // A post being made is not deleted; a finished one takes its runs, files and publications with it.
    expect(() => db.prepare("DELETE FROM posts WHERE id='p2'").run()).toThrow(/POST_BUSY/);
    db.prepare("DELETE FROM posts WHERE id='p1'").run();
    expect([db.prepare("SELECT COUNT(*) n FROM runs WHERE post_id='p1'").get(), db.prepare("SELECT COUNT(*) n FROM publications").get(), db.prepare("SELECT prefix FROM cleanup_tasks").all()])
      .toEqual([{ n: 0 }, { n: 0 }, [{ prefix: "media/u/m1.mp4" }]]);
  });
});
