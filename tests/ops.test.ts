import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import worker from "../server/index";
import { maintenance, drainCleanup } from "../server/maintenance";
import { confirmPendingContracts, reconcileStripe, webhook } from "../server/billing";
import { applyRetention } from "../server/retention";
import { attention, operationsSnapshot, reviewRuns } from "../server/operations";
import { IMMEDIATE_START_TEXT, IMMEDIATE_START_VERSION, usedMeter, withdrawalRefund } from "../shared/withdrawal";
import { now, DAY, HOUR } from "../server/types";
import { call, signedIn, testEnv } from "./helpers";

// Operations ported from rech-bg: HeyGen stock looks, withdrawals within 14 days, retention, plan grants and the
// hourly operations summary. Stripe and HeyGen are mocked at fetch; D1 is node:sqlite with every migration.

const secret = "whsec_local_test_only";
const signer = new Stripe("sk_test_local_only", { httpClient: Stripe.createFetchHttpClient() });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
const HOURLY = Date.UTC(2026, 9, 9, 12, 17);
const me = async (env: any, cookie: string) => (await call(worker, env, "GET", "/api/auth/me", undefined, cookie)).data.user;
const windowOf = (sqlite: any, id: string) => sqlite.prepare("SELECT used,quota,posts_used,posts_quota FROM usage_windows WHERE id=?").get(id);

/* ------------------------------------------------------------------------------------------------ HeyGen */

/** A JPEG header declaring width×height (enough for imageInfo). */
function jpeg(width = 600, height = 800) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, ...new Array(40).fill(0)]);
}
const stock = (id: string, o: Record<string, unknown> = {}) => ({
  id, name: `Look ${id}`, gender: "female", status: "completed", supported_api_engines: ["avatar_iii", "avatar_iv"],
  preview_image_url: `https://files.heygen.ai/look/${id}.jpg`, tags: ["office"], ...o,
});
/** HeyGen's list (three response shapes across pages), each look, and its CDN; anything else is refused. */
function heygenApi(calls: { url: string; key: string | null }[] = []) {
  const pages: Record<string, unknown> = {
    "": { data: [stock("look_a", { name: "Anna <b>", gender: "Female" }), stock("look_b", { gender: "male", supported_api_engines: ["avatar_iv"] }), stock("look_c"), { id: "bad/id" }], next_token: "tok_2", has_more: true },
    tok_2: { data: { items: [stock("look_d", { preview_image_url: null }), stock("look_e", { status: "processing" })], next_token: "tok_3" } },
    tok_3: { data: { looks: [stock("look_f", { gender: "male" })], next_token: "tok_4", has_more: false } },
  };
  vi.stubGlobal("fetch", async (input: string | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, key: new Headers(init.headers).get("x-api-key") });
    const u = new URL(url);
    if (u.origin + u.pathname === "https://api.heygen.com/v3/avatars/looks") {
      expect(u.searchParams.get("ownership")).toBe("public");
      expect(u.searchParams.get("limit")).toBe("50");
      return Response.json(pages[u.searchParams.get("token") || ""] ?? { error: { code: "bad_token" } }, { status: pages[u.searchParams.get("token") || ""] ? 200 : 400 });
    }
    const one = /^https:\/\/api\.heygen\.com\/v3\/avatars\/looks\/([^/?]+)$/.exec(url);
    if (one) {
      const all = [...(pages[""] as any).data, ...(pages.tok_2 as any).data.items, ...(pages.tok_3 as any).data.looks];
      const look = all.find((l: any) => l.id === one[1]);
      return look ? Response.json({ data: look }) : Response.json({ error: { code: "not_found" } }, { status: 404 });
    }
    if (url.startsWith("https://files.heygen.ai/")) return new Response(jpeg(), { headers: { "Content-Type": "image/jpeg" } });
    if (url === "https://files.heygen.ai.evil.test/x.jpg" || url.startsWith("https://evil.test/")) throw new Error("must not be fetched");
    throw new TypeError(`unexpected fetch ${url}`);
  });
  return calls;
}
function admins(overrides: Record<string, unknown> = {}) {
  const { env, sqlite } = testEnv({ HEYGEN_API_KEY: "hg", ...overrides });
  return { env, sqlite, admin: signedIn(sqlite, "admin@example.com"), user: signedIn(sqlite) };
}

describe("browsing HeyGen's stock looks", () => {
  it("pages through every response shape, marks library looks and serves previews through our own route", async () => {
    const { env, sqlite, admin } = admins();
    sqlite.prepare("INSERT INTO characters(id,user_id,name,image_key,mime,look_id,active,created_at,updated_at) VALUES ('c1',NULL,'Cara','library/c1/p.jpg','image/jpeg','look_c',0,1,1)").run();
    const calls = heygenApi();
    const first = await call(worker, env, "GET", "/api/admin/heygen/looks", undefined, admin.cookie);
    expect(first.status).toBe(200);
    expect(calls[0].key).toBe("hg");
    expect(first.data.nextPage).toBe("tok_2");
    expect(first.data.looks.map((l: any) => l.id)).toEqual(["look_a", "look_b", "look_c"]);
    expect(first.data.looks[0]).toMatchObject({
      name: "Anna b", gender: "female", tags: ["office"], engines: ["avatar_iii", "avatar_iv"], importable: true, library: null,
      image: `/api/admin/heygen/image?src=${encodeURIComponent("https://files.heygen.ai/look/look_a.jpg")}`,
    });
    expect(first.data.looks[1]).toMatchObject({ importable: false, engines: ["avatar_iv"] });
    expect(first.data.looks[2].library).toEqual({ id: "c1", name: "Cara", active: false });
    const second = await call(worker, env, "GET", "/api/admin/heygen/looks?page=tok_2", undefined, admin.cookie);
    expect(new URL(calls.at(-1)!.url).searchParams.get("token")).toBe("tok_2");
    // Still processing looks are left out; a look without a preview can't be imported.
    expect(second.data.looks).toEqual([expect.objectContaining({ id: "look_d", importable: false, image: null })]);
    expect(second.data.nextPage).toBe("tok_3");
    const third = await call(worker, env, "GET", "/api/admin/heygen/looks?page=tok_3", undefined, admin.cookie);
    expect(third.data.looks.map((l: any) => l.id)).toEqual(["look_f"]);
    expect(third.data.nextPage).toBeNull();
    // A bad page token is HeyGen's refusal, shown without its text.
    const bad = await call(worker, env, "GET", "/api/admin/heygen/looks?page=nope", undefined, admin.cookie);
    expect(bad.status).toBe(502);
    expect(JSON.stringify(bad.data)).not.toContain("bad_token");

    const image = await call(worker, env, "GET", first.data.looks[0].image, undefined, admin.cookie);
    expect(image.status).toBe(200);
    expect(image.headers.get("Content-Type")).toBe("image/jpeg");
    expect(image.headers.get("Cache-Control")).toBe("private, max-age=86400");
  });

  it("never fetches previews from other hosts, follows only HeyGen redirects and accepts only small images", async () => {
    const { env, admin } = admins();
    const fetched: string[] = [];
    let answer: () => Response = () => new Response(jpeg());
    vi.stubGlobal("fetch", async (url: string) => { fetched.push(url); return answer(); });
    for (const src of ["https://evil.test/x.jpg", "http://files.heygen.ai/x.jpg", "https://files.heygen.ai.evil.test/x.jpg", "https://user:pw@files.heygen.ai/x.jpg", "https://files.heygen.ai:8443/x.jpg", "not a url"]) {
      const r = await call(worker, env, "GET", `/api/admin/heygen/image?src=${encodeURIComponent(src)}`, undefined, admin.cookie);
      expect(r.status).toBe(404);
    }
    expect(fetched).toEqual([]);
    answer = () => new Response(null, { status: 302, headers: { Location: "https://evil.test/y.jpg" } });
    expect((await call(worker, env, "GET", `/api/admin/heygen/image?src=${encodeURIComponent("https://files.heygen.ai/x.jpg")}`, undefined, admin.cookie)).status).toBe(404);
    expect(fetched).toEqual(["https://files.heygen.ai/x.jpg"]);
    answer = () => new Response("<svg onload=alert(1)>", { headers: { "Content-Type": "image/jpeg" } });
    expect((await call(worker, env, "GET", `/api/admin/heygen/image?src=${encodeURIComponent("https://files.heygen.ai/x.jpg")}`, undefined, admin.cookie)).status).toBe(404);
    answer = () => new Response(new Uint8Array(6 * 1024 * 1024).fill(0xff), { headers: { "Content-Type": "image/jpeg" } });
    expect((await call(worker, env, "GET", `/api/admin/heygen/image?src=${encodeURIComponent("https://files.heygen.ai/x.jpg")}`, undefined, admin.cookie)).status).toBe(404);
  });

  it("imports a selection through the bulk import, with each look's gender, and marks it in the next listing", async () => {
    const { env, sqlite, admin } = admins();
    heygenApi();
    // The page sends one request per gender group.
    const female = await call(worker, env, "POST", "/api/admin/characters/import/bulk", { lookIds: ["look_a", "look_c"], gender: "female" }, admin.cookie);
    const male = await call(worker, env, "POST", "/api/admin/characters/import/bulk", { lookIds: ["look_f", "look_b"], gender: "male" }, admin.cookie);
    expect(female.data).toMatchObject({ imported: 2, failed: 0 });
    expect(male.data.results).toEqual([
      expect.objectContaining({ lookId: "look_f", status: "imported" }),
      expect.objectContaining({ lookId: "look_b", status: "unusable", error: expect.stringMatching(/Avatar III/) }),
    ]);
    const rows = sqlite.prepare("SELECT look_id,gender,name FROM characters WHERE user_id IS NULL ORDER BY look_id").all();
    expect(rows).toEqual([
      { look_id: "look_a", gender: "female", name: "Anna b" },
      { look_id: "look_c", gender: "female", name: "Look look_c" },
      { look_id: "look_f", gender: "male", name: "Look look_f" },
    ]);
    const listed = await call(worker, env, "GET", "/api/admin/heygen/looks", undefined, admin.cookie);
    expect(listed.data.looks.filter((l: any) => l.library).map((l: any) => l.id)).toEqual(["look_a", "look_c"]);
  });

  it("says when HeyGen isn't set up", async () => {
    const { env, admin } = admins({ HEYGEN_API_KEY: "" });
    const r = await call(worker, env, "GET", "/api/admin/heygen/looks", undefined, admin.cookie);
    expect(r.status).toBe(503);
    expect(r.data.error).toContain("HEYGEN_API_KEY");
  });
});

describe("administrator-only routes", () => {
  it("hide every new admin route from other people and need a session", async () => {
    const { env, user } = admins();
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { fetched.push(url); return Response.json({}); });
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/admin/heygen/looks"], ["GET", `/api/admin/heygen/image?src=${encodeURIComponent("https://files.heygen.ai/x.jpg")}`],
      ["GET", "/api/admin/operations"], ["GET", "/api/admin/withdrawals"], ["GET", "/api/admin/withdrawals/quote?email=a@example.com"],
      ["POST", "/api/admin/withdrawals", { email: "a@example.com", refund: 0 }], ["GET", "/api/admin/grants"],
      ["POST", "/api/admin/grants", { email: user.email, plan: "pro" }], ["DELETE", "/api/admin/grants/grant_x"],
    ];
    for (const [method, path, body] of routes) {
      expect((await call(worker, env, method, path, body, user.cookie)).status, `${method} ${path}`).toBe(404);
      expect((await call(worker, env, method, path, body)).status, `${method} ${path} signed out`).toBe(401);
    }
    expect(fetched).toEqual([]);
    expect((await me(env, user.cookie)).plan).toBe("free");
  });
});

/* ------------------------------------------------------------------------------------------------ withdrawals */

describe("withdrawal refund", () => {
  it("is what was paid less the larger used share of posts and AI credits, in whole cents", () => {
    const u = (used: number, postsUsed: number) => ({ used, quota: 500, postsUsed, postsQuota: 600 });
    expect(withdrawalRefund(4900, u(0, 0))).toBe(4900);
    expect(withdrawalRefund(4900, u(125, 60))).toBe(3675); // credits 25% > posts 10%
    expect(usedMeter(u(125, 60)).meter).toBe("credits");
    expect(withdrawalRefund(4900, u(50, 300))).toBe(2450); // posts 50% > credits 10%
    expect(usedMeter(u(50, 300)).meter).toBe("posts");
    expect(withdrawalRefund(2900, { used: 3, quota: 10, postsUsed: 0, postsQuota: 10 })).toBe(2030); // 0.7 × 2900 without float loss
    expect(withdrawalRefund(4900, u(500, 0))).toBe(0);
    expect(withdrawalRefund(4900, u(900, 900))).toBe(0);
    expect(withdrawalRefund(0, u(0, 0))).toBe(0);
    expect(withdrawalRefund(4900, { used: 0, quota: 0, postsUsed: 3, postsQuota: 6 })).toBe(2450);
  });
});

type StripeCall = { method: string; url: string; body: string; key: string | null };
/** A small Stripe API: the calls made, and answers for the ones these flows use. */
function stripeApi(o: { started?: number; refundFails?: boolean; subscriptions?: () => any[] } = {}) {
  const calls: StripeCall[] = [];
  let cancelled = false;
  const sub = () => ({
    id: "sub_1", object: "subscription", customer: "cus_1", status: cancelled ? "canceled" : "active", cancel_at_period_end: false, metadata: {},
    start_date: o.started ?? now() - 3 * DAY,
    items: { data: [{ id: "si_1", price: { id: "price_growth" }, current_period_start: 100, current_period_end: now() + 27 * DAY }] },
    latest_invoice: { id: "in_1", status: "paid" },
  });
  vi.stubGlobal("fetch", async (input: string, init: any = {}) => {
    const url = String(input), method = init.method || "GET";
    calls.push({ method, url, body: String(init.body || ""), key: new Headers(init.headers).get("Idempotency-Key") });
    if (method === "DELETE" && url.includes("/v1/subscriptions/sub_1")) { cancelled = true; return Response.json(sub()); }
    if (url.includes("/v1/subscriptions/sub_1")) return Response.json(sub());
    if (url.includes("/v1/subscriptions")) return Response.json({ object: "list", has_more: false, data: o.subscriptions ? o.subscriptions() : [sub()] });
    if (url.includes("/v1/invoices")) return Response.json({ object: "list", has_more: false, data: [{ id: "in_1", object: "invoice", created: now() - 3 * DAY, currency: "usd",
      payments: { object: "list", data: [{ status: "paid", amount_paid: 4900, payment: { type: "payment_intent", payment_intent: "pi_1" } }] } }] });
    if (url.includes("/v1/payment_intents/pi_1")) return Response.json({ id: "pi_1", object: "payment_intent", latest_charge: { id: "ch_1", amount: 4900, amount_refunded: 0 } });
    if (url.includes("/v1/refunds")) {
      if (o.refundFails) return Response.json({ error: { type: "invalid_request_error", message: "No" } }, { status: 400 });
      return Response.json({ id: "re_1", object: "refund", amount: Number(new URLSearchParams(init.body).get("amount")) });
    }
    if (url.includes("/v1/customers")) return Response.json({ id: "cus_1", object: "customer" });
    if (url.includes("/v1/prices/")) return Response.json({ id: "price_growth", active: true, currency: "usd", unit_amount: 4900, recurring: { interval: "month", interval_count: 1 } });
    if (url.includes("/v1/checkout/sessions")) return Response.json({ id: "cs_test_1", object: "checkout.session", url: "https://checkout.stripe.com/test" });
    return Response.json({ error: { message: "not mocked " + url } }, { status: 404 });
  });
  return calls;
}
async function event(type: string, object: any, id = "evt_" + crypto.randomUUID()) {
  const body = JSON.stringify({ id, type, object: "event", created: now(), data: { object } });
  const signature = await signer.webhooks.generateTestHeaderStringAsync({ payload: body, secret });
  return new Request("https://app.test/api/billing/webhook", { method: "POST", headers: { "stripe-signature": signature }, body });
}
const billingEnv = () => testEnv({ BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_local_only", STRIPE_WEBHOOK_SECRET: secret, STRIPE_PRICE_GROWTH: "price_growth", COMPANY_ADDRESS: "1 Example St, Sofia" });
/** A customer three days into a paid Growth month (a quarter of the credits and a tenth of the posts used), and an admin. */
function paying() {
  const { env, sqlite } = billingEnv();
  const admin = signedIn(sqlite, "admin@example.com"), client = signedIn(sqlite, "client@example.com");
  sqlite.prepare("UPDATE users SET stripe_customer='cus_1' WHERE id=?").run(client.id);
  sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end,cancel_at_period_end,event_created) VALUES ('sub_1',?,'growth','active',100,?,0,1)").run(client.id, now() + 27 * DAY);
  sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,posts_quota,used,posts_used) VALUES (?,?,'growth',500,600,125,60)").run(`${client.id}:sub_1:100`, client.id);
  // An administrator's grant: refunds and withdrawals never touch it.
  sqlite.prepare("INSERT INTO usage_windows(id,user_id,plan,quota,posts_quota,used,posts_used) VALUES (?,?,'pro',2000,3000,0,0)").run(`${client.id}:grant_1:100`, client.id);
  return { env, sqlite, admin, client };
}

describe("checkout with the request for immediate start", () => {
  it("is refused without the request, before anything is sent to Stripe", async () => {
    const { env, sqlite } = billingEnv();
    const a = signedIn(sqlite);
    const calls = stripeApi({ subscriptions: () => [] });
    for (const body of [{ plan: "growth" }, { plan: "growth", immediateStart: false }]) {
      const r = await call(worker, env, "POST", "/api/billing/checkout", body, a.cookie);
      expect(r.status).toBe(400);
      expect(r.data.error).toContain("start straight after payment");
    }
    expect(calls).toEqual([]);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM checkout_consents").get()).toEqual({ n: 0 });
  });
  it("records the request, repeats it on Stripe's page and confirms the contract by email once paid", async () => {
    const { env, sqlite } = billingEnv();
    const a = signedIn(sqlite, "client@example.com");
    const calls = stripeApi({ subscriptions: () => [] });
    const r = await call(worker, env, "POST", "/api/billing/checkout", { plan: "growth", immediateStart: true }, a.cookie);
    expect(r.status).toBe(200);
    const session = new URLSearchParams(calls.find((c) => c.url.endsWith("/v1/checkout/sessions"))!.body);
    expect(session.get("custom_text[submit][message]")).toBe(IMMEDIATE_START_TEXT);
    expect(session.get("subscription_data[metadata][immediate_start]")).toBe(IMMEDIATE_START_VERSION);
    expect(sqlite.prepare("SELECT session_id,user_id,plan,version,completed_at FROM checkout_consents").get())
      .toEqual({ session_id: "cs_test_1", user_id: a.id, plan: "growth", version: IMMEDIATE_START_VERSION, completed_at: null });

    stripeApi();
    const send = env.EMAIL.send;
    env.EMAIL.send = vi.fn().mockRejectedValueOnce(new Error("mail down"));
    await webhook(await event("checkout.session.completed", { id: "cs_test_1", subscription: "sub_1" }), env);
    expect((sqlite.prepare("SELECT completed_at,confirmed_at FROM checkout_consents").get() as any)).toMatchObject({ completed_at: expect.any(Number), confirmed_at: null });
    env.EMAIL.send = send;
    await confirmPendingContracts(env);
    expect(env.EMAIL.sent).toHaveLength(1);
    const mail = env.EMAIL.sent[0];
    expect(mail.to).toBe("client@example.com");
    expect(mail.text).toContain(IMMEDIATE_START_TEXT);
    expect(mail.text).toContain("$49 a month");
    expect(mail.text).toContain("https://app.test/terms#withdrawal-form");
    expect(mail.text).toContain("Test Co, 1 Example St, Sofia");
    await confirmPendingContracts(env);
    expect(env.EMAIL.sent).toHaveLength(1);
  });
});

describe("withdrawal within 14 days", () => {
  it("shows the amount, then ends the plan, stops posts and credits, and refunds the unused share once", async () => {
    const { env, sqlite, admin, client } = paying();
    const calls = stripeApi();
    const quote = await call(worker, env, "GET", "/api/admin/withdrawals/quote?email=Client@Example.com", undefined, admin.cookie);
    expect(quote.data).toMatchObject({
      email: "client@example.com", plan: "Growth", open: true, paid: 4900, currency: "usd", used: 125, quota: 500, postsUsed: 60, postsQuota: 600, meter: "credits", refund: 3675, withdrawal: null,
    });
    // The amount the administrator saw: more use since then changes it.
    const changed = await call(worker, env, "POST", "/api/admin/withdrawals", { email: "client@example.com", refund: 4900 }, admin.cookie);
    expect(changed.status).toBe(409);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    const r = await call(worker, env, "POST", "/api/admin/withdrawals", { email: "client@example.com", refund: 3675 }, admin.cookie);
    expect(r.data).toMatchObject({ withdrawal: { refund: 3675, refunded: 3675, status: "completed", error: null } });
    const refund = calls.find((c) => c.url.endsWith("/v1/refunds"))!;
    expect(new URLSearchParams(refund.body).get("payment_intent")).toBe("pi_1");
    expect(new URLSearchParams(refund.body).get("amount")).toBe("3675");
    expect(refund.key).toBe(`withdrawal-${r.data.withdrawal.id}-pi_1`);
    // The plan ended before the money went back.
    expect(calls.findIndex((c) => c.method === "DELETE" && c.url.includes("/v1/subscriptions/sub_1"))).toBeLessThan(calls.indexOf(refund));
    expect(sqlite.prepare("SELECT status FROM subscriptions WHERE id='sub_1'").get()).toEqual({ status: "canceled" });
    expect(windowOf(sqlite, `${client.id}:sub_1:100`)).toEqual({ used: 125, quota: 125, posts_used: 60, posts_quota: 60 });
    expect(windowOf(sqlite, `${client.id}:grant_1:100`)).toEqual({ used: 0, quota: 2000, posts_used: 0, posts_quota: 3000 });
    expect(sqlite.prepare("SELECT status,paid,refund,refunded,used,quota,posts_used,posts_quota,currency FROM withdrawals").get())
      .toEqual({ status: "completed", paid: 4900, refund: 3675, refunded: 3675, used: 125, quota: 500, posts_used: 60, posts_quota: 600, currency: "usd" });
    // Once only.
    const again = await call(worker, env, "POST", "/api/admin/withdrawals", { email: "client@example.com", refund: 3675 }, admin.cookie);
    expect(again.status).toBe(409);
    expect(calls.filter((c) => c.url.endsWith("/v1/refunds"))).toHaveLength(1);
    const list = await call(worker, env, "GET", "/api/admin/withdrawals", undefined, admin.cookie);
    expect(list.data.withdrawals).toEqual([expect.objectContaining({ email: "client@example.com", refund: 3675, status: "completed" })]);
    expect((await call(worker, env, "GET", "/api/admin/withdrawals/quote?email=client@example.com", undefined, admin.cookie)).data.withdrawal).toMatchObject({ status: "completed" });
  });
  it("records a refund Stripe refused for completion by hand, and refuses after 14 days or without a paid plan", async () => {
    const { env, sqlite, admin } = paying();
    stripeApi({ refundFails: true });
    const r = await call(worker, env, "POST", "/api/admin/withdrawals", { email: "client@example.com", refund: 3675 }, admin.cookie);
    expect(r.data).toMatchObject({ withdrawal: { refunded: 0, status: "refund_failed", error: expect.stringContaining("by hand") } });
    expect(sqlite.prepare("SELECT status FROM subscriptions WHERE id='sub_1'").get()).toEqual({ status: "canceled" });

    sqlite.exec("DELETE FROM withdrawals; UPDATE usage_windows SET quota=500,posts_quota=600");
    stripeApi({ started: now() - 15 * DAY });
    const late = await call(worker, env, "POST", "/api/admin/withdrawals", { email: "client@example.com", refund: 3675 }, admin.cookie);
    expect(late.status).toBe(400);
    expect(late.data.error).toContain("withdrawal period ended");
    expect((await call(worker, env, "GET", "/api/admin/withdrawals/quote?email=nobody@example.com", undefined, admin.cookie)).status).toBe(404);
  });
});

/* ------------------------------------------------------------------------------------------------ grants */

describe("plan grants", () => {
  it("give a plan with all its posts and credits for 30 days without Stripe, and end it", async () => {
    const { env, sqlite, admin, user } = admins();
    expect((await call(worker, env, "POST", "/api/admin/grants", { email: "nobody@example.com", plan: "pro" }, admin.cookie)).status).toBe(404);
    const r = await call(worker, env, "POST", "/api/admin/grants", { email: ` ${user.email.toUpperCase()} `, plan: "pro" }, admin.cookie);
    expect(r.status).toBe(201);
    expect(r.data.end - now()).toBeGreaterThan(29 * DAY);
    expect(r.data.paidPlan).toBeNull();
    expect(await me(env, user.cookie)).toMatchObject({ plan: "pro", limit: 2000, postsLimit: 3000, used: 0, granted: true, hasSubscription: false, periodEnd: r.data.end, trialEndsAt: null });
    expect(sqlite.prepare("SELECT max_bytes FROM media_limits WHERE user_id=?").get(user.id)).toEqual({ max_bytes: 100 * 1024 ** 3 });
    const list = await call(worker, env, "GET", "/api/admin/grants", undefined, admin.cookie);
    expect(list.data.grants).toMatchObject([{ id: r.data.id, plan: "pro", email: user.email }]);
    expect((await call(worker, env, "DELETE", `/api/admin/grants/${r.data.id}`, undefined, admin.cookie)).status).toBe(200);
    expect(await me(env, user.cookie)).toMatchObject({ plan: "free", granted: false });
    expect((await call(worker, env, "DELETE", `/api/admin/grants/${r.data.id}`, undefined, admin.cookie)).status).toBe(404);
    expect((await call(worker, env, "DELETE", "/api/admin/grants/sub_1", undefined, admin.cookie)).status).toBe(404);
  });
  it("start a new month with a fresh usage window when given again, and end by themselves", async () => {
    const { env, sqlite, admin, user } = admins();
    const first = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "growth" }, admin.cookie)).data;
    await me(env, user.cookie);
    sqlite.prepare("UPDATE usage_windows SET used=480,posts_used=500 WHERE id LIKE ?").run(`${user.id}:grant_%`);
    expect(await me(env, user.cookie)).toMatchObject({ plan: "growth", used: 480, postsUsed: 500 });
    const second = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "growth" }, admin.cookie)).data;
    expect(second.id).not.toBe(first.id);
    expect(await me(env, user.cookie)).toMatchObject({ plan: "growth", used: 0, postsUsed: 0, limit: 500 });
    sqlite.prepare("UPDATE subscriptions SET period_end=? WHERE id=?").run(now() - 1, second.id);
    expect(await me(env, user.cookie)).toMatchObject({ plan: "free", granted: false, paymentIssue: false });
  });
  it("win over a lower paid plan while they run, never hide a higher one, and are left alone by Stripe", async () => {
    const { env, sqlite, admin, user } = admins({ BILLING_ENABLED: "true", STRIPE_SECRET_KEY: "sk_test_local_only", STRIPE_PRICE_STARTER: "price_starter" });
    sqlite.prepare("UPDATE users SET stripe_customer='cus_9' WHERE id=?").run(user.id);
    sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end) VALUES ('sub_9',?,'starter','active',?,?)").run(user.id, now() - 60, now() + 20 * DAY);
    const g = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "growth" }, admin.cookie)).data;
    expect(g.paidPlan).toBe("starter");
    expect(await me(env, user.cookie)).toMatchObject({ plan: "growth", granted: true, hasSubscription: true });
    sqlite.prepare("UPDATE subscriptions SET plan='pro' WHERE id='sub_9'").run();
    expect(await me(env, user.cookie)).toMatchObject({ plan: "pro", granted: false, hasSubscription: true });
    sqlite.prepare("UPDATE subscriptions SET plan='starter' WHERE id='sub_9'").run();

    // The nightly reconciliation never asks Stripe about a grant, even one that ended.
    sqlite.prepare("DELETE FROM subscriptions WHERE id='sub_9'").run();
    sqlite.prepare("UPDATE subscriptions SET period_end=? WHERE id=?").run(now() - DAY, g.id);
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return Response.json({ object: "list", data: [], has_more: false }); });
    await reconcileStripe(env);
    expect(calls).toEqual([]);
    expect(sqlite.prepare("SELECT status,period_end FROM subscriptions WHERE id=?").get(g.id)).toMatchObject({ status: "active" });
    expect(JSON.parse((sqlite.prepare("SELECT value FROM operations_state WHERE key='stripe'").get() as any).value)).toMatchObject({ checked: 0, failed: 0 });
    // A full refund ends paid periods only.
    const running = (await call(worker, env, "POST", "/api/admin/grants", { email: user.email, plan: "pro" }, admin.cookie)).data;
    await me(env, user.cookie);
    stripeApi({ subscriptions: () => [] });
    sqlite.prepare("UPDATE users SET stripe_customer='cus_1' WHERE id=?").run(user.id);
    await webhook(await event("charge.refunded", { id: "ch_1", object: "charge", customer: "cus_1", refunded: true }), { ...env, STRIPE_WEBHOOK_SECRET: secret });
    expect(windowOf(sqlite, `${user.id}:${running.id}:${(sqlite.prepare("SELECT period_start FROM subscriptions WHERE id=?").get(running.id) as any).period_start}`)).toMatchObject({ quota: 2000, posts_quota: 3000 });
    expect(await me(env, user.cookie)).toMatchObject({ plan: "pro", granted: true });
  });
});

/* ------------------------------------------------------------------------------------------------ retention */

describe("retention", () => {
  it("deletes or clears exactly what has expired, and nothing else", async () => {
    const { env, sqlite } = testEnv();
    const t = now(), old = (days: number) => t - days * DAY;
    const keep = signedIn(sqlite, "keep@example.com");
    const ins = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...(args as any[]));
    ins("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ('s-old',?,?),('s-new',?,?)", keep.id, t - 1, keep.id, t + 60);
    ins("INSERT INTO auth_tokens(token_hash,user_id,kind,expires_at) VALUES ('a-old',?,'verify',?),('a-new',?,'reset',?)", keep.id, t - 1, keep.id, t + 60);
    ins("INSERT INTO rate_limits(key,hits,expires_at) VALUES ('r-old',1,?),('r-new',1,?)", t - 1, t + 60);
    ins("INSERT INTO contact_messages(id,name,email,topic,message,created_at) VALUES ('m-old','A','a@x.test','question','hello there',?),('m-new','B','b@x.test','question','hello there',?)", old(366), old(364));
    ins("INSERT INTO billing_events(id,created_at) VALUES ('evt-old',?),('evt-new',?)", old(91), old(89));
    ins("INSERT INTO checkout_intents(user_id,plan,intent_id,expires_at) VALUES (?,'growth','i1',?)", keep.id, old(8));
    ins("INSERT INTO trial_history(email_hash,used,posts_used,updated_at) VALUES ('h-old',1,1,?),('h-new',1,1,?),('h-zero',1,1,0)", old(731), old(729));
    // Evidence: kept while the account exists, then 5 years.
    ins("INSERT INTO terms_acceptances(user_id,version,accepted_at,account_deleted_at) VALUES ('gone-old','v',1,?),('gone-new','v',1,?),(?,'v',1,NULL)", old(5 * 365 + 1), old(5 * 365 - 1), keep.id);
    ins("INSERT INTO checkout_consents(session_id,user_id,plan,version,created_at,completed_at,confirmed_at,account_deleted_at) VALUES ('cs-gone','gone-old','pro','v',1,1,1,?),('cs-abandoned',?,'pro','v',?,NULL,NULL,NULL),('cs-paid',?,'pro','v',?,?,?,NULL),('cs-recent',?,'pro','v',?,NULL,NULL,NULL)",
      old(5 * 365 + 1), keep.id, old(31), keep.id, old(400), old(400), old(400), keep.id, old(2));
    ins("INSERT INTO withdrawals(id,user_id,subscription_id,paid,refund,used,quota,posts_used,posts_quota,status,created_at,updated_at) VALUES ('w-old','x','sub_a',1,1,0,1,0,1,'completed',?,?),('w-new','x','sub_b',1,1,0,1,0,1,'completed',?,?)",
      old(5 * 365 + 1), old(5 * 365 + 1), old(5 * 365 - 1), old(5 * 365 - 1));
    // Runs: details go 30 days after they finished; the post revision and a creator's name stay.
    ins("INSERT INTO usage_windows(id,user_id,quota,posts_quota) VALUES (?,?,100,100)", `${keep.id}:trial`, keep.id);
    const run = (id: string, status: string, updated: number, payload: object, provider: object, created = updated) =>
      ins("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,status,payload,provider,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        id, keep.id, `${keep.id}:trial`, id, "image", status, JSON.stringify(payload), JSON.stringify(provider), created, updated);
    const state = { token: "tok", tickets: { avatar: { video_id: "v1" }, words: [{ w: "hi" }] } };
    run("run-old", "completed", old(31), { prompt: "my secret product", revision: 2 }, state);
    run("run-char", "failed", old(31), { name: "Mia", description: "my photo", characterId: "c9", gender: "female" }, state);
    run("run-new", "completed", old(29), { prompt: "recent" }, state);
    run("run-unstarted", "failed", old(33), { prompt: "never sent" }, {});
    // Publications: a failed or cancelled one drops its media token and ticket after 30 days.
    ins("INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES ('w1',?,'W',1,1)", keep.id);
    ins("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,created_at,updated_at) VALUES ('p1',?,'w1',?,'text','{}',1,1)", keep.id, `${keep.id}:trial`);
    const pub = (id: string, status: string, updated: number) =>
      ins("INSERT INTO publications(id,user_id,workspace_id,post_id,platform,scheduled_at,status,token,ticket,created_at,updated_at) VALUES (?,?,'w1','p1','tiktok',1,?,'tk','{\"publish_id\":\"x\"}',1,?)", id, keep.id, status, updated);
    pub("pub-failed-old", "failed", old(31)); pub("pub-canceled-old", "canceled", old(31)); pub("pub-failed-new", "failed", old(29));
    // Analytics: 13 months.
    ins("INSERT INTO tracked_links(code,workspace_id,platform,created_at) VALUES ('c1','w1','tiktok',1)");
    ins("INSERT INTO link_clicks(code,day,clicks) VALUES ('c1',?,1),('c1',?,1)", Math.floor(t / DAY) - 401, Math.floor(t / DAY) - 399);
    ins("INSERT INTO conversions(id,workspace_id,amount,created_at) VALUES ('cv-old','w1',1,?),('cv-new','w1',1,?)", old(401), old(399));
    // Accounts never confirmed: 30 days (never one with a Stripe customer).
    const unconfirmed = (email: string, created: number, customer: string | null = null) => {
      const id = crypto.randomUUID();
      ins("INSERT INTO users(id,email,name,password_hash,verified,stripe_customer,created_at) VALUES (?,?,'U','x',0,?,?)", id, email, customer, created);
      ins("INSERT INTO terms_acceptances(user_id,version,accepted_at) VALUES (?,'v',?)", id, created);
      return id;
    };
    const stale = unconfirmed("stale@example.com", old(31)), fresh = unconfirmed("fresh@example.com", old(29)), customer = unconfirmed("cust@example.com", old(40), "cus_x");
    sqlite.prepare("UPDATE users SET created_at=? WHERE id=?").run(old(400), keep.id);

    await applyRetention(env, t);

    const ids = (sql: string) => (sqlite.prepare(sql).all() as any[]).map((r) => Object.values(r)[0]);
    expect(ids("SELECT token_hash FROM sessions WHERE token_hash LIKE 's-%'")).toEqual(["s-new"]);
    expect(ids("SELECT token_hash FROM auth_tokens")).toEqual(["a-new"]);
    expect(ids("SELECT key FROM rate_limits")).toEqual(["r-new"]);
    expect(ids("SELECT id FROM contact_messages")).toEqual(["m-new"]);
    expect(ids("SELECT id FROM billing_events")).toEqual(["evt-new"]);
    expect(ids("SELECT intent_id FROM checkout_intents")).toEqual([]);
    expect(ids("SELECT email_hash FROM trial_history ORDER BY email_hash")).toEqual(["h-new", "h-zero"]);
    expect((sqlite.prepare("SELECT updated_at FROM trial_history WHERE email_hash='h-zero'").get() as any).updated_at).toBe(t);
    expect(new Set(ids("SELECT user_id FROM terms_acceptances"))).toEqual(new Set(["gone-new", keep.id, stale, fresh, customer]));
    expect(sqlite.prepare("SELECT account_deleted_at FROM terms_acceptances WHERE user_id=?").get(stale)).toEqual({ account_deleted_at: expect.any(Number) });
    expect(ids("SELECT session_id FROM checkout_consents ORDER BY session_id")).toEqual(["cs-paid", "cs-recent"]);
    expect(ids("SELECT id FROM withdrawals")).toEqual(["w-new"]);
    const runs = Object.fromEntries((sqlite.prepare("SELECT id,payload,provider FROM runs").all() as any[]).map((r) => [r.id, { payload: JSON.parse(r.payload), provider: JSON.parse(r.provider) }]));
    expect(runs["run-old"]).toEqual({ payload: { revision: 2 }, provider: {} });
    expect(runs["run-char"]).toEqual({ payload: { name: "Mia", characterId: "c9", gender: "female" }, provider: {} });
    expect(runs["run-new"]).toEqual({ payload: { prompt: "recent" }, provider: state });
    expect(runs["run-unstarted"]).toEqual({ payload: {}, provider: {} });
    expect(sqlite.prepare("SELECT id,token,ticket FROM publications ORDER BY id").all()).toEqual([
      { id: "pub-canceled-old", token: null, ticket: null }, { id: "pub-failed-new", token: "tk", ticket: '{"publish_id":"x"}' }, { id: "pub-failed-old", token: null, ticket: null },
    ]);
    expect(ids("SELECT day FROM link_clicks")).toEqual([Math.floor(t / DAY) - 399]);
    expect(ids("SELECT id FROM conversions")).toEqual(["cv-new"]);
    expect(new Set(ids("SELECT email FROM users"))).toEqual(new Set(["keep@example.com", "fresh@example.com", "cust@example.com"]));
    expect(ids("SELECT prefix FROM cleanup_tasks")).toEqual([`media/${stale}/`]);
  });

  it("keeps an unconfirmed account with work in progress until it is done", async () => {
    const { env, sqlite } = testEnv();
    const id = crypto.randomUUID();
    sqlite.prepare("INSERT INTO users(id,email,name,password_hash,verified,created_at) VALUES (?,'busy@example.com','U','x',0,?)").run(id, now() - 40 * DAY);
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota,posts_quota) VALUES (?,?,10,10)").run(`${id}:trial`, id);
    sqlite.prepare("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,status,created_at,updated_at) VALUES ('r1',?,?,'k','image','running',?,?)").run(id, `${id}:trial`, now(), now());
    sqlite.prepare("INSERT INTO terms_acceptances(user_id,version,accepted_at) VALUES (?,'v',1)").run(id);
    await applyRetention(env);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM users").get()).toEqual({ n: 1 });
    // The refused delete leaves nothing behind: the evidence was not marked deleted, no files were queued.
    expect(sqlite.prepare("SELECT account_deleted_at FROM terms_acceptances").all()).toEqual([{ account_deleted_at: null }]);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM cleanup_tasks").get()).toEqual({ n: 0 });
  });
});

/* ------------------------------------------------------------------------------------------------ operations */

describe("operations summary", () => {
  function ops() {
    const { env, sqlite } = testEnv({ ADMIN_EMAILS: "Admin@Example.com, ops@example.com, not-an-address" });
    const u = signedIn(sqlite, "admin@example.com");
    sqlite.prepare("INSERT INTO usage_windows(id,user_id,quota,posts_quota) VALUES (?,?,1000,1000)").run(`${u.id}:trial`, u.id);
    let n = 0;
    const run = (status: string, o: { created?: number; updated?: number; error?: string; provider?: object } = {}) => {
      const id = `run-${++n}`;
      sqlite.prepare("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,status,error,provider,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, u.id, `${u.id}:trial`, id, "image", status, o.error ?? null, JSON.stringify(o.provider ?? {}), o.created ?? now(), o.updated ?? now());
      return id;
    };
    return { env, sqlite, u, run };
  }
  const alert = (sqlite: any) => sqlite.prepare("SELECT value FROM operations_state WHERE key='alert'").get();

  it("e-mails every administrator once per change, again after 6 hours, and forgets a resolved state", async () => {
    const { env, sqlite, run } = ops();
    run("running", { created: now() - 4 * HOUR });
    for (const error of ["AVATAR_UNAVAILABLE", "AVATAR_UNAVAILABLE", "AVATAR_FAILED", "GENERATION_FAILED"]) run("failed", { created: now() - 20 * 60, error });
    // Refused prompts are about the content, never an outage.
    for (let i = 0; i < 5; i++) run("failed", { created: now() - 20 * 60, error: "GENERATION_REJECTED" });
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent.map((m: any) => m.to).sort()).toEqual(["admin@example.com", "ops@example.com"]);
    const mail = env.EMAIL.sent[0];
    expect(mail.subject).toBe("Hookstreak: maintenance needs a look");
    expect(mail.text).toContain("AI or render runs still open after 3 hours (maintenance should have ended and refunded them): 1");
    expect(mail.text).toContain("HeyGen (talking creators): 3 failed runs in the last hour (AVATAR_UNAVAILABLE 2, AVATAR_FAILED 1)");
    expect(mail.text).not.toMatch(/fal \(|GENERATION_REJECTED/);
    expect(mail.text).toContain("https://app.test/app/admin?tab=operations");
    expect(console.error).toHaveBeenCalledWith("Maintenance attention", expect.objectContaining({ runsStuck: 1, heygen: 3 }));
    // Unchanged: nothing more within 6 hours.
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent).toHaveLength(2);
    // Something new: at once.
    sqlite.prepare("INSERT INTO manual_reviews(area,ref,request_id,reason,created_at) VALUES ('runs','r9','HeyGen video v9','timeout',?)").run(now());
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent).toHaveLength(4);
    expect(env.EMAIL.sent[2].text).toContain("Work set aside for a manual check");
    // The same state 7 hours later: a reminder.
    sqlite.prepare("UPDATE operations_state SET value=json_set(value,'$.at',?) WHERE key='alert'").run(now() - 7 * HOUR);
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent).toHaveLength(6);
    // Not the hourly minute: no summary at all.
    await maintenance(env, Date.UTC(2026, 9, 9, 12, 18));
    expect(env.EMAIL.sent).toHaveLength(6);
    // Resolved: no mail, and the state is forgotten so a recurrence is news again.
    sqlite.exec("UPDATE runs SET status='completed',updated_at=0,created_at=0; DELETE FROM manual_reviews");
    await maintenance(env, HOURLY);
    expect(env.EMAIL.sent).toHaveLength(6);
    expect(alert(sqlite)).toBeUndefined();
  });

  it("never lets a mail failure or a failing stage stop maintenance; both are reported next hour", async () => {
    const { env, sqlite, run } = ops();
    run("running", { created: now() - 4 * HOUR });
    env.EMAIL.send = async () => { throw new Error("mail down"); };
    sqlite.prepare("INSERT INTO cleanup_tasks(prefix,created_at) VALUES ('media/u/old.jpg',?)").run(now() - 2 * DAY);
    env.MEDIA.list = async () => { throw new Error("R2 down"); };
    sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) SELECT 'expired',id,1 FROM users").run();
    await maintenance(env, HOURLY);
    expect(console.error).toHaveBeenCalledWith("Operator alert not sent", { recipients: 2 });
    expect(console.error).toHaveBeenCalledWith("Maintenance stage failed", expect.objectContaining({ stage: "cleanup" }));
    // Later stages still ran (retention removed the expired session), and the run was recorded.
    expect(sqlite.prepare("SELECT COUNT(*) n FROM sessions WHERE token_hash='expired'").get()).toEqual({ n: 0 });
    expect(alert(sqlite)).toBeUndefined();
    const sent: any[] = [];
    env.EMAIL.send = async (m: any) => { sent.push(m); };
    await maintenance(env, HOURLY);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain("Maintenance stages that failed in the last hour: 1 (cleanup)");
    expect(sent[0].text).toContain("Storage cleanup waiting for more than 1 day: 1");
    const snapshot = await operationsSnapshot(env);
    expect(snapshot.maintenance).toMatchObject({ failed: ["cleanup"] });
    expect(snapshot.stages.map((s) => s.name)).toEqual(["cleanup"]);
  });

  it("sets aside provider work that may still bill and storage cleanup it refuses, and shows them to administrators", async () => {
    const { env, sqlite, run, u } = ops();
    const timedOut = run("failed", { created: now() - 2 * HOUR, error: "AVATAR_TIMEOUT", provider: { claims: { avatar: true }, tickets: { avatar: { video_id: "vid_9" } } } });
    run("failed", { created: now() - 2 * HOUR, error: "GENERATION_TIMEOUT", provider: { claims: { "ai-0": true }, tickets: { "ai-0": { request_id: "req_1" } }, assets: { "ai-0": "a1" } } });
    const lost = run("failed", { created: now() - HOUR, error: "GENERATION_UNCERTAIN", provider: { claims: { "ai-1": true, voice: true } } });
    run("failed", { created: now() - HOUR, error: "VOICE_FAILED", provider: { claims: { voice: true } } });
    await reviewRuns(env);
    expect(sqlite.prepare("SELECT ref,request_id,reason FROM manual_reviews ORDER BY ref").all()).toEqual([
      { ref: timedOut, request_id: "HeyGen video vid_9", reason: "timeout" }, { ref: lost, request_id: null, reason: "uncertain" },
    ]);
    sqlite.prepare("INSERT INTO cleanup_tasks(prefix,created_at) VALUES ('config/everything',1),('media/u/a.jpg',1)").run();
    await env.MEDIA.put("config/everything", "x");
    await env.MEDIA.put("media/u/a.jpg", "x");
    await drainCleanup(env);
    expect(env.MEDIA.objects.has("config/everything")).toBe(true);
    expect(env.MEDIA.objects.has("media/u/a.jpg")).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) n FROM cleanup_tasks").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT reason FROM manual_reviews WHERE area='cleanup' AND ref='config/everything'").get()).toEqual({ reason: "refused" });

    // Accounts ending at scale, failed publishing and post stats, Stripe: counted and grouped.
    sqlite.prepare("INSERT INTO workspaces(id,user_id,name,created_at,updated_at) VALUES ('w1',?,'W',1,1)").run(u.id);
    sqlite.prepare("INSERT INTO posts(id,user_id,workspace_id,window_id,format,spec,created_at,updated_at) VALUES ('p1',?,'w1',?,'text','{}',1,1)").run(u.id, `${u.id}:trial`);
    for (let i = 0; i < 5; i++)
      sqlite.prepare("INSERT INTO social_accounts(id,user_id,workspace_id,platform,external_id,name,credentials,status,created_at,updated_at) VALUES (?,?,'w1','instagram',?,'A','x','expired',1,?)").run(`acc${i}`, u.id, `e${i}`, now() - HOUR);
    for (let i = 0; i < 3; i++)
      sqlite.prepare("INSERT INTO publications(id,user_id,workspace_id,post_id,platform,scheduled_at,status,error,created_at,updated_at) VALUES (?,?,'w1','p1','tiktok',?,'failed',?,1,?)")
        .run(`f${i}`, u.id, now() - HOUR, "TikTok had a problem publishing this post. Try again.", now() - 60);
    sqlite.prepare("INSERT INTO publications(id,user_id,workspace_id,post_id,platform,scheduled_at,status,created_at,updated_at) VALUES ('late',?,'w1','p1','youtube',?,'scheduled',1,1)").run(u.id, now() - HOUR);
    sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end) VALUES ('sub_late',?,'starter','active',1,?),('grant_x',?,'pro','active',1,?)").run(u.id, now() - 5 * DAY, u.id, now() - 5 * DAY);
    sqlite.prepare("INSERT INTO operations_state(key,value,updated_at) VALUES ('stripe',?,1)").run(JSON.stringify({ at: now() - HOUR, checked: 4, updated: 1, failed: 2 }));
    const { counts } = await attention(env);
    expect(counts).toMatchObject({ reconnect: 5, publishFailed: 3, publishOverdue: 1, stripe: 3, review: 3, heygen: 0 });
    const s = await operationsSnapshot(env);
    expect(s.failures).toEqual(expect.arrayContaining([
      { area: "publish:tiktok", code: "TikTok had a problem publishing this post.", count: 3 },
      { area: "heygen", code: "AVATAR_TIMEOUT", count: 1 }, { area: "fal", code: "GENERATION_UNCERTAIN", count: 1 }, { area: "elevenlabs", code: "VOICE_FAILED", count: 1 },
    ]));
    expect(s.accounts).toEqual([{ platform: "instagram", total: 5, recent: 5 }]);
    expect(s.active).toMatchObject({ overdue: 1 });
    expect(s.stripe).toMatchObject({ renewalsOverdue: 1, reconciliation: { failed: 2 } });
    expect(s.reviews.map((r) => r.reason).sort()).toEqual(["refused", "timeout", "uncertain"]);
    const admin = signedIn(sqlite, "ops@example.com");
    const r = await call(worker, { ...env, ADMIN_EMAILS: "ops@example.com" }, "GET", "/api/admin/operations", undefined, admin.cookie);
    expect(r.status).toBe(200);
    expect(r.data.failures.length).toBe(s.failures.length);
  });
});
