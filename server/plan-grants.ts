import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { App } from "./types";
import { now, uid, DAY } from "./types";
import { rate } from "./security";
import { GRANT_PREFIX } from "./billing";
import { paidPlans } from "../shared/plans";

// Administrator grants: a paid plan for one month without Stripe (testers, partners, support cases). A grant is a
// subscription row that ends on its own; its own ID gives it a fresh usage window with the plan's posts and credits.
// Billing, reconciliation and refunds never touch it (see allowance, reconcileStripe and endPaidAccess in billing.ts).
// Mounted after the administrator check (routes/admin.ts).
export const GRANT_DAYS = 30;
export const planGrants = new Hono<App>();
const email = z.string().max(254).transform((s) => s.toLowerCase().trim()).pipe(z.email());

/** Grants that are running or ended in the last 90 days, newest first, with what each has used. */
planGrants.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.id,s.plan,s.period_start AS start,s.period_end AS end,u.email,u.name,
      (SELECT COALESCE(SUM(w.used),0) FROM usage_windows w WHERE w.id=u.id||':'||s.id||':'||s.period_start) AS used,
      (SELECT COALESCE(SUM(w.posts_used),0) FROM usage_windows w WHERE w.id=u.id||':'||s.id||':'||s.period_start) AS postsUsed
     FROM subscriptions s JOIN users u ON u.id=s.user_id
     WHERE substr(s.id,1,6)=? AND s.period_end>? ORDER BY s.period_start DESC LIMIT 100`,
  ).bind(GRANT_PREFIX, now() - 90 * DAY).all();
  return c.json({ grants: results, now: now() });
});

/** Gives a user a plan for one month. A running grant of that user is replaced (it starts again with a full plan). */
planGrants.post("/", async (c) => {
  await rate(c, "plan-grant", 60, 3600, c.get("user").id);
  const d = z.object({ email, plan: z.enum(paidPlans) }).parse(await c.req.json());
  const user = await c.env.DB.prepare("SELECT id,email FROM users WHERE email=?").bind(d.email).first<{ id: string; email: string }>();
  if (!user) throw new HTTPException(404, { message: "There's no account with this email. The person needs to sign up first." });
  const t = now(), id = `${GRANT_PREFIX}${uid()}`;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE subscriptions SET period_end=? WHERE user_id=? AND substr(id,1,6)=? AND period_end>?").bind(t, user.id, GRANT_PREFIX, t),
    c.env.DB.prepare(
      "INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES (?,?,?,'active',?,?,1,?)",
    ).bind(id, user.id, d.plan, t, t + GRANT_DAYS * DAY, t),
  ]);
  // A paid subscription keeps billing in Stripe while the grant runs: the administrator should know.
  const paid = await c.env.DB.prepare(
    "SELECT plan FROM subscriptions WHERE user_id=? AND substr(id,1,6)!=? AND status='active' AND period_end>? LIMIT 1",
  ).bind(user.id, GRANT_PREFIX, t).first<{ plan: string }>();
  console.log("Plan granted", { grant: id, plan: d.plan, by: c.get("user").id });
  return c.json({ id, end: t + GRANT_DAYS * DAY, paidPlan: paid?.plan ?? null }, 201);
});

/** Ends a grant now; the user returns to their paid plan or the free plan. */
planGrants.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!id.startsWith(GRANT_PREFIX)) throw new HTTPException(404, { message: "Not found." });
  const t = now();
  const r = await c.env.DB.prepare("UPDATE subscriptions SET period_end=? WHERE id=? AND period_end>?").bind(t, id, t).run();
  if (!r.meta.changes) throw new HTTPException(404, { message: "This grant has already ended." });
  console.log("Plan grant ended", { grant: id, by: c.get("user").id });
  return c.json({ ok: true });
});
