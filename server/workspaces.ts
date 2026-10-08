import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App, DbUser, Env } from "./types";
import { now, uid, DAY } from "./types";
import { dbFailure, json, ownedWorkspace } from "./db";
import { rate, hit } from "./security";
import { allowance } from "./billing";
import { websiteSchema, scanMessages } from "./scan";
import { canCreate, checkReferences, createPost } from "./posts";
import { capabilities, conceptToSpec, feasible, formatPlan, loadCatalog, recentHooks, workspaceProfile, writeConcepts } from "./ideas";
import { formatIds, type FormatId, type Spec } from "../shared/formats";
import { profileSchema } from "../shared/profile";
import { settingsSchema, defaultSettings, validZone, type WorkspaceSettings } from "../shared/schedule";
import { planById } from "../shared/plans";
import { writingStyleIds } from "../shared/hooks";

// Workspaces: one brand each — its profile (from the website scan), settings (schedule, automations) and posts.
export const workspaces = new Hono<App>();

function workspaceView(w: any, extra: Record<string, unknown> = {}) {
  return {
    id: w.id, name: w.name, website: w.website, description: w.description, logoAssetId: w.logo_asset,
    profile: workspaceProfile(w), settings: workspaceSettings(w),
    scan: { status: w.scan_status, step: w.scan_step, error: w.scan_error ? scanMessages[w.scan_error] || "The analysis didn't finish. Try again, or fill in your brand by hand." : null, at: w.scanned_at },
    createdAt: w.created_at, ...extra,
  };
}
export function workspaceSettings(w: { settings: string }): WorkspaceSettings {
  const parsed = settingsSchema.safeParse(json(w.settings, {}));
  return parsed.success ? parsed.data : defaultSettings();
}
async function ownedImage(env: Env, userId: string, id: string) {
  const a = await env.DB.prepare("SELECT id FROM media_assets WHERE id=? AND user_id=? AND status='ready' AND mime LIKE 'image/%'").bind(id, userId).first();
  if (!a) throw new HTTPException(400, { message: "Upload the logo as a JPG, PNG or WebP image." });
}

workspaces.get("/", async (c) => {
  const user = c.get("user");
  const rows = (await c.env.DB.prepare(
    "SELECT w.*,(SELECT COUNT(*) FROM posts p WHERE p.workspace_id=w.id AND p.status='pending' AND p.render_status='ready') AS ready FROM workspaces w WHERE w.user_id=? ORDER BY w.created_at",
  ).bind(user.id).all<any>()).results;
  return c.json({ workspaces: rows.map((w) => workspaceView(w, { ready: w.ready })) });
});
workspaces.post("/", async (c) => {
  const user = c.get("user");
  await rate(c, "workspace-create", 20, 3600, user.id);
  const d = z.object({
    name: z.string().trim().min(1).max(80),
    logoAssetId: z.uuid().nullable().optional(),
    timezone: z.string().max(64).optional(),
  }).parse(await c.req.json());
  const a = await allowance(c.env, user);
  const plan = planById(a.plan);
  const count = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE user_id=?").bind(user.id).first<{ n: number }>())?.n || 0;
  if (count >= plan.workspaces)
    throw new HTTPException(402, { message: plan.workspaces === 1 ? "Your plan has one workspace. Upgrade to Growth for more brands." : `Your plan has ${plan.workspaces} workspaces. Upgrade for more.` });
  if (d.logoAssetId) await ownedImage(c.env, user.id, d.logoAssetId);
  const settings = defaultSettings();
  if (d.timezone && validZone(d.timezone)) settings.schedule.timezone = d.timezone;
  const id = uid(), t = now();
  await c.env.DB.prepare("INSERT INTO workspaces(id,user_id,name,logo_asset,profile,settings,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id, user.id, d.name, d.logoAssetId || null, JSON.stringify(profileSchema.parse({ name: d.name })), JSON.stringify(settings), t, t).run();
  if (d.logoAssetId) await c.env.DB.prepare("UPDATE media_assets SET workspace_id=? WHERE id=? AND user_id=?").bind(id, d.logoAssetId, user.id).run();
  return c.json({ workspace: workspaceView(await ownedWorkspace(c.env, user.id, id)) }, 201);
});
workspaces.get("/:id", async (c) => {
  const user = c.get("user");
  const w = await ownedWorkspace(c.env, user.id, c.req.param("id"));
  const images = (await c.env.DB.prepare(
    "SELECT id,kind,name,width,height FROM media_assets WHERE workspace_id=? AND user_id=? AND kind IN ('brand','upload','ai_image') AND mime LIKE 'image/%' AND status='ready' AND post_id IS NULL ORDER BY created_at DESC LIMIT 60",
  ).bind(w.id, user.id).all<any>()).results;
  return c.json({ workspace: workspaceView(w, { images }) });
});
workspaces.patch("/:id", async (c) => {
  const user = c.get("user");
  const w = await ownedWorkspace(c.env, user.id, c.req.param("id"));
  const d = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    logoAssetId: z.uuid().nullable().optional(),
    profile: z.record(z.string(), z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }).parse(await c.req.json());
  if (d.logoAssetId) await ownedImage(c.env, user.id, d.logoAssetId);
  // Partial updates are merged into the stored values and validated as a whole.
  const profile = d.profile ? profileSchema.parse({ ...workspaceProfile(w), ...d.profile }) : workspaceProfile(w);
  const settings = d.settings ? settingsSchema.parse({ ...workspaceSettings(w), ...d.settings }) : workspaceSettings(w);
  if (!validZone(settings.schedule.timezone)) throw new HTTPException(400, { message: "Choose a valid time zone." });
  if (settings.schedule.accounts.length) {
    const owned = (await c.env.DB.prepare(`SELECT id FROM social_accounts WHERE workspace_id=? AND id IN (${settings.schedule.accounts.map(() => "?").join(",")})`)
      .bind(w.id, ...settings.schedule.accounts).all()).results;
    if (owned.length !== settings.schedule.accounts.length) throw new HTTPException(400, { message: "Choose accounts connected to this workspace." });
  }
  const name = d.name ?? w.name;
  if (d.name) profile.name = d.name;
  await c.env.DB.prepare("UPDATE workspaces SET name=?,logo_asset=?,profile=?,settings=?,updated_at=? WHERE id=?")
    .bind(name, d.logoAssetId === undefined ? w.logo_asset : d.logoAssetId, JSON.stringify(profile), JSON.stringify(settings), now(), w.id).run();
  if (d.logoAssetId) await c.env.DB.prepare("UPDATE media_assets SET workspace_id=? WHERE id=? AND user_id=?").bind(w.id, d.logoAssetId, user.id).run();
  return c.json({ workspace: workspaceView(await ownedWorkspace(c.env, user.id, w.id)) });
});
/** Starts the brand analysis from a website / app store link, or from a written description. */
workspaces.post("/:id/analyze", async (c) => {
  const user = c.get("user");
  const w = await ownedWorkspace(c.env, user.id, c.req.param("id"));
  await rate(c, "workspace-analyze", 12, 3600, user.id);
  const d = z.union([
    z.object({ website: websiteSchema }),
    z.object({ description: z.string().trim().min(20, "Describe your business in a few sentences.").max(4000) }),
  ]).parse(await c.req.json());
  if (!c.env.SCAN) throw new HTTPException(503, { message: "Brand analysis is being set up. Fill in your brand by hand for now." });
  const website = "website" in d ? d.website : null, description = "description" in d ? d.description : null;
  await c.env.DB.prepare("UPDATE workspaces SET website=?,description=?,scan_status='scanning',scan_step=NULL,scan_error=NULL,updated_at=? WHERE id=?")
    .bind(website ?? w.website, description, now(), w.id).run();
  try {
    await c.env.SCAN.create({ id: `scan-${w.id}-${now()}`, params: { workspaceId: w.id } });
  } catch {
    await c.env.DB.prepare("UPDATE workspaces SET scan_status='failed',scan_error='SCAN_FAILED' WHERE id=?").bind(w.id).run();
    throw new HTTPException(503, { message: "The analysis couldn't start. Please try again." });
  }
  return c.json({ workspace: workspaceView(await ownedWorkspace(c.env, user.id, w.id)) }, 202);
});
workspaces.delete("/:id", async (c) => {
  const user = c.get("user");
  const w = await ownedWorkspace(c.env, user.id, c.req.param("id"));
  try {
    await c.env.DB.prepare("DELETE FROM workspaces WHERE id=?").bind(w.id).run();
  } catch (e) {
    dbFailure(e);
  }
  return c.json({ ok: true });
});

const generateSchema = z.object({
  count: z.number().int().min(1).max(10).default(5),
  formats: z.array(z.enum(formatIds)).min(1).max(5).optional(),
  mention: z.boolean().default(true),
  prompt: z.string().trim().max(400).optional(),
  style: z.enum(writingStyleIds as [string, ...string[]]).optional(),
  pattern: z.string().max(40).optional(),
  useCredits: z.boolean().default(false),
  /** Manual creation: media the owner picked (the writer uses only these). */
  inputs: z.object({
    backgroundLibraryId: z.uuid().optional(), backgroundAssetId: z.uuid().optional(), musicTrackId: z.uuid().optional(),
    demoAssetId: z.uuid().optional(), characterId: z.uuid().optional(), greenScreenId: z.uuid().optional(),
  }).default({}),
});
type GenerateRequest = z.infer<typeof generateSchema>;
/** Writes specs for a workspace (shared by drafts, Blitz batches and automations). */
export async function writeSpecs(env: Env, user: DbUser, w: any, d: GenerateRequest) {
  const catalog = await loadCatalog(env, user.id, w.id);
  const pick = <T extends { id: string }>(list: T[], id?: string) => (id ? list.filter((i) => i.id === id) : list);
  const i = d.inputs;
  if (i.backgroundLibraryId) catalog.clips = pick(catalog.clips, i.backgroundLibraryId);
  if (i.backgroundAssetId) { catalog.images = pick(catalog.images, i.backgroundAssetId); catalog.clips = []; }
  if (i.musicTrackId) catalog.music = pick(catalog.music, i.musicTrackId);
  if (i.demoAssetId) catalog.videos = pick(catalog.videos, i.demoAssetId);
  if (i.characterId) catalog.characters = pick(catalog.characters, i.characterId);
  if (i.greenScreenId) catalog.greens = pick(catalog.greens, i.greenScreenId);
  const caps = capabilities(env);
  const requested = (d.formats || workspaceSettings(w).formats) as FormatId[];
  const { ok, missing } = feasible(requested, catalog, caps, d.useCredits);
  if (!ok.length) throw new HTTPException(400, { message: Object.values(missing)[0] || "These formats can't be made yet." });
  const plan = formatPlan(ok, d.count);
  const request = {
    profile: workspaceProfile(w), plan, mention: d.mention, prompt: d.prompt, style: d.style as never, pattern: d.pattern,
    useCredits: d.useCredits, caps, recentHooks: await recentHooks(env, w.id), catalog,
  };
  const concepts = await writeConcepts(env, request);
  const specs: Spec[] = [];
  concepts.forEach((k, n) => {
    const spec = conceptToSpec(k, plan[n], request);
    if (spec) specs.push(spec);
  });
  if (!specs.length) throw new HTTPException(502, { message: "The posts we wrote didn't fit your media. Please try again." });
  return { specs, missing };
}
/** Manual creation: written posts to edit before saving (nothing is made or counted yet). */
workspaces.post("/:id/ideas", async (c) => {
  const user = c.get("user");
  const w = await ownedWorkspace(c.env, user.id, c.req.param("id"));
  await rate(c, "ideas", 60, 3600, user.id);
  if ((await hit(c.env, "ideas-day", DAY, user.id)) > 300) throw new HTTPException(429, { message: "That's a lot of ideas for one day. Try again tomorrow." });
  const d = generateSchema.parse(await c.req.json());
  const { specs, missing } = await writeSpecs(c.env, user, w, { ...d, count: Math.min(d.count, 3) });
  return c.json({ specs, missing });
});
/** Blitz: a batch of finished posts to swipe through. */
workspaces.post("/:id/batch", async (c) => {
  const user = c.get("user");
  const w = await ownedWorkspace(c.env, user.id, c.req.param("id"));
  await rate(c, "batch", 20, 3600, user.id);
  const d = generateSchema.parse(await c.req.json());
  const a = await allowance(c.env, user);
  canCreate(a);
  const count = Math.min(d.count, a.postsLimit - a.postsUsed);
  const { specs, missing } = await writeSpecs(c.env, user, w, { ...d, count });
  return c.json({ ...(await createBatch(c.env, user, w.id, specs)), missing }, 201);
});
/** Creates the posts of a batch one by one: one that cannot be paid for is skipped, the rest go ahead. */
export async function createBatch(env: Env, user: DbUser, workspaceId: string, specs: Spec[]) {
  const batchId = uid(), created: string[] = [], skipped: string[] = [];
  for (const spec of specs) {
    try {
      await checkReferences(env, user.id, spec);
      const a = await allowance(env, user);
      created.push((await createPost(env, user, workspaceId, spec, a, uid(), batchId)).id);
    } catch (e) {
      skipped.push(e instanceof HTTPException ? e.message : "This post couldn't be started.");
      if (e instanceof HTTPException && e.status === 503) throw e;
    }
  }
  if (!created.length) throw new HTTPException(402, { message: skipped[0] || "No posts could be started." });
  return { batchId, created, skipped };
}
