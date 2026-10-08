import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";
import { MB, now, uid } from "./types";
import { withDefaults, siteUrl } from "./config";
import { json } from "./db";
import { safeEqual, token } from "./security";
import { extOf, head, imageInfo, mediaKey, serveObject, storedDuration, storeStream } from "./storage";
import { fetchOutput } from "./providers/http";
import { falResult, falStatus, submitFal, type FalTicket } from "./providers/fal";
import { speak } from "./providers/elevenlabs";
import { avatarVideoStatus, deleteAvatarVideo, submitAvatarVideo, type HeyGenTicket } from "./providers/heygen";
import { releaseRender, renderFailures, renderFile, renderStatus, submitRender } from "./renderer";
import { planRender, type Media, type PlanContext } from "./render-plan";
import { failAsset } from "./media";
import { workspaceSettings } from "./workspaces";
import { workspaceProfile } from "./ideas";
import {
  pendingMedia, recordingCurrent, recordingKey, referencedAssets, referencedLibrary, specSchema, talking, type Spec,
} from "../shared/formats";
import type { RenderPayload, RenderStatus } from "../shared/render";
import { IMAGE_CREDITS } from "../shared/credits";

// A run makes a post ready: AI images/clips it asks for, the talking creator (voice, then lip-synced video), then the
// render (video, cover and, for slideshows, the slides as pictures). Paid provider calls are made once: a claim is
// stored before each call and its ticket right after, so a retried step polls the existing job instead of paying
// again; a claim without a ticket (the answer was lost) fails the run and refunds the credits.

type RunState = {
  token?: string;
  inputs?: string[];
  claims?: Record<string, boolean>;
  tickets?: Record<string, unknown>;
  assets?: Record<string, string>;
  slots?: Record<string, number>;
  jobs?: Record<string, string>;
};
const readState = async (e: Env, id: string) => json<RunState>((await e.DB.prepare("SELECT provider FROM runs WHERE id=?").bind(id).first<{ provider: string }>())?.provider, {});
async function patchState(e: Env, id: string, patch: (s: RunState) => void) {
  const s = await readState(e, id);
  patch(s);
  await e.DB.prepare("UPDATE runs SET provider=?,updated_at=? WHERE id=?").bind(JSON.stringify(s), now(), id).run();
  return s;
}
/** A capability link for one stored file, valid while the run works (the renderer, HeyGen and fal fetch these). */
async function inputUrl(e: Env, runId: string, key: string) {
  const s = await patchState(e, runId, (s) => {
    s.inputs ||= [];
    if (!s.inputs.includes(key)) s.inputs.push(key);
  });
  return `${siteUrl(e)}/api/render-inputs/${runId}/${s.inputs!.indexOf(key)}?token=${s.token}`;
}

const messages: Record<string, string> = {
  ...renderFailures,
  GENERATION_REJECTED: "An AI image or clip was refused by the content filter. Describe it differently.",
  GENERATION_UNAVAILABLE: "AI images are temporarily unavailable. Try again later.",
  GENERATION_TIMEOUT: "The AI image or clip took too long. Try again.",
  GENERATION_UNCERTAIN: "We lost track of an AI image request. Try again.",
  VOICE_UNAVAILABLE: "AI voices are temporarily unavailable. Try again later.",
  VOICE_FAILED: "The voice couldn't be recorded. Try again.",
  AVATAR_REJECTED: "The AI creator video was refused by the content filter. Change the script and try again.",
  AVATAR_UNAVAILABLE: "AI creators are temporarily unavailable. Try again later.",
  AVATAR_TIMEOUT: "The AI creator video took too long. Try again.",
  AVATAR_FAILED: "The AI creator video couldn't be made. Try again.",
  POST_INVALID: "This post's settings aren't valid any more. Open it and save it again.",
};
/** Fails a run exactly once (the trigger refunds its credits) and tells its post why. */
export async function failRun(e: Env, id: string, code = "INTERNAL") {
  const run = await e.DB.prepare("SELECT post_id,credits,status FROM runs WHERE id=?").bind(id).first<any>();
  if (!run || !["queued", "running"].includes(run.status)) return;
  const message = `${messages[code] || "This post couldn't be made. Please try again."}${run.credits > 0 ? " Your credits were refunded." : ""}`;
  await e.DB.batch([
    e.DB.prepare("UPDATE runs SET status='failed',phase='failed',error=?,updated_at=? WHERE id=? AND status IN ('queued','running')").bind(/^[A-Z_]{2,40}$/.test(code) ? code : "INTERNAL", now(), id),
    ...(run.post_id ? [e.DB.prepare("UPDATE posts SET render_status='failed',render_error=?,updated_at=? WHERE id=? AND render_status IN ('queued','running')").bind(message, now(), run.post_id)] : []),
  ]);
}

const once = { retries: { limit: 0, delay: "1 second" as const }, timeout: "10 minutes" as const };
const safe = { retries: { limit: 2, delay: "10 seconds" as const }, timeout: "5 minutes" as const };

export class ContentGeneration extends WorkflowEntrypoint<Env, { runId?: string; inspectId?: string }> {
  async run(event: WorkflowEvent<{ runId?: string; inspectId?: string }>, step: WorkflowStep) {
    const e = withDefaults(this.env);
    if (event.payload.inspectId) return inspectUpload(e, step, event.payload.inspectId);
    const id = event.payload.runId!;
    const run = await step.do("load", async () => {
      const r = await e.DB.prepare("SELECT * FROM runs WHERE id=? AND status IN ('queued','running')").bind(id).first<any>();
      if (!r) return null;
      await e.DB.batch([
        e.DB.prepare("UPDATE runs SET status='running',updated_at=? WHERE id=?").bind(now(), id),
        ...(r.post_id ? [e.DB.prepare("UPDATE posts SET render_status='running',updated_at=? WHERE id=? AND render_status='queued'").bind(now(), r.post_id)] : []),
      ]);
      await patchState(e, id, (s) => { s.token ||= token(); s.jobs ||= { compose: uid(), stills: uid() }; });
      return { id: r.id as string, user_id: r.user_id as string, post_id: r.post_id as string | null, kind: r.kind as string, payload: json<any>(r.payload, {}) };
    });
    if (!run) return;
    const phase = (value: string) => e.DB.prepare("UPDATE runs SET phase=?,updated_at=? WHERE id=?").bind(value, now(), id).run();
    try {
      if (run.kind === "post") await makePost(e, step, run, phase);
      else await makeStandalone(e, step, run, phase);
      await step.do("complete", async () => {
        await e.DB.prepare("UPDATE runs SET status='completed',phase='done',updated_at=? WHERE id=? AND status='running'").bind(now(), id).run();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = /^[A-Z][A-Z_]{2,40}$/.test(message) ? message : "INTERNAL";
      console.error("Run failed", { runId: id, kind: run.kind, code });
      await step.do("stop-renders", async () => {
        const s = await readState(e, id);
        for (const [name, job] of Object.entries(s.jobs || {})) if (s.slots?.[name] !== undefined) await releaseRender(e, s.slots[name], job);
      });
      await step.do("fail", () => failRun(e, id, code));
    }
  }
}

type Phase = (value: string) => Promise<unknown>;
type RunInfo = { id: string; user_id: string; post_id: string | null; kind: string; payload: any };

/** One AI image or clip, paid once; returns the stored asset's ID. */
async function generateMedia(e: Env, step: WorkflowStep, run: RunInfo, name: string, kind: "image" | "clip", prompt: string, owner: { workspaceId: string | null; postId: string | null; assetKind: "ai_image" | "ai_clip" | "portrait"; label: string }, phase: Phase) {
  const ticket = await step.do(`${name}-submit`, once, async () => {
    const s = await readState(e, run.id);
    if (s.tickets?.[name]) return s.tickets[name] as FalTicket;
    if (s.claims?.[name]) throw new Error("GENERATION_UNCERTAIN");
    await patchState(e, run.id, (s) => { (s.claims ||= {})[name] = true; });
    await phase(kind === "clip" ? "clip" : "images");
    const t = await submitFal(e, kind, prompt);
    await patchState(e, run.id, (s) => { (s.tickets ||= {})[name] = t; });
    return t;
  });
  let done = false;
  for (let i = 0; i < 150 && !done; i++) {
    done = (await step.do(`${name}-status-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "1 minute" }, () => falStatus(e, ticket))) === "done";
    if (!done) await step.sleep(`${name}-wait-${i}`, kind === "image" ? "4 seconds" : "10 seconds");
  }
  if (!done) throw new Error("GENERATION_TIMEOUT");
  return step.do(`${name}-save`, safe, async () => {
    const s = await readState(e, run.id);
    const existing = s.assets?.[name] && await e.DB.prepare("SELECT id FROM media_assets WHERE id=? AND status='ready'").bind(s.assets[name]).first();
    if (existing) return s.assets![name];
    const url = await falResult(e, kind, ticket);
    const assetId = s.assets?.[name] || uid();
    await patchState(e, run.id, (s) => { (s.assets ||= {})[name] = assetId; });
    const mime = kind === "image" ? "image/jpeg" : "video/mp4";
    const key = mediaKey(run.user_id, assetId, kind === "image" ? "jpg" : "mp4");
    const bytes = await storeStream(e, key, await fetchOutput(url, AbortSignal.timeout(180000)), kind === "image" ? 30 * MB : 150 * MB, mime);
    let width = 0, height = 0, duration = 0, actual = mime;
    if (kind === "image") {
      const info = imageInfo((await head(e, key)) || new Uint8Array());
      if (!info) throw new Error("GENERATION_FAILED");
      ({ width, height } = info);
      actual = info.mime;
    } else {
      duration = (await storedDuration(e, key, bytes)) ?? 5;
    }
    await e.DB.prepare(
      "INSERT OR REPLACE INTO media_assets(id,user_id,workspace_id,post_id,kind,name,object_key,mime,bytes,duration,width,height,status,meta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?,?)",
    ).bind(assetId, run.user_id, owner.workspaceId, owner.postId, owner.assetKind, owner.label.slice(0, 160), key, actual, bytes, duration, width, height, JSON.stringify({ prompt: prompt.slice(0, 400) }), now(), now()).run();
    return assetId;
  });
}

/** Writes a value into the stored spec at `path` (the post may have been edited meanwhile only by this run). */
async function updateSpec(e: Env, postId: string, change: (spec: any) => void) {
  const row = await e.DB.prepare("SELECT spec FROM posts WHERE id=?").bind(postId).first<{ spec: string }>();
  const spec = json<any>(row?.spec, null);
  if (!spec) throw new Error("POST_INVALID");
  change(spec);
  await e.DB.prepare("UPDATE posts SET spec=?,updated_at=? WHERE id=?").bind(JSON.stringify(spec), now(), postId).run();
}
async function loadSpec(e: Env, postId: string): Promise<{ spec: Spec; workspace: any }> {
  const row = await e.DB.prepare("SELECT p.spec,w.id AS wid,w.profile,w.settings FROM posts p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=?").bind(postId).first<any>();
  const parsed = specSchema.safeParse(json(row?.spec, null));
  if (!row || !parsed.success) throw new Error("POST_INVALID");
  return { spec: parsed.data, workspace: { id: row.wid, profile: row.profile, settings: row.settings } };
}

async function makePost(e: Env, step: WorkflowStep, run: RunInfo, phase: Phase) {
  const postId = run.post_id!;
  const { spec: first, workspace } = await step.do("spec", () => loadSpec(e, postId));
  // AI pictures and clips the spec asks for.
  const pending = pendingMedia(first);
  for (let i = 0; i < pending.length; i++) {
    const m = pending[i];
    const assetId = await generateMedia(e, step, run, `ai-${i}`, m.kind, m.prompt, {
      workspaceId: workspace.id, postId, assetKind: m.kind === "clip" ? "ai_clip" : "ai_image", label: `AI ${m.kind}: ${m.prompt}`,
    }, phase);
    await step.do(`ai-${i}-apply`, async () => updateSpec(e, postId, (spec) => {
      let target = spec;
      for (const part of m.path) target = target[part];
      target.assetId = assetId;
    }));
  }
  // The talking creator: voice, then the lip-synced video.
  const t = talking(first);
  if (t && !recordingCurrent(first)) await makeRecording(e, step, run, t, workspace, phase);
  // The render.
  const { spec } = await step.do("spec-final", () => loadSpec(e, postId));
  const ctx = await step.do("resolve", () => resolveContext(e, run.user_id, spec, workspace));
  const plan = planRender(spec, ctx);
  const outputs: Record<string, RenderStatus> = {};
  for (const job of ["compose", "stills"] as const) {
    const part = job === "compose" ? plan.compose : plan.stills;
    if (!part) continue;
    outputs[job] = await renderJob(e, step, run, job, part, phase);
  }
  await step.do("save", safe, async () => {
    await phase("saving");
    const s = await readState(e, run.id);
    const saved = s.assets || {};
    const store = async (name: string, job: "compose" | "stills", n: number, mime: string, kind: "render" | "slide", label: string, duration = 0) => {
      if (saved[name] && await e.DB.prepare("SELECT 1 FROM media_assets WHERE id=?").bind(saved[name]).first()) return saved[name];
      const assetId = uid(), key = mediaKey(run.user_id, assetId, extOf(mime));
      const bytes = await storeStream(e, key, await renderFile(e, s.slots![job], s.jobs![job], n), mime === "video/mp4" ? 400 * MB : 20 * MB, mime);
      await e.DB.prepare(
        "INSERT INTO media_assets(id,user_id,workspace_id,post_id,kind,name,object_key,mime,bytes,duration,width,height,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1080,1920,'ready',?,?)",
      ).bind(assetId, run.user_id, workspace.id, postId, kind, label, key, mime, bytes, duration, now(), now()).run();
      await patchState(e, run.id, (st) => { (st.assets ||= {})[name] = assetId; });
      saved[name] = assetId;
      return assetId;
    };
    const duration = outputs.compose.duration || 0;
    const video = await store("video", "compose", 0, "video/mp4", "render", "Post video", duration);
    const cover = (outputs.compose.files || 1) > 1 ? await store("cover", "compose", 1, "image/jpeg", "slide", "Post cover") : null;
    const slides: string[] = [];
    if (outputs.stills) for (let n = 0; n < (outputs.stills.files || 0); n++) slides.push(await store(`slide-${n}`, "stills", n, "image/jpeg", "slide", `Slide ${n + 1}`));
    // Files of earlier versions of this post that the new one no longer uses are deleted (R2 cleanup follows).
    const current = await loadSpec(e, postId);
    const keep = new Set([video, cover, ...slides, ...referencedAssets(current.spec), ...(("generated" in current.spec && current.spec.generated) ? [current.spec.generated.voiceAssetId, current.spec.generated.videoAssetId] : [])].filter(Boolean) as string[]);
    const owned = (await e.DB.prepare("SELECT id FROM media_assets WHERE post_id=?").bind(postId).all<{ id: string }>()).results;
    const stale = owned.map((r) => r.id).filter((x) => !keep.has(x));
    await e.DB.batch([
      e.DB.prepare("UPDATE posts SET video_asset=?,cover_asset=?,slides=?,duration=?,render_status='ready',render_error=NULL,updated_at=? WHERE id=?")
        .bind(video, cover, JSON.stringify(slides), duration, now(), postId),
      ...stale.map((x) => e.DB.prepare("DELETE FROM media_assets WHERE id=?").bind(x)),
    ]);
  });
  await step.do("release", async () => {
    const s = await readState(e, run.id);
    for (const job of Object.keys(outputs)) await releaseRender(e, s.slots![job], s.jobs![job]);
  });
}

/** Voice (paid once) and the lip-synced creator video (submitted once, with the run ID as idempotency key). */
async function makeRecording(e: Env, step: WorkflowStep, run: RunInfo, t: { characterId: string; voiceId: string; text: string }, workspace: any, phase: Phase) {
  const voice = await step.do("voice", once, async () => {
    const s = await readState(e, run.id);
    if (s.assets?.voice && s.tickets?.words) return { assetId: s.assets.voice, seconds: Number(s.tickets.voiceSeconds) || 0, words: s.tickets.words as any[] };
    if (s.claims?.voice) throw new Error("VOICE_FAILED");
    await patchState(e, run.id, (s) => { (s.claims ||= {}).voice = true; });
    await phase("voice");
    const language = workspaceProfile(workspace).language || "en";
    const result = await speak(e, t.voiceId, t.text, language);
    const assetId = uid(), key = mediaKey(run.user_id, assetId, "wav");
    await e.MEDIA.put(key, result.audio, { httpMetadata: { contentType: "audio/wav" } });
    await e.DB.prepare(
      "INSERT INTO media_assets(id,user_id,workspace_id,post_id,kind,name,object_key,mime,bytes,duration,status,created_at,updated_at) VALUES (?,?,?,?,'voice','Voice',?,'audio/wav',?,?,'ready',?,?)",
    ).bind(assetId, run.user_id, workspace.id, run.post_id, key, result.audio.length, result.seconds, now(), now()).run();
    await patchState(e, run.id, (s) => { (s.assets ||= {}).voice = assetId; (s.tickets ||= {}).words = result.words; s.tickets.voiceSeconds = result.seconds; });
    return { assetId, seconds: result.seconds, words: result.words };
  });
  const ticket = await step.do("avatar-submit", once, async () => {
    const s = await readState(e, run.id);
    if (s.tickets?.avatar) return s.tickets.avatar as HeyGenTicket;
    // A claimed submission whose answer was lost is sent again with the same Idempotency-Key: HeyGen returns the
    // same video instead of making (and billing) a second one.
    await patchState(e, run.id, (s) => { (s.claims ||= {}).avatar = true; });
    await phase("creator");
    const character = await e.DB.prepare("SELECT * FROM characters WHERE id=? AND (user_id IS NULL OR user_id=?)").bind(t.characterId, run.user_id).first<any>();
    if (!character) throw new Error("POST_INVALID");
    const voiceKey = (await e.DB.prepare("SELECT object_key FROM media_assets WHERE id=?").bind(voice.assetId).first<{ object_key: string }>())!.object_key;
    const audioUrl = await inputUrl(e, run.id, voiceKey);
    const who = character.look_id ? { lookId: character.look_id as string } : { imageUrl: await inputUrl(e, run.id, character.image_key) };
    const ticket = await submitAvatarVideo(e, run.id, who, audioUrl);
    await patchState(e, run.id, (s) => { (s.tickets ||= {}).avatar = ticket; });
    return ticket;
  });
  let url: string | null = null;
  // Usually a few minutes; slow queues are waited out for up to about 90 minutes.
  for (let i = 0; i < 270 && !url; i++) {
    const status = await step.do(`avatar-status-${i}`, { retries: { limit: 3, delay: "20 seconds" }, timeout: "1 minute" }, () => avatarVideoStatus(e, ticket));
    if (status.state === "done") url = status.url;
    else await step.sleep(`avatar-wait-${i}`, "20 seconds");
  }
  if (!url) throw new Error("AVATAR_TIMEOUT");
  const videoId = await step.do("avatar-save", safe, async () => {
    const s = await readState(e, run.id);
    if (s.assets?.avatar && await e.DB.prepare("SELECT 1 FROM media_assets WHERE id=?").bind(s.assets.avatar).first()) return s.assets.avatar;
    const assetId = uid(), key = mediaKey(run.user_id, assetId, "mp4");
    const bytes = await storeStream(e, key, await fetchOutput(url!, AbortSignal.timeout(180000)), 300 * MB, "video/mp4");
    const duration = (await storedDuration(e, key, bytes)) ?? voice.seconds;
    await e.DB.prepare(
      "INSERT INTO media_assets(id,user_id,workspace_id,post_id,kind,name,object_key,mime,bytes,duration,status,meta,created_at,updated_at) VALUES (?,?,?,?,'avatar','AI creator video',?,'video/mp4',?,?,'ready','{\"ai\":true}',?,?)",
    ).bind(assetId, run.user_id, workspace.id, run.post_id, key, bytes, duration, now(), now()).run();
    await patchState(e, run.id, (s) => { (s.assets ||= {}).avatar = assetId; });
    return assetId;
  });
  await step.do("avatar-forget", () => deleteAvatarVideo(e, ticket));
  await step.do("recording-apply", () => updateSpec(e, run.post_id!, (spec) => {
    spec.generated = { key: recordingKey(t.characterId, t.voiceId, t.text), voiceAssetId: voice.assetId, videoAssetId: videoId, words: voice.words };
  }));
}

/** Every file the render reads, resolved to its R2 key and length (owner's files, library items, the recording). */
async function resolveContext(e: Env, userId: string, spec: Spec, workspace: any): Promise<PlanContext> {
  const media: Record<string, Media> = {};
  const assets = referencedAssets(spec);
  if (assets.length)
    for (const a of (await e.DB.prepare(`SELECT id,object_key,mime,duration,kind FROM media_assets WHERE user_id=? AND status='ready' AND id IN (${assets.map(() => "?").join(",")})`)
      .bind(userId, ...assets).all<any>()).results)
      media[a.id] = { key: a.object_key, kind: a.mime.split("/")[0], duration: a.duration, ai: ["ai_image", "ai_clip", "avatar", "portrait"].includes(a.kind) };
  const items = referencedLibrary(spec);
  if (items.length)
    for (const l of (await e.DB.prepare(`SELECT id,object_key,mime,duration,tags FROM library_items WHERE id IN (${items.map(() => "?").join(",")})`).bind(...items).all<any>()).results)
      media[l.id] = { key: l.object_key, kind: l.mime.split("/")[0], duration: l.duration, chroma: String(l.tags).match(/chroma:(#[0-9a-f]{6})/i)?.[1] };
  for (const id of [...assets, ...items]) if (!media[id]) throw new Error("MEDIA_INPUT");
  let avatar: PlanContext["avatar"];
  if ("generated" in spec && spec.generated?.videoAssetId) {
    const a = await e.DB.prepare("SELECT object_key,duration FROM media_assets WHERE id=? AND user_id=?").bind(spec.generated.videoAssetId, userId).first<any>();
    if (!a) throw new Error("MEDIA_INPUT");
    avatar = { key: a.object_key, duration: a.duration, words: spec.generated.words };
  }
  const profile = workspaceProfile(workspace);
  return { media, avatar, accent: profile.colors.primary, watermark: workspaceSettings(workspace).watermark };
}

/** Submits a render job (to a free container), waits for it and returns its final status. */
async function renderJob(e: Env, step: WorkflowStep, run: RunInfo, job: "compose" | "stills", part: { keys: string[] } & Record<string, unknown>, phase: Phase): Promise<RenderStatus> {
  const payload = await step.do(`${job}-payload`, async () => {
    const urls: string[] = [];
    for (const key of part.keys) urls.push(await inputUrl(e, run.id, key));
    const { keys: _keys, ...rest } = part;
    return { ...rest, id: (await readState(e, run.id)).jobs![job], urls } as unknown as RenderPayload;
  });
  // Up to ~40 minutes: renders take a minute or two, plus waiting for a free container.
  for (let i = 0; i < 240; i++) {
    const status = await step.do(`${job}-render-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, async (): Promise<RenderStatus> => {
      await phase("rendering");
      const s = await readState(e, run.id);
      let slot = s.slots?.[job] ?? null;
      if (slot === null || !(s.claims?.[`${job}-accepted`])) {
        slot = await submitRender(e, payload, slot, (n) => patchState(e, run.id, (st) => { (st.slots ||= {})[job] = n; }).then(() => undefined));
        if (slot === null) return { status: "running" };
        await patchState(e, run.id, (st) => { (st.claims ||= {})[`${job}-accepted`] = true; });
      }
      return renderStatus(e, slot, payload.id);
    });
    if (status.status === "completed") return status;
    if (status.status === "failed") throw new Error(typeof status.error === "string" && /^MEDIA_[A-Z_]+$/.test(status.error) ? status.error : "MEDIA_PROCESSING_FAILED");
    await step.sleep(`${job}-wait-${i}`, "8 seconds");
  }
  throw new Error("MEDIA_TIMEOUT");
}

/** Stand-alone AI work from AI Studio: an image for the library, or a character portrait. */
async function makeStandalone(e: Env, step: WorkflowStep, run: RunInfo, phase: Phase) {
  const p = run.payload;
  if (run.kind === "image") {
    await generateMedia(e, step, run, "image", "image", p.prompt, { workspaceId: p.workspaceId || null, postId: null, assetKind: "ai_image", label: `AI image: ${p.prompt}` }, phase);
    return;
  }
  // A character: a portrait made for talking videos (head and shoulders, facing the camera).
  const prompt = `Photorealistic vertical smartphone selfie-style portrait of ${p.description}. Head and shoulders, facing the camera, mouth closed, natural light, casual everyday setting, sharp focus on the face, nobody else in the picture. A fictional person.`;
  const assetId = await generateMedia(e, step, run, "portrait", "image", prompt, { workspaceId: null, postId: null, assetKind: "portrait", label: `Portrait: ${p.name}` }, phase);
  await step.do("character", async () => {
    const a = await e.DB.prepare("SELECT object_key,mime FROM media_assets WHERE id=?").bind(assetId).first<any>();
    await e.DB.prepare("INSERT OR IGNORE INTO characters(id,user_id,name,description,gender,image_key,mime,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(p.characterId, run.user_id, p.name, p.description, p.gender || "", a.object_key, a.mime, now(), now()).run();
  });
}
export const CHARACTER_CREDITS = IMAGE_CREDITS;

/** Checks an uploaded video or track with the renderer (length, picture size, sound) before it can be used. */
async function inspectUpload(e: Env, step: WorkflowStep, assetId: string) {
  const asset = await step.do("load", async () => e.DB.prepare("SELECT id,mime,meta,status FROM media_assets WHERE id=? AND status='checking'").bind(assetId).first<any>());
  if (!asset) return;
  const meta = json<any>(asset.meta, {});
  const payload: RenderPayload = { id: asset.id, operation: "inspect", url: `${siteUrl(e)}/api/upload-inputs/${asset.id}?token=${meta.token}` };
  try {
    let slot: number | null = null, result: RenderStatus | null = null;
    for (let i = 0; i < 90 && !result; i++) {
      const r = await step.do(`inspect-${i}`, { retries: { limit: 2, delay: "10 seconds" }, timeout: "2 minutes" }, async () => {
        if (slot === null) {
          const accepted = await submitRender(e, payload, null, async () => {});
          if (accepted === null) return { slot: null, status: { status: "running" } as RenderStatus };
          return { slot: accepted, status: await renderStatus(e, accepted, asset.id) };
        }
        return { slot, status: await renderStatus(e, slot, asset.id) };
      });
      slot = r.slot;
      if (r.status.status === "completed") result = r.status;
      else if (r.status.status === "failed") throw new Error(r.status.error || "MEDIA_FORMAT");
      else await step.sleep(`inspect-wait-${i}`, "4 seconds");
    }
    if (!result?.meta) throw new Error("MEDIA_TIMEOUT");
    const m = result.meta, expected = asset.mime.split("/")[0];
    if (m.kind !== expected) throw new Error("MEDIA_FORMAT");
    await step.do("ready", async () => {
      await e.DB.prepare("UPDATE media_assets SET status='ready',duration=?,width=?,height=?,meta=?,updated_at=? WHERE id=? AND status='checking'")
        .bind(result!.duration || 0, m.width || 0, m.height || 0, JSON.stringify({ hasAudio: m.hasAudio }), now(), asset.id).run();
      if (slot !== null) await releaseRender(e, slot, asset.id);
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    await step.do("failed", () => failAsset(e, asset.id, ({
      MEDIA_TOO_LARGE: "This video is too large (over 4096 pixels or 9 megapixels per frame).",
      MEDIA_TOO_LONG: "Videos and tracks can be up to 10 minutes long.",
      MEDIA_FORMAT: "This file can't be read. Use MP4, MOV or WebM videos and MP3, WAV, M4A or OGG tracks.",
      MEDIA_TIMEOUT: "Checking this file took too long. Try uploading it again.",
    } as Record<string, string>)[code] || "This file couldn't be checked. Try uploading it again."));
  }
}

/** Files a run's renderer and providers read: capability links, valid while the run works (and 6 hours at most). */
export const renderInputs = new Hono<{ Bindings: Env }>();
renderInputs.get("/:id/:n", async (c) => {
  const run = await c.env.DB.prepare("SELECT user_id,provider FROM runs WHERE id=? AND status='running' AND created_at>?")
    .bind(c.req.param("id"), now() - 6 * 3600).first<{ user_id: string; provider: string }>();
  const s = json<RunState>(run?.provider, {});
  const n = Number(c.req.param("n"));
  const key = Number.isInteger(n) && n >= 0 ? s.inputs?.[n] : undefined;
  if (!run || !s.token || !safeEqual(s.token, c.req.query("token") || "") || !key) throw new HTTPException(404, { message: "Not found." });
  // Only this owner's files, the shared library and library characters are ever listed.
  if (!(key.startsWith(`media/${run.user_id}/`) || key.startsWith("library/"))) throw new HTTPException(404, { message: "Not found." });
  return serveObject(c.env, key, c.req.header("Range"), "no-store");
});
