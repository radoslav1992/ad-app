import Stripe from "stripe";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { paidPlans, planById, plans, TRIAL_DAYS, type PaidPlanId, type PlanId } from "../shared/plans";
import type { App, Env, DbUser } from "./types";
import { now, ready, uid, DAY, GB } from "./types";
import { hmac, origin, rate, sha } from "./security";

export const billing = new Hono<App>();
export function stripe(env: Env) {
  if (!env.STRIPE_SECRET_KEY) throw new HTTPException(503, { message: "Payments are not set up yet." });
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(), maxNetworkRetries: 2 });
}
/** A renewing subscription keeps its last paid period this long while Stripe collects the new invoice. */
export const RENEWAL_GRACE = 3 * DAY;

/**
 * Identifies a free allowance across account deletion without keeping the address: an HMAC of the mailbox keyed with
 * TRIAL_HASH_SECRET (a plain hash of a known address could be recomputed), or a plain hash when no secret is set.
 */
export async function trialKey(e: Env, email: string) {
  const box = "trial:" + mailbox(email);
  return e.TRIAL_HASH_SECRET ? hmac(e.TRIAL_HASH_SECRET, box) : sha(box);
}
/** Keeps the mailbox's trial row current (called on sign-in). */
export async function touchTrial(e: Env, email: string) {
  await e.DB.prepare("UPDATE trial_history SET updated_at=? WHERE email_hash=?").bind(now(), await trialKey(e, email)).run();
}
/** One mailbox, however it is written: "+tags" are ignored, and Gmail also ignores dots in the name. */
export function mailbox(email: string) {
  const [name, domain = ""] = email.trim().toLowerCase().split(/@(?=[^@]*$)/);
  const gmail = domain === "gmail.com" || domain === "googlemail.com";
  const base = name.replace(/\+.*$/, "");
  return `${gmail ? base.replace(/\./g, "") : base}@${gmail ? "gmail.com" : domain}`;
}
function priceIds(e: Env): Record<PaidPlanId, string | undefined> {
  return { starter: e.STRIPE_PRICE_STARTER, growth: e.STRIPE_PRICE_GROWTH, pro: e.STRIPE_PRICE_PRO };
}

export type Allowance = Awaited<ReturnType<typeof allowance>>;
/**
 * The account's plan and the usage window it spends from: AI credits (`used`/`limit`) and posts
 * (`postsUsed`/`postsLimit`). A paid period has its own window (user:subscription:period_start); the free allowance
 * is one lasting window (user:trial), once per mailbox.
 */
export async function allowance(e: Env, u: DbUser) {
  // An incomplete subscription (a checkout that was abandoned or not paid yet) gives no access.
  const sub = await e.DB.prepare(
    "SELECT s.*,st.status AS stripe_status FROM subscriptions s LEFT JOIN stripe_status st ON st.subscription_id=s.id WHERE s.user_id=? AND s.status IN ('active','trialing','past_due','unpaid') ORDER BY s.status='active' DESC, s.period_end DESC LIMIT 1",
  ).bind(u.id).first<any>();
  // A renewing subscription keeps its last paid period until Stripe confirms the new invoice.
  const active = !!sub && sub.status === "active" && sub.period_end + (sub.cancel_at_period_end ? 0 : RENEWAL_GRACE) > now();
  const plan = planById(active ? sub.plan : "free");
  const window = active ? `${u.id}:${sub.id}:${sub.period_start}` : `${u.id}:trial`;
  // Same plan: the window keeps its quota. A downgrade inside a period uses the new plan's allowance; an upgrade adds
  // only the unused share of the difference, so upgrading on the last day does not unlock a whole month.
  const left = active && sub.period_end > sub.period_start
    ? Math.min(1, Math.max(0, (sub.period_end - now()) / (sub.period_end - sub.period_start))) : 1;
  const trial = await trialKey(e, u.email);
  const newTrial = !active && !(await e.DB.prepare("SELECT 1 FROM usage_windows WHERE id=?").bind(window).first());
  const prorate = (column: string) =>
    `CASE WHEN usage_windows.plan=excluded.plan THEN usage_windows.${column} WHEN excluded.${column}>usage_windows.${column} THEN usage_windows.${column}+CAST((excluded.${column}-usage_windows.${column})*?7 AS INTEGER) ELSE excluded.${column} END`;
  await e.DB.batch([
    e.DB.prepare(
      `INSERT INTO usage_windows(id,user_id,plan,quota,posts_quota,used,posts_used) VALUES (?1,?2,?3,?4,?5,
        CASE WHEN ?3='free' THEN COALESCE((SELECT used FROM trial_history WHERE email_hash=?6),0) ELSE 0 END,
        CASE WHEN ?3='free' THEN COALESCE((SELECT posts_used FROM trial_history WHERE email_hash=?6),0) ELSE 0 END)
       ON CONFLICT(id) DO UPDATE SET quota=${prorate("quota")},posts_quota=${prorate("posts_quota")},plan=excluded.plan`,
    ).bind(window, u.id, plan.id, plan.credits, plan.posts, trial, left),
    // Storage follows the plan; files over a lower limit stay, new ones wait until there is room.
    e.DB.prepare("INSERT INTO media_limits(user_id,max_bytes) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET max_bytes=excluded.max_bytes")
      .bind(u.id, plan.storageGb * GB),
  ]);
  // The free allowance is once per mailbox: another account of the same address starts with it used up.
  if (newTrial)
    await e.DB.prepare(
      "INSERT INTO trial_history(email_hash,used,posts_used,updated_at) VALUES (?,?,?,?) ON CONFLICT(email_hash) DO UPDATE SET used=MAX(trial_history.used,excluded.used),posts_used=MAX(trial_history.posts_used,excluded.posts_used),updated_at=excluded.updated_at",
    ).bind(trial, plan.credits, plan.posts, now()).run();
  const usage = await e.DB.prepare("SELECT used,quota,posts_used,posts_quota FROM usage_windows WHERE id=?")
    .bind(window).first<{ used: number; quota: number; posts_used: number; posts_quota: number }>();
  const trialEndsAt = plan.id === "free" ? u.created_at + TRIAL_DAYS * DAY : null;
  return {
    plan: plan.id as PlanId,
    /** Free plan: new posts can be made until then. */
    trialEndsAt,
    trialEnded: trialEndsAt !== null && trialEndsAt <= now(),
    used: usage?.used || 0,
    limit: usage?.quota ?? plan.credits,
    postsUsed: usage?.posts_used || 0,
    postsLimit: usage?.posts_quota ?? plan.posts,
    window,
    periodEnd: active ? (sub.period_end as number) : null,
    hasSubscription: !!sub,
    /** Stripe reports the latest payment as failed (it retries the card meanwhile), or the period ended unpaid. */
    paymentIssue: !!sub && (["past_due", "unpaid"].includes(sub.stripe_status ?? sub.status) ||
      (sub.status === "active" && !sub.cancel_at_period_end && sub.period_end + RENEWAL_GRACE < now())),
  };
}

billing.post("/checkout", async (c) => {
  const u = c.get("user");
  if (!u.verified) throw new HTTPException(403, { message: "Confirm your email before subscribing." });
  if (c.env.BILLING_ENABLED !== "true" || !ready(c.env)) throw new HTTPException(503, { message: "Subscriptions are not open yet." });
  await rate(c, "checkout", 8, 3600, u.id);
  const parsed = z.object({ plan: z.enum(paidPlans) }).safeParse(await c.req.json());
  const requested = parsed.success ? parsed.data.plan : null;
  let id = requested && priceIds(c.env)[requested];
  if (!requested || !id) throw new HTTPException(400, { message: "This plan is not available." });
  const s = stripe(c.env);
  let customer = u.stripe_customer;
  if (!customer) {
    const created = await s.customers.create({ email: u.email, name: u.name, metadata: { user_id: u.id } }, { idempotencyKey: "customer-" + u.id });
    customer = created.id;
    await c.env.DB.prepare("UPDATE users SET stripe_customer=? WHERE id=?").bind(customer, u.id).run();
  }
  const existing = await s.subscriptions.list({ customer, status: "all", limit: 100 });
  if (existing.data.some((x) => !["canceled", "incomplete_expired", "incomplete"].includes(x.status)))
    return c.json({ url: await portalUrl(c.env, c.req.raw, customer, requested) });
  // An unfinished earlier checkout is closed first so its invoice cannot still be paid next to a new one.
  for (const x of existing.data) if (x.status === "incomplete") await s.subscriptions.cancel(x.id);
  await c.env.DB.prepare(
    "INSERT INTO checkout_intents(user_id,plan,intent_id,expires_at) VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,intent_id=excluded.intent_id,expires_at=excluded.expires_at WHERE checkout_intents.expires_at<?",
  ).bind(u.id, requested, uid(), now() + 1860, now()).run();
  const intent = await c.env.DB.prepare("SELECT * FROM checkout_intents WHERE user_id=?").bind(u.id).first<any>();
  if (intent.plan !== requested) {
    // Close the checkout for the earlier choice so only one subscription can ever be started.
    const open = await s.checkout.sessions.list({ customer, status: "open", limit: 100 });
    for (const session of open.data) await s.checkout.sessions.expire(session.id);
    intent.plan = requested;
    intent.intent_id = uid();
    await c.env.DB.prepare("UPDATE checkout_intents SET plan=?,intent_id=? WHERE user_id=?").bind(intent.plan, intent.intent_id, u.id).run();
  }
  const plan = intent.plan as PaidPlanId;
  id = priceIds(c.env)[plan];
  if (!id) throw new HTTPException(503, { message: "This plan is temporarily unavailable." });
  const p = await s.prices.retrieve(id);
  const chosen = planById(plan);
  if (!p.active || p.currency !== "usd" || p.unit_amount !== chosen.price * 100 || p.recurring?.interval !== "month" || p.recurring.interval_count !== 1)
    throw new HTTPException(503, { message: "This plan is being updated. Please try again later." });
  const tax = c.env.STRIPE_AUTOMATIC_TAX === "true";
  const session = await s.checkout.sessions.create(
    {
      mode: "subscription",
      customer,
      expires_at: intent.expires_at,
      line_items: [{ price: id, quantity: 1 }],
      allow_promotion_codes: true,
      ...(tax && { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, billing_address_collection: "required" as const, customer_update: { address: "auto" as const, name: "auto" as const } }),
      client_reference_id: u.id,
      metadata: { user_id: u.id },
      subscription_data: { metadata: { user_id: u.id } },
      success_url: origin(c.env, c.req.raw) + "/app/billing?success=1",
      cancel_url: origin(c.env, c.req.raw) + "/app/billing?cancelled=1",
    },
    { idempotencyKey: `checkout-${intent.intent_id}-${id}` },
  );
  return c.json({ url: session.url });
});
/** Re-reads the customer's subscriptions from Stripe (on return from Checkout or the portal). */
billing.post("/sync", async (c) => {
  const u = c.get("user");
  if (!u.stripe_customer) return c.json({ ok: true });
  await rate(c, "billing-sync", 30, 3600, u.id);
  await syncCustomer(c.env, u.id, u.stripe_customer);
  return c.json({ ok: true });
});
async function syncCustomer(e: Env, userId: string, customer: string) {
  const fetchedAt = now();
  const list = await stripe(e).subscriptions.list({ customer, status: "all", limit: 10, expand: ["data.latest_invoice"] });
  const statements: D1PreparedStatement[] = [];
  for (const sub of list.data) statements.push(...(await subscriptionStatements(e, sub, userId, fetchedAt)));
  if (statements.length) await e.DB.batch(statements);
  return statements.length > 0;
}
/** Nightly backstop for missed webhooks: customers whose plan looks doubtful are re-read from Stripe. */
export async function reconcileStripe(e: Env) {
  if (e.BILLING_ENABLED !== "true" || !e.STRIPE_SECRET_KEY) return;
  const users = (await e.DB.prepare(
    `SELECT u.id,u.stripe_customer FROM users u LEFT JOIN stripe_reconciled r ON r.user_id=u.id WHERE u.stripe_customer IS NOT NULL AND (
      EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=u.id AND ((s.status='active' AND s.period_end<?1) OR s.status IN ('past_due','incomplete','trialing','unpaid')))
      OR (EXISTS(SELECT 1 FROM checkout_intents c WHERE c.user_id=u.id AND c.expires_at>?1-2*86400) AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.user_id=u.id AND s.status='active'))
    ) ORDER BY COALESCE(r.checked_at,0) LIMIT 50`,
  ).bind(now()).all<{ id: string; stripe_customer: string }>()).results;
  let changed = 0;
  for (const u of users) {
    try { if (await syncCustomer(e, u.id, u.stripe_customer)) changed++; }
    catch (error) { console.error("Stripe reconciliation failed", { userId: u.id, error: (error as Error)?.name }); }
    await e.DB.prepare("INSERT INTO stripe_reconciled(user_id,checked_at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET checked_at=excluded.checked_at")
      .bind(u.id, now()).run();
  }
  if (users.length) console.log("Stripe reconciliation", { checked: users.length, updated: changed });
}
/** A Customer Portal link; with a plan it opens on the confirmation of that plan change. */
async function portalUrl(e: Env, request: Request, customer: string, plan?: PaidPlanId | null) {
  const s = stripe(e), back = origin(e, request) + "/app/billing?portal=1";
  const price = plan ? priceIds(e)[plan] : undefined;
  if (price) {
    try {
      const sub = (await s.subscriptions.list({ customer, status: "active", limit: 1 })).data[0];
      const item = sub?.items.data[0];
      if (sub && item && sub.items.data.length === 1 && item.price.id !== price)
        return (await s.billingPortal.sessions.create({
          customer, return_url: back,
          flow_data: {
            type: "subscription_update_confirm",
            subscription_update_confirm: { subscription: sub.id, items: [{ id: item.id, price, quantity: 1 }] },
            after_completion: { type: "redirect", redirect: { return_url: back } },
          },
        })).url;
    } catch {
      console.error("Plan change flow unavailable; opening the Customer Portal", { plan });
    }
  }
  return (await s.billingPortal.sessions.create({ customer, return_url: back })).url;
}
billing.post("/portal", async (c) => {
  const u = c.get("user");
  if (!u.stripe_customer) throw new HTTPException(400, { message: "You don't have a paid subscription yet." });
  await rate(c, "billing-portal", 20, 3600, u.id);
  const body = await c.req.json().catch(() => ({}));
  const plan = z.object({ plan: z.enum(paidPlans) }).safeParse(body);
  return c.json({ url: await portalUrl(c.env, c.req.raw, u.stripe_customer, plan.success ? plan.data.plan : null) });
});
/** The plan of a Stripe price: a configured STRIPE_PRICE_*, or its lookup key / metadata.plan. */
function planOf(e: Env, price: Stripe.Price | undefined): PlanId | undefined {
  if (!price) return undefined;
  const configured = Object.entries(priceIds(e)).find(([, v]) => v === price.id)?.[0];
  const named = [price.lookup_key, price.metadata?.plan].find((p) => (paidPlans as readonly string[]).includes(p || ""));
  return (configured || named || undefined) as PlanId | undefined;
}
/** Stores Stripe's current state of a subscription; an older reading (`fetchedAt`) never overwrites a newer one. */
async function subscriptionStatements(e: Env, sub: Stripe.Subscription, userId: string, fetchedAt: number) {
  const item = sub.items.data[0];
  const plan = planOf(e, item?.price);
  const status = e.DB.prepare(
    "INSERT INTO stripe_status(subscription_id,user_id,status,fetched_at) VALUES (?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET status=excluded.status,fetched_at=excluded.fetched_at WHERE excluded.fetched_at>=stripe_status.fetched_at",
  ).bind(sub.id, userId, sub.status, fetchedAt);
  if (!plan) {
    console.error("Subscription price is not a configured plan", { subscription: sub.id, price: item?.price.id });
    return item ? [e.DB.prepare(
      "UPDATE subscriptions SET status=?,period_start=?,period_end=?,cancel_at_period_end=?,event_created=? WHERE id=? AND ?>=event_created",
    ).bind(sub.status, item.current_period_start, item.current_period_end, sub.cancel_at_period_end ? 1 : 0, fetchedAt, sub.id, fetchedAt), status] : [status];
  }
  const invoice = sub.latest_invoice as Stripe.Invoice | null;
  const unpaid = sub.status === "active" && (!invoice || typeof invoice !== "object" || invoice.status !== "paid");
  // A renewal or plan-change invoice is open for a moment: keep the stored, paid state until it is paid.
  const pending = (unpaid || sub.status === "past_due") && typeof invoice === "object" &&
    ["subscription_cycle", "subscription_update"].includes(invoice?.billing_reason || "") &&
    !!(await e.DB.prepare("SELECT id FROM subscriptions WHERE id=? AND status='active'").bind(sub.id).first());
  if (pending) return [status];
  return [e.DB.prepare(
    "INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET plan=excluded.plan,status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,event_created=excluded.event_created WHERE excluded.event_created>=subscriptions.event_created",
  ).bind(sub.id, userId, plan, unpaid ? "past_due" : sub.status, item.current_period_start, item.current_period_end, sub.cancel_at_period_end ? 1 : 0, fetchedAt), status];
}
/**
 * A full refund, a chargeback or the deletion of the account ends the paid plan at once: subscriptions are cancelled
 * in Stripe and the credits left in paid periods stop. Safe to repeat.
 */
export async function endPaidAccess(e: Env, customer: string, reason: "refund" | "dispute" | "deletion") {
  const s = stripe(e), fetchedAt = now();
  const user = await e.DB.prepare("SELECT id FROM users WHERE stripe_customer=?").bind(customer).first<{ id: string }>();
  const list = await s.subscriptions.list({ customer, status: "all", limit: 10 });
  const statements: D1PreparedStatement[] = [];
  let cancelled = 0;
  for (const sub of list.data) {
    const ended = ["canceled", "incomplete_expired"].includes(sub.status);
    const current = ended ? sub : await s.subscriptions.cancel(sub.id);
    if (!ended) cancelled++;
    if (user) statements.push(...(await subscriptionStatements(e, current, user.id, fetchedAt)));
  }
  if (user)
    statements.push(e.DB.prepare("UPDATE usage_windows SET quota=used,posts_quota=posts_used WHERE user_id=? AND id LIKE ?").bind(user.id, `${user.id}:sub_%`));
  if (statements.length) await e.DB.batch(statements);
  console.error("Paid access ended", { userId: user?.id ?? null, reason, cancelled });
}
const customerId = (c: string | { id: string }) => (typeof c === "string" ? c : c.id);
export async function webhook(request: Request, e: Env) {
  if (!e.STRIPE_WEBHOOK_SECRET) throw new HTTPException(503, { message: "Payments are not set up." });
  const s = stripe(e);
  let event: Stripe.Event;
  try {
    event = await s.webhooks.constructEventAsync(
      await request.text(), request.headers.get("stripe-signature") || "", e.STRIPE_WEBHOOK_SECRET, 300, Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    throw new HTTPException(400, { message: "Invalid signature." });
  }
  if (await e.DB.prepare("SELECT id FROM billing_events WHERE id=?").bind(event.id).first()) return { received: true };
  let subscriptionId: string | undefined;
  const object = event.data.object as any;
  if (event.type.startsWith("customer.subscription.")) subscriptionId = object.id;
  else if (event.type === "checkout.session.completed")
    subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription?.id;
  else if (["invoice.paid", "invoice.payment_failed"].includes(event.type))
    subscriptionId = object.parent?.subscription_details?.subscription || object.subscription;
  const statements: D1PreparedStatement[] = [];
  if (event.type === "charge.refunded" && object.refunded === true && object.customer) await endPaidAccess(e, customerId(object.customer), "refund");
  if (event.type === "charge.dispute.created" && object.charge) {
    const charge = await s.charges.retrieve(customerId(object.charge));
    if (charge.customer) await endPaidAccess(e, customerId(charge.customer), "dispute");
  }
  if (subscriptionId) {
    // Current state from Stripe: never grant access based on a redirect, a stale payload or an invoice alone.
    const fetchedAt = now();
    const sub = await s.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice"] });
    const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const user = await e.DB.prepare("SELECT id FROM users WHERE stripe_customer=?").bind(customer).first<{ id: string }>();
    if (!user && sub.metadata?.user_id && !["canceled", "incomplete_expired"].includes(sub.status) &&
      !(await e.DB.prepare("SELECT id FROM users WHERE id=?").bind(sub.metadata.user_id).first())) {
      // Started by an account that no longer exists: nobody can use or cancel it.
      await s.subscriptions.cancel(sub.id);
      console.error("Cancelled subscription of a deleted account; review for refund", { subscription: sub.id });
    }
    if (user) statements.push(...(await subscriptionStatements(e, sub, user.id, fetchedAt)));
  }
  statements.push(e.DB.prepare("INSERT OR IGNORE INTO billing_events(id,created_at) VALUES (?,?)").bind(event.id, now()));
  await e.DB.batch(statements);
  return { received: true };
}
export { plans };
