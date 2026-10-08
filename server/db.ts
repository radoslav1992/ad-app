import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";

/** SQL fragment for work that is still in progress. */
export const ACTIVE = "('queued','running')";

// The D1 triggers (migrations/0001_initial.sql) refuse work with these codes; people get a plain explanation.
const refusals: Record<string, [number, string]> = {
  QUOTA_EXCEEDED: [402, "You don't have enough AI credits left this month. Upgrade your plan or wait for the next period."],
  POSTS_EXCEEDED: [402, "You've used all the posts in your plan. Upgrade to keep creating."],
  STORAGE_FULL: [413, "Your storage is full. Delete some files or posts, or upgrade your plan."],
  RUNS_BUSY: [429, "A lot is being made for you right now. Wait for a few posts to finish, then try again."],
  POST_BUSY: [409, "This post is being made or published right now. Try again when it's done."],
  ACCOUNT_BUSY: [409, "A post is being published to this account right now. Try again in a minute."],
  USER_BUSY: [409, "Something is still being made or published for you. Try again when it has finished."],
};
/** Turns a trigger refusal into a clear HTTP error; anything else is rethrown. */
export function dbFailure(e: unknown): never {
  const text = String((e as Error)?.message || e);
  for (const [code, [status, message]] of Object.entries(refusals))
    if (text.includes(code)) throw new HTTPException(status as 402, { message });
  if (text.includes("UNIQUE constraint failed")) throw new HTTPException(409, { message: "This already exists." });
  throw e;
}
/** Parses stored JSON, or returns `fallback` for a missing or damaged value. */
export function json<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
/** The workspace if the user owns it, else 404 (never revealing another account's workspace). */
export async function ownedWorkspace(e: Env, userId: string, id: string) {
  const w = await e.DB.prepare("SELECT * FROM workspaces WHERE id=? AND user_id=?").bind(id, userId).first<any>();
  if (!w) throw new HTTPException(404, { message: "Workspace not found." });
  return w;
}
/** The post if the user owns it, else 404. */
export async function ownedPost(e: Env, userId: string, id: string) {
  const p = await e.DB.prepare("SELECT * FROM posts WHERE id=? AND user_id=?").bind(id, userId).first<any>();
  if (!p) throw new HTTPException(404, { message: "Post not found." });
  return p;
}
