import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { App } from "../types";
import { now } from "../types";
import { checkPassword, hashPassword, rate } from "../security";
import { dbFailure, json } from "../db";
import { endPaidAccess } from "../billing";
import { SESSION_COOKIE } from "../auth";
import { onboardingSchema } from "../../shared/onboarding";

// The signed-in person's own account: name, onboarding answers, password, deletion.
export const settings = new Hono<App>();
settings.put("/onboarding", async (c) => {
  const user = c.get("user");
  const d = onboardingSchema.extend({ complete: z.boolean().optional() }).parse(await c.req.json());
  const { complete, ...answers } = d;
  const merged = { ...json<Record<string, unknown>>(user.onboarding, {}), ...answers, ...(complete ? { completedAt: now() } : {}) };
  await c.env.DB.prepare("UPDATE users SET onboarding=? WHERE id=?").bind(JSON.stringify(onboardingSchema.parse(merged)), user.id).run();
  return c.json({ ok: true });
});
settings.patch("/profile", async (c) => {
  const d = z.object({ name: z.string().trim().min(1).max(80) }).parse(await c.req.json());
  await c.env.DB.prepare("UPDATE users SET name=? WHERE id=?").bind(d.name, c.get("user").id).run();
  return c.json({ ok: true });
});
settings.post("/password", async (c) => {
  const user = c.get("user");
  await rate(c, "password-change", 10, 3600, user.id);
  const d = z.object({ current: z.string().min(1).max(128), password: z.string().min(10, "Use at least 10 characters for your password.").max(128) }).parse(await c.req.json());
  if (!(await checkPassword(d.current, user.password_hash))) throw new HTTPException(400, { message: "Your current password isn't right." });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await hashPassword(d.password), user.id),
    // Other devices are signed out; this one stays.
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").bind(user.id, c.get("session")),
  ]);
  return c.json({ ok: true });
});
/** Deletes the account and everything in it (files are removed by maintenance). Paid plans are cancelled first. */
settings.delete("/account", async (c) => {
  const user = c.get("user");
  await rate(c, "account-delete", 5, 3600, user.id);
  const d = z.object({ password: z.string().min(1).max(128) }).parse(await c.req.json());
  if (!(await checkPassword(d.password, user.password_hash))) throw new HTTPException(400, { message: "Your password isn't right." });
  if (user.stripe_customer && c.env.STRIPE_SECRET_KEY) await endPaidAccess(c.env, user.stripe_customer, "deletion");
  try {
    await c.env.DB.prepare("DELETE FROM users WHERE id=?").bind(user.id).run();
  } catch (e) {
    dbFailure(e);
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
