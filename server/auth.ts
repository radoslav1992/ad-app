import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { App, Env, DbUser } from "./types";
import { now, uid, ready, DAY, HOUR } from "./types";
import { checkPassword, hashPassword, token, sha, rate, hit, limited, tooMany, clientIp, defer, sendMail, origin, verifyTurnstile } from "./security";
import { allowance, touchTrial } from "./billing";
import { json } from "./db";
import { PRODUCT } from "../shared/brand";

export const auth = new Hono<App>();
export const SESSION_COOKIE = "pl_session";
/** The terms' "last updated" date: change it with the terms, so each acceptance records its version. */
export const TERMS_VERSION = "2026-10-09";
const credentials = z.object({
  email: z.email().max(254).transform((s) => s.toLowerCase().trim()),
  password: z.string().min(10, "Use at least 10 characters for your password.").max(128),
});
async function issue(env: Env, user: DbUser, kind: "verify" | "reset", base: string) {
  const t = token();
  await env.DB.prepare("INSERT INTO auth_tokens(token_hash,user_id,kind,expires_at) VALUES (?,?,?,?)")
    .bind(await sha(t), user.id, kind, now() + (kind === "verify" ? DAY : HOUR))
    .run();
  await sendMail(
    env,
    user.email,
    kind === "verify" ? `Confirm your email — ${PRODUCT.name}` : `Reset your password — ${PRODUCT.name}`,
    // No name: it is whatever the registration form was given, and the address may belong to someone else.
    `Hi,\n\n${kind === "verify" ? "Confirm your email address" : "Choose a new password"} with this link:\n${base}/${kind === "verify" ? "verify" : "reset"}?token=${t}\n\nIf you did not ask for this, you can ignore this email.\n${PRODUCT.name}`,
  );
}
export const isAdmin = (env: Env, u: DbUser) =>
  !!u.verified &&
  (env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).includes(u.email.toLowerCase());

auth.get("/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null });
  const limits = await allowance(c.env, user);
  return c.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      verified: !!user.verified,
      admin: isAdmin(c.env, user),
      onboarding: json(user.onboarding, {}),
      ...limits,
      window: undefined,
    },
  });
});
auth.post("/register", async (c) => {
  if (c.env.REGISTRATION_ENABLED !== "true" || !ready(c.env))
    throw new HTTPException(503, { message: "Sign-ups open soon." });
  await rate(c, "register", 5);
  const body = await c.req.json();
  const d = credentials.extend({ name: z.string().trim().min(2).max(80), acceptTerms: z.literal(true) }).parse(body);
  if (!c.env.EMAIL || !c.env.EMAIL_FROM) throw new HTTPException(503, { message: "Sign-ups are temporarily unavailable." });
  if (c.env.APP_ENV !== "development" && !c.env.TURNSTILE_SECRET_KEY)
    throw new HTTPException(503, { message: "Sign-ups are temporarily unavailable." });
  if (c.env.TURNSTILE_SECRET_KEY && !(await verifyTurnstile(c.env, body.turnstileToken, c.req.header("CF-Connecting-IP"))))
    throw new HTTPException(400, { message: "Please complete the security check." });
  // The answer is the same whether or not the address already has an account, so the form does not reveal who is
  // registered: a new account gets its confirmation email, the owner of an existing one an alert, and registering
  // never signs anyone in. The password is hashed either way, so timing does not tell them apart either.
  const passwordHash = await hashPassword(d.password);
  const base = origin(c.env, c.req.raw);
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email=?").bind(d.email).first();
  if (existing) return c.json({ ok: true, emailSent: await alertExisting(c.env, d.email, base) });
  const user: DbUser = { id: uid(), email: d.email, name: d.name, password_hash: passwordHash, verified: 0, created_at: now(), stripe_customer: null };
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users(id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)")
        .bind(user.id, user.email, user.name, user.password_hash, user.created_at),
      c.env.DB.prepare("INSERT INTO terms_acceptances(user_id,version,accepted_at) VALUES (?,?,?)").bind(user.id, TERMS_VERSION, user.created_at),
    ]);
  } catch (e) {
    // Registered a moment ago by a parallel request.
    if (String(e).includes("UNIQUE")) return c.json({ ok: true, emailSent: await alertExisting(c.env, d.email, base) });
    throw e;
  }
  let emailSent = true;
  try {
    await issue(c.env, user, "verify", base);
  } catch {
    emailSent = false;
  }
  return c.json({ ok: true, emailSent });
});
/** Tells the owner of an existing account that someone tried to register with their address (at most 3 a day). */
async function alertExisting(env: Env, email: string, base: string) {
  if ((await hit(env, "register-existing", DAY, email)) > 3) return true;
  try {
    await sendMail(
      env,
      email,
      `Sign-up attempt with your email — ${PRODUCT.name}`,
      `Hi,\n\nSomeone tried to create a new ${PRODUCT.name} account with this email address, but it already has one.\n\nIf that was you, sign in at ${base}/login. Forgot your password? Choose a new one at ${base}/forgot.\n\nIf it wasn't you, there is nothing to do — your account has not changed.\n${PRODUCT.name}`,
    );
    return true;
  } catch {
    return false;
  }
}
async function createSession(c: Context<App>, userId: string) {
  const t = token();
  await c.env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)")
    .bind(await sha(t), userId, now() + 30 * DAY)
    .run();
  setCookie(c, SESSION_COOKIE, t, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * DAY,
  });
}
// Only failed passwords count toward the per-email limits, so a correct login is never blocked by someone else's
// attempts. Above the per-email ceiling (distributed guessing) a login also needs a passed security check.
const LOGIN_FAILURES_PER_ADDRESS = 10;
const LOGIN_FAILURES_PER_EMAIL = 100;
/** The client shows the security check on the sign-in form when it gets this code. */
export const CHALLENGE_REQUIRED = "TURNSTILE_REQUIRED";
auth.post("/login", async (c) => {
  await rate(c, "login", 20);
  const body = await c.req.json();
  const { email, password } = credentials.parse(body);
  const pair = email + ":" + clientIp(c);
  if (await limited(c.env, "login-fail", LOGIN_FAILURES_PER_ADDRESS, HOUR, pair)) throw tooMany();
  if (await limited(c.env, "login-fail-email", LOGIN_FAILURES_PER_EMAIL, HOUR, email)) {
    if (!c.env.TURNSTILE_SECRET_KEY) throw tooMany();
    if (!(await verifyTurnstile(c.env, body.turnstileToken, c.req.header("CF-Connecting-IP"))))
      return c.json({ error: "There were many failed sign-ins to this account. Complete the security check and try again.", code: CHALLENGE_REQUIRED }, 429);
  }
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first<DbUser>();
  const valid = await checkPassword(
    password,
    user?.password_hash || "pbkdf2:100000:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000",
  );
  if (!user || !valid) {
    await hit(c.env, "login-fail", HOUR, pair);
    await hit(c.env, "login-fail-email", HOUR, email);
    throw new HTTPException(401, { message: "Wrong email or password." });
  }
  await createSession(c, user.id);
  try {
    await touchTrial(c.env, user.email);
  } catch {
    console.error("Trial record update failed");
  }
  return c.json({ ok: true });
});
auth.post("/logout", async (c) => {
  const t = getCookie(c, SESSION_COOKIE);
  if (t) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha(t)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
auth.post("/forgot", async (c) => {
  await rate(c, "forgot", 5);
  const { email } = z.object({ email: z.email().transform((s) => s.toLowerCase().trim()) }).parse(await c.req.json());
  // The per-address cap stops inbox flooding; the response is identical either way and the send happens after it.
  if ((await hit(c.env, "forgot-email", HOUR, email)) > 3) return c.json({ ok: true });
  const base = origin(c.env, c.req.raw);
  await defer(
    c,
    (async () => {
      const u = await c.env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first<DbUser>();
      if (u) await issue(c.env, u, "reset", base);
    })().catch(() => console.error("Password reset email unavailable")),
  );
  return c.json({ ok: true });
});
auth.post("/verify", async (c) => {
  await rate(c, "verify", 20);
  const { token: t } = z.object({ token: z.string().length(64) }).parse(await c.req.json());
  const row = await c.env.DB.prepare("DELETE FROM auth_tokens WHERE token_hash=? AND kind='verify' AND expires_at>? RETURNING user_id")
    .bind(await sha(t), now())
    .first<{ user_id: string }>();
  if (!row) throw new HTTPException(400, { message: "This link has expired or was already used." });
  await c.env.DB.prepare("UPDATE users SET verified=1 WHERE id=?").bind(row.user_id).run();
  return c.json({ ok: true });
});
auth.post("/resend", async (c) => {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Please sign in." });
  await rate(c, "resend", 3, 3600, user.id);
  if (!user.verified) await issue(c.env, user, "verify", origin(c.env, c.req.raw));
  return c.json({ ok: true });
});
auth.post("/reset", async (c) => {
  await rate(c, "reset", 10);
  const d = z.object({ token: z.string().length(64), password: z.string().min(10).max(128) }).parse(await c.req.json());
  const hash = await hashPassword(d.password);
  const t = await sha(d.token);
  const row = await c.env.DB.prepare("SELECT user_id FROM auth_tokens WHERE token_hash=? AND kind='reset' AND expires_at>?")
    .bind(t, now())
    .first<{ user_id: string }>();
  if (!row) throw new HTTPException(400, { message: "This link has expired or was already used." });
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password_hash=? WHERE id=? AND EXISTS(SELECT 1 FROM auth_tokens WHERE token_hash=? AND kind='reset' AND expires_at>?)",
    ).bind(hash, row.user_id, t, now()),
    c.env.DB.prepare("DELETE FROM auth_tokens WHERE user_id=?").bind(row.user_id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(row.user_id),
  ]);
  if (!result[0].meta.changes) throw new HTTPException(400, { message: "This link was already used." });
  return c.json({ ok: true });
});
