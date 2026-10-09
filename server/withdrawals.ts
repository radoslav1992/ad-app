import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type Stripe from "stripe";
import { endPaidAccess, stripe } from "./billing";
import { planById } from "../shared/plans";
import { WITHDRAWAL_DAYS, usedMeter, withdrawalRefund } from "../shared/withdrawal";
import type { App, Env } from "./types";
import { now, uid, DAY } from "./types";
import { rate } from "./security";

// Withdrawal from a subscription within 14 days (CRD Art. 9 and 14(3); ЗЗП чл. 50 and 55): an administrator checks
// the amount, then one action ends the plan (no further charges, its posts and AI credits stop) and refunds what was
// paid less the share of the plan used: the larger of the share of posts and the share of AI credits of the paid
// period (shared/withdrawal.ts). Mounted after the administrator check (routes/admin.ts).

const email = z.string().max(254).transform((s) => s.toLowerCase().trim()).pipe(z.email());
/** A paid payment of the subscription (newest first) and what can still be refunded from it, in cents. */
type Payment = { paymentIntent: string; refundable: number };

const noSubscription = () => new HTTPException(404, { message: "There's no paid subscription for this email." });
async function quote(e: Env, address: string) {
  const user = await e.DB.prepare("SELECT id,email,stripe_customer FROM users WHERE email=?")
    .bind(address).first<{ id: string; email: string; stripe_customer: string | null }>();
  if (!user?.stripe_customer) throw noSubscription();
  const s = stripe(e);
  const subscriptions = (await s.subscriptions.list({ customer: user.stripe_customer, status: "all", limit: 10 })).data;
  const sub = subscriptions.find((x) => !["canceled", "incomplete_expired", "incomplete"].includes(x.status)) ?? subscriptions[0];
  if (!sub) throw noSubscription();
  const invoices = (await s.invoices.list({ subscription: sub.id, status: "paid", limit: 24, expand: ["data.payments"] })).data
    .sort((a, b) => b.created - a.created);
  const payments: Payment[] = [];
  let currency = "usd";
  for (const invoice of invoices)
    for (const p of invoice.payments?.data ?? []) {
      const intent = p.payment.payment_intent;
      if (p.status !== "paid" || p.payment.type !== "payment_intent" || !intent) continue;
      // Net of anything refunded before (e.g. by hand in Stripe).
      const pi = await s.paymentIntents.retrieve(typeof intent === "string" ? intent : intent.id, { expand: ["latest_charge"] });
      const charge = pi.latest_charge as Stripe.Charge | null;
      const refundable = Math.max(0, Math.min(p.amount_paid ?? 0, (charge?.amount ?? 0) - (charge?.amount_refunded ?? 0)));
      payments.push({ paymentIntent: pi.id, refundable });
      currency = invoice.currency || currency;
    }
  const paid = payments.reduce((sum, p) => sum + p.refundable, 0);
  const stored = await e.DB.prepare("SELECT plan FROM subscriptions WHERE id=?").bind(sub.id).first<{ plan: string }>();
  const plan = stored ? planById(stored.plan) : null;
  // The newest paid period of this subscription (window IDs are user:subscription:period start).
  const period = await e.DB.prepare("SELECT used,quota,posts_used,posts_quota FROM usage_windows WHERE user_id=? AND id LIKE ? ORDER BY id DESC LIMIT 1")
    .bind(user.id, `${user.id}:${sub.id}:%`).first<{ used: number; quota: number; posts_used: number; posts_quota: number }>();
  const usage = {
    used: period?.used ?? 0, quota: period?.quota ?? plan?.credits ?? 0,
    postsUsed: period?.posts_used ?? 0, postsQuota: period?.posts_quota ?? plan?.posts ?? 0,
  };
  const deadline = sub.start_date + WITHDRAWAL_DAYS * DAY;
  const done = await e.DB.prepare("SELECT id,refund,refunded,status,error,created_at FROM withdrawals WHERE subscription_id=?").bind(sub.id).first<any>();
  const meter = usedMeter(usage);
  return {
    customer: user.stripe_customer, userId: user.id, subscription: sub.id, payments,
    view: {
      email: user.email, plan: plan?.name ?? stored?.plan ?? null, status: sub.status, startedAt: sub.start_date, deadline,
      open: now() <= deadline, paid, currency, ...usage, meter: meter.meter, refund: withdrawalRefund(paid, usage), withdrawal: done ?? null,
    },
  };
}

export const adminWithdrawals = new Hono<App>();
adminWithdrawals.get("/", async (c) => c.json({
  withdrawals: (await c.env.DB.prepare(
    "SELECT w.id,w.subscription_id,w.currency,w.paid,w.refund,w.refunded,w.used,w.quota,w.posts_used,w.posts_quota,w.status,w.error,w.created_at,u.email FROM withdrawals w LEFT JOIN users u ON u.id=w.user_id ORDER BY w.created_at DESC LIMIT 20",
  ).all()).results,
}));
adminWithdrawals.get("/quote", async (c) => c.json((await quote(c.env, email.parse(c.req.query("email") ?? ""))).view));
adminWithdrawals.post("/", async (c) => {
  await rate(c, "withdrawal", 30, 3600, c.get("user").id);
  const d = z.object({ email, refund: z.number().int().min(0) }).parse(await c.req.json());
  const q = await quote(c.env, d.email);
  if (q.view.withdrawal) throw new HTTPException(409, { message: "The withdrawal from this subscription was already handled." });
  if (!q.view.open)
    throw new HTTPException(400, { message: `The ${WITHDRAWAL_DAYS}-day withdrawal period ended on ${new Date(q.view.deadline * 1000).toISOString().slice(0, 10)}.` });
  // The amount the administrator saw: posts or credits used since then change it.
  if (d.refund !== q.view.refund) throw new HTTPException(409, { message: "The amount has changed (more of the plan was used). Check again." });
  const id = uid(), at = now();
  try {
    await c.env.DB.prepare(
      "INSERT INTO withdrawals(id,user_id,subscription_id,currency,paid,refund,used,quota,posts_used,posts_quota,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'started',?,?)",
    ).bind(id, q.userId, q.subscription, q.view.currency, q.view.paid, q.view.refund, q.view.used, q.view.quota, q.view.postsUsed, q.view.postsQuota, at, at).run();
  } catch {
    throw new HTTPException(409, { message: "The withdrawal from this subscription is already being handled." });
  }
  // First the plan ends (no further charges, posts and credits stop), then the money goes back.
  try { await endPaidAccess(c.env, q.customer, "withdrawal"); }
  catch (error) {
    await c.env.DB.prepare("DELETE FROM withdrawals WHERE id=?").bind(id).run();
    throw error;
  }
  const s = stripe(c.env);
  let refunded = 0, error: string | null = null;
  try {
    for (const p of q.payments) {
      const amount = Math.min(q.view.refund - refunded, p.refundable);
      if (amount <= 0) continue;
      await s.refunds.create({ payment_intent: p.paymentIntent, amount, reason: "requested_by_customer", metadata: { withdrawal: id } },
        { idempotencyKey: `withdrawal-${id}-${p.paymentIntent}` });
      refunded += amount;
    }
  } catch (e) {
    error = "Stripe didn't refund the amount. Refund the rest by hand in Stripe.";
    console.error("Withdrawal refund failed", { withdrawal: id, error: (e as Error)?.name });
  }
  const status = refunded >= q.view.refund ? "completed" : "refund_failed";
  await c.env.DB.prepare("UPDATE withdrawals SET refunded=?,status=?,error=?,updated_at=? WHERE id=?").bind(refunded, status, error, now(), id).run();
  console.log("Withdrawal handled", { withdrawal: id, status, by: c.get("user").id });
  return c.json({ withdrawal: { id, refund: q.view.refund, refunded, currency: q.view.currency, status, error } });
});
