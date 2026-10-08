import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env, DbUser } from "./types";
import { now } from "./types";
import { json } from "./db";
import { siteUrl } from "./config";
import { allowance } from "./billing";
import { encryptionReady } from "./crypto";
import { describeError } from "./error-report";
import { planById } from "../shared/plans";
import { isPlatform, platforms, postsAsPhotos, type PlatformId } from "../shared/social";
import { socialPlatforms, SocialError, failureMessage, nothingPosted, type FailureCode, type MediaFile, type PublishContext, type PublishResult, type Ticket } from "./social";
import { freshTokens, markExpired, type AccountRow } from "./social/credentials";
import { postText, synthetic, unfit, type PostRow } from "./social/post";

// Publishes one publication (claimed by dispatchDue in publishing.ts) on its network, exactly once.
//
// The provider calls that make a post public cannot be undone or safely repeated. Before such a call the platform
// saves a checkpoint in publications.ticket; a step that runs again (retry, replay after a restart) finds it and
// resumes by polling instead of posting a second time. A run that cannot tell whether the post went out fails with a
// message asking the person to check their profile before retrying.

/** publications.ticket while a start is under way and nothing irreversible has been sent yet. */
const CLAIMED = JSON.stringify({ stage: "claimed" });
/** Status checks: every 15 seconds for up to 30 minutes. */
const POLLS = 120;
/** Waits before starting again after a refusal that may pass (rate limit, provider outage). */
const START_RETRIES = ["1 minute", "5 minutes", "15 minutes"] as const;

export type Outcome =
  | { state: "published" }
  | { state: "processing" }
  | { state: "stopped" }
  | { state: "failed"; code: FailureCode; retryable: boolean; detail: string };

type Loaded = { pub: any; post: PostRow | null; account: AccountRow | null; platform: PlatformId };

/** The publication while this attempt still owns it (status 'publishing', same attempt), with its post and account. */
async function load(env: Env, id: string, attempts: number): Promise<Loaded | null> {
  const pub = await env.DB.prepare("SELECT * FROM publications WHERE id=?").bind(id).first<any>();
  if (!pub || pub.status !== "publishing" || pub.attempts !== attempts || !isPlatform(pub.platform)) return null;
  const post = await env.DB.prepare("SELECT * FROM posts WHERE id=? AND user_id=?").bind(pub.post_id, pub.user_id).first<PostRow>();
  const account = await env.DB.prepare("SELECT * FROM social_accounts WHERE id=? AND user_id=?").bind(pub.account_id, pub.user_id).first<AccountRow>();
  return { pub, post, account, platform: pub.platform };
}

const failed = (code: FailureCode, retryable = false, detail = ""): Outcome => ({ state: "failed", code, retryable, detail });
function failedFrom(e: unknown): Outcome {
  if (e instanceof SocialError) return failed(e.code, e.retryable, e.detail);
  throw e;
}

/** Checks that the publication can go out at all: post ready, account connected, network set up, plan. */
export async function prepare(env: Env, id: string): Promise<{ attempts: number; outcome: Outcome }> {
  const pub = await env.DB.prepare("SELECT * FROM publications WHERE id=?").bind(id).first<any>();
  if (!pub || pub.status !== "publishing") return { attempts: pub?.attempts ?? 0, outcome: { state: "stopped" } };
  const check = async (): Promise<Outcome> => {
    const loaded = await load(env, id, pub.attempts);
    if (!loaded) return failed("PROVIDER_ERROR");
    const { post, account, platform } = loaded;
    if (!post || post.status !== "approved" || post.render_status !== "ready" || unfit(post, platform)) return failed("NOT_READY");
    if (!account || account.status !== "active") return failed("AUTH_EXPIRED");
    if (!socialPlatforms[platform].configured(env) || !encryptionReady(env) || !siteUrl(env)) return failed("NOT_CONFIGURED");
    const user = await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(pub.user_id).first<DbUser>();
    if (!user || !planById((await allowance(env, user)).plan).scheduling) return failed("PLAN");
    return { state: "processing" };
  };
  return { attempts: pub.attempts, outcome: await check() };
}

/** Refreshes the account's token when it is close to expiring (saved re-sealed). */
async function credentials(env: Env, id: string, attempts: number): Promise<Outcome> {
  const loaded = await load(env, id, attempts);
  if (!loaded) return { state: "stopped" };
  if (!loaded.account) return failed("AUTH_EXPIRED");
  try {
    await freshTokens(env, loaded.account);
    return { state: "processing" };
  } catch (e) {
    if (e instanceof SocialError && !e.retryable) return failed(e.code, false, e.detail);
    throw e; // a provider outage: the step is retried
  }
}

const extension = (mime: string) => ({ "video/mp4": "mp4", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[mime] || "bin";

/** Everything a platform needs to publish: fresh tokens, text, and the media with their capability links. */
async function context(env: Env, { pub, post, account, platform }: Loaded): Promise<PublishContext> {
  if (!post || !account) throw new SocialError("NOT_READY");
  if (account.status !== "active") throw new SocialError("AUTH_EXPIRED");
  const base = siteUrl(env);
  if (!base) throw new SocialError("NOT_CONFIGURED");
  if (!pub.token) throw new SocialError("NOT_READY");
  const tokens = await freshTokens(env, account);
  const asPhotos = postsAsPhotos(post.format, platform);
  const ids = asPhotos ? json<unknown[]>(post.slides, []).slice(0, platforms[platform].photos?.max ?? 0) : [post.video_asset];
  const files: MediaFile[] = [];
  for (const [n, assetId] of ids.entries()) {
    const asset = typeof assetId === "string"
      ? await env.DB.prepare("SELECT object_key,mime FROM media_assets WHERE id=? AND user_id=?").bind(assetId, pub.user_id).first<{ object_key: string; mime: string }>()
      : null;
    const head = asset ? await env.MEDIA.head(asset.object_key) : null;
    if (!asset || !head || !head.size) throw new SocialError("NOT_READY");
    files.push({
      key: asset.object_key,
      bytes: head.size,
      mime: asset.mime,
      url: `${base}/api/publish-media/${pub.id}/${n}.${extension(asset.mime)}?token=${pub.token}`,
    });
  }
  if (!files.length) throw new SocialError("NOT_READY");
  return {
    publicationId: pub.id,
    account: { externalId: account.external_id, handle: account.handle },
    tokens,
    ...postText(post, platform),
    synthetic: synthetic(post),
    media: asPhotos ? { kind: "photos", items: files } : { kind: "video", ...files[0], duration: Number(post.duration) || 0 },
    checkpoint: async (ticket: Ticket) => {
      const saved = await env.DB.prepare("UPDATE publications SET ticket=?,updated_at=? WHERE id=? AND status='publishing' AND attempts=?")
        .bind(JSON.stringify(ticket), now(), pub.id, pub.attempts)
        .run();
      if (!saved.meta.changes) {
        // Timed out or no longer ours: stop before the provider is asked for anything irreversible.
        const e = new SocialError("TIMEOUT");
        e.nothingPosted = true;
        throw e;
      }
    },
  };
}

/** Records a provider result: published (final), processing (ticket saved) or failed. */
async function settle(env: Env, l: Loaded, r: PublishResult, fromStart: boolean): Promise<Outcome> {
  if (r.state === "published") {
    await env.DB.prepare(
      "UPDATE publications SET status='published',external_id=?,url=?,published_at=?,ticket=NULL,token=NULL,error=NULL,updated_at=? WHERE id=? AND attempts=? AND status IN ('publishing','failed')",
    ).bind(r.externalId || null, r.url || null, now(), now(), l.pub.id, l.pub.attempts).run();
    return { state: "published" };
  }
  if (r.state === "processing") {
    await env.DB.prepare("UPDATE publications SET ticket=?,updated_at=? WHERE id=? AND status='publishing' AND attempts=?")
      .bind(JSON.stringify(r.ticket), now(), l.pub.id, l.pub.attempts).run();
    return { state: "processing" };
  }
  // A failure the provider reported for a post it never published: a new start may try again.
  if (fromStart) await env.DB.prepare("UPDATE publications SET ticket=NULL WHERE id=? AND attempts=?").bind(l.pub.id, l.pub.attempts).run();
  return failed(r.code, r.retryable, r.detail || "");
}

/** Starts the post at the provider, once. */
export async function start(env: Env, id: string, attempts: number): Promise<Outcome> {
  const l = await load(env, id, attempts);
  if (!l) return { state: "stopped" };
  // Started before (a replayed step or an earlier run of this attempt): its outcome is found by polling.
  if (l.pub.ticket && l.pub.ticket !== CLAIMED) return { state: "processing" };
  await env.DB.prepare("UPDATE publications SET ticket=?,updated_at=? WHERE id=? AND status='publishing' AND attempts=?").bind(CLAIMED, now(), id, attempts).run();
  try {
    const ctx = await context(env, l);
    return await settle(env, l, await socialPlatforms[l.platform].publish(env, ctx), true);
  } catch (e) {
    const current = await env.DB.prepare("SELECT ticket FROM publications WHERE id=?").bind(id).first<{ ticket: string | null }>();
    if (!current?.ticket || current.ticket === CLAIMED || nothingPosted(e)) {
      await env.DB.prepare("UPDATE publications SET ticket=NULL WHERE id=? AND attempts=?").bind(id, attempts).run();
      return failedFrom(e);
    }
    // The provider may have the post (a checkpoint was saved): what happened is found by polling.
    console.warn("Publication start interrupted; checking its status", { publicationId: id, platform: l.platform, code: e instanceof SocialError ? e.code : "ERROR" });
    return { state: "processing" };
  }
}

/** Checks a started post (and finishes it where the provider needs a last call). */
export async function poll(env: Env, id: string, attempts: number): Promise<Outcome> {
  const l = await load(env, id, attempts);
  if (!l) return { state: "stopped" };
  const ticket = json<Ticket | null>(l.pub.ticket, null);
  const platform = socialPlatforms[l.platform];
  if (!ticket || ticket.stage === "claimed") return failed("PROVIDER_ERROR");
  if (!platform.status) return failed("INTERRUPTED");
  try {
    return await settle(env, l, await platform.status(env, await context(env, l), ticket), false);
  } catch (e) {
    if (e instanceof SocialError && !e.retryable) return failed(e.code, false, e.detail);
    // Busy or unreachable: says nothing about the post, which is checked again.
    if (e instanceof SocialError) return { state: "processing" };
    throw e;
  }
}

/** Marks the publication failed with a plain-English reason (and the account expired when it needs reconnecting). */
export async function fail(env: Env, id: string, attempts: number | null, code: FailureCode, detail = "") {
  const pub = await env.DB.prepare("SELECT platform,account_id,attempts FROM publications WHERE id=?").bind(id).first<{ platform: string; account_id: string; attempts: number }>();
  if (!pub) return;
  const platform = isPlatform(pub.platform) ? pub.platform : null;
  await env.DB.prepare("UPDATE publications SET status='failed',error=?,token=NULL,updated_at=? WHERE id=? AND status='publishing' AND attempts=?")
    .bind(failureMessage(platform, code, detail), now(), id, attempts ?? pub.attempts)
    .run();
  if (code === "AUTH_EXPIRED") await markExpired(env, pub.account_id);
}

const DB_STEP = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;

export class Publication extends WorkflowEntrypoint<Env, { publicationId: string }> {
  async run(event: WorkflowEvent<{ publicationId: string }>, step: WorkflowStep) {
    const id = event.payload.publicationId;
    // Instances are named pub-<publication>-<attempt> (dispatchDue).
    const named = /^pub-.+-(\d+)$/.exec(String(event.instanceId || ""));
    let attempts: number | null = named ? Number(named[1]) : null;
    try {
      const job = await step.do("load", DB_STEP, () => prepare(this.env, id));
      if (attempts !== null && job.attempts !== attempts) return; // a newer attempt owns it
      const a = job.attempts;
      attempts = a;
      if (job.outcome.state === "stopped") return;
      if (job.outcome.state === "failed") {
        const f = job.outcome;
        await step.do("fail-unready", DB_STEP, () => fail(this.env, id, a, f.code, f.detail));
        return;
      }
      const fresh = await step.do("credentials", { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "2 minutes" },
        () => credentials(this.env, id, a));
      let outcome: Outcome = fresh;
      if (fresh.state === "processing") {
        for (let i = 0; ; i++) {
          // Never retried by the runtime: a repeated start could post twice (start() itself resumes safely).
          outcome = await step.do(`publish-${i}`, { retries: { limit: 0, delay: "1 second" }, timeout: "30 minutes" }, () => start(this.env, id, a));
          if (outcome.state !== "failed" || !outcome.retryable || i >= START_RETRIES.length) break;
          await step.sleep(`publish-wait-${i}`, START_RETRIES[i]);
        }
      }
      for (let i = 0; outcome.state === "processing" && i < POLLS; i++) {
        await step.sleep(`status-wait-${i}`, "15 seconds");
        outcome = await step.do(`status-${i}`, { retries: { limit: 2, delay: "15 seconds" }, timeout: "30 minutes" }, () => poll(this.env, id, a));
      }
      if (outcome.state === "processing") outcome = failed("TIMEOUT");
      if (outcome.state === "failed") {
        const f = outcome;
        console.warn("Publication failed", { publicationId: id, code: f.code, detail: f.detail });
        await step.do("fail", DB_STEP, () => fail(this.env, id, a, f.code, f.detail));
      }
    } catch (e) {
      // Never leave it 'publishing': the person sees a plain message and can retry.
      console.error("Publication workflow error", { publicationId: id, ...describeError(e) });
      await step.do("fail-error", DB_STEP, () => fail(this.env, id, attempts, "PROVIDER_ERROR")).catch(() => {
        console.error("Publication could not be marked failed; maintenance will time it out", { publicationId: id });
      });
    }
  }
}
