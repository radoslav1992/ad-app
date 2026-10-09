import { afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import worker from "../server/index";
import { allowance, mailbox, webhook } from "../server/billing";
import { now } from "../server/types";
import { hashPassword } from "../server/security";
import { call, signedIn, subscribe, testEnv, SITE } from "./helpers";
import { slots, nextFreeSlot, zonedTime } from "../shared/schedule";
import { layoutOverlay, overlayItems, screenText, defaultLook } from "../shared/overlay";

afterEach(() => vi.unstubAllGlobals());

describe("auth", () => {
  it("registers, confirms the email, signs in and out", async () => {
    const { env, sqlite } = testEnv();
    const r = await call(worker, env, "POST", "/api/auth/register", { name: "Ana", email: "Ana@Example.com", password: "a-long-password", acceptTerms: true });
    expect(r.data).toEqual({ ok: true, emailSent: true });
    const mail = env.EMAIL.sent[0];
    expect(mail.to).toBe("ana@example.com");
    const token = String(mail.text).match(/token=([0-9a-f]{64})/)![1];
    expect((await call(worker, env, "POST", "/api/auth/verify", { token })).status).toBe(200);
    expect((await call(worker, env, "POST", "/api/auth/verify", { token })).status).toBe(400);
    const login = await call(worker, env, "POST", "/api/auth/login", { email: "ana@example.com", password: "a-long-password" });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const me = await call(worker, env, "GET", "/api/auth/me", undefined, cookie);
    expect(me.data.user).toMatchObject({ email: "ana@example.com", verified: true, plan: "free", limit: 10, postsLimit: 15, trialEnded: false });
    expect(sqlite.prepare("SELECT version FROM terms_acceptances").get()).toBeTruthy();
    await call(worker, env, "POST", "/api/auth/logout", {}, cookie);
    expect((await call(worker, env, "GET", "/api/auth/me", undefined, cookie)).data.user).toBeNull();
  });
  it("does not reveal whether an address is registered", async () => {
    const { env } = testEnv();
    const body = { name: "Ana", email: "ana@example.com", password: "a-long-password", acceptTerms: true };
    const first = await call(worker, env, "POST", "/api/auth/register", body);
    const second = await call(worker, env, "POST", "/api/auth/register", body);
    expect(second.data).toEqual(first.data);
    expect(env.EMAIL.sent[1].subject).toMatch(/Sign-up attempt/);
  });
  it("refuses wrong passwords and cross-site requests", async () => {
    const { env, sqlite } = testEnv();
    const user = signedIn(sqlite);
    expect((await call(worker, env, "POST", "/api/auth/login", { email: user.email, password: "wrong-password-1" })).status).toBe(401);
    const forged = await worker.fetch(new Request(`${SITE}/api/workspaces`, { method: "POST", headers: { Origin: "https://evil.example", Cookie: user.cookie, "Content-Type": "application/json" }, body: "{}" }), env, { waitUntil() {} } as any);
    expect(forged.status).toBe(403);
    expect((await call(worker, env, "GET", "/api/workspaces")).status).toBe(401);
  });
  it("resets a password and signs out other sessions", async () => {
    const { env, sqlite } = testEnv();
    const user = signedIn(sqlite);
    await call(worker, env, "POST", "/api/auth/forgot", { email: user.email });
    const token = String(env.EMAIL.sent[0].text).match(/token=([0-9a-f]{64})/)![1];
    expect((await call(worker, env, "POST", "/api/auth/reset", { token, password: "another-long-password" })).status).toBe(200);
    expect((await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie)).data.user).toBeNull();
  });
  it("keeps onboarding answers and finishes onboarding", async () => {
    const { env, sqlite } = testEnv();
    const user = signedIn(sqlite);
    await call(worker, env, "PUT", "/api/settings/onboarding", { role: "Founder", teamSize: "Just me" }, user.cookie);
    await call(worker, env, "PUT", "/api/settings/onboarding", { sources: ["Claude", "Reddit"], complete: true }, user.cookie);
    const me = (await call(worker, env, "GET", "/api/auth/me", undefined, user.cookie)).data.user;
    expect(me.onboarding).toMatchObject({ role: "Founder", teamSize: "Just me", sources: ["Claude", "Reddit"] });
    expect(me.onboarding.completedAt).toBeGreaterThan(0);
    expect((await call(worker, env, "PUT", "/api/settings/onboarding", { role: "CEO" }, user.cookie)).status).toBe(400);
  });
  it("deletes an account with its password, files queued for removal", async () => {
    const { env, sqlite } = testEnv();
    const user = signedIn(sqlite);
    sqlite.prepare("UPDATE users SET password_hash=? WHERE id=?").run(await hashPassword("a-long-password"), user.id);
    expect((await call(worker, env, "DELETE", "/api/settings/account", { password: "nope" }, user.cookie)).status).toBe(400);
    expect((await call(worker, env, "DELETE", "/api/settings/account", { password: "a-long-password" }, user.cookie)).status).toBe(200);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE id=?").get(user.id)).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT prefix FROM cleanup_tasks").all()).toEqual([{ prefix: `media/${user.id}/` }]);
  });
});

describe("plans and usage windows", () => {
  it("gives the free trial once per mailbox and a paid window per period", async () => {
    const { env, sqlite } = testEnv();
    const a = signedIn(sqlite, "jo.hn+promo@gmail.com");
    const db = env.DB;
    const user = sqlite.prepare("SELECT * FROM users WHERE id=?").get(a.id) as any;
    expect(await allowance(env, user)).toMatchObject({ plan: "free", used: 0, limit: 10, postsLimit: 15 });
    // Another account of the same Gmail mailbox starts with the trial used up.
    const b = signedIn(sqlite, "john@gmail.com");
    const second = await allowance(env, sqlite.prepare("SELECT * FROM users WHERE id=?").get(b.id) as any);
    expect(second.used).toBe(10);
    expect(second.postsUsed).toBe(15);
    expect(mailbox("J.O.H.N+x@GoogleMail.com")).toBe("john@gmail.com");
    subscribe(sqlite, a.id, "growth");
    const paid = await allowance(env, user);
    expect(paid).toMatchObject({ plan: "growth", limit: 500, postsLimit: 600, used: 0, trialEndsAt: null });
    expect(db).toBeTruthy();
  });
  it("credit and post triggers refuse work beyond the quota", async () => {
    const { env, sqlite } = testEnv();
    const a = signedIn(sqlite);
    await allowance(env, sqlite.prepare("SELECT * FROM users WHERE id=?").get(a.id) as any);
    const window = `${a.id}:trial`;
    expect(() => sqlite.prepare("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,credits,created_at,updated_at) VALUES ('r1',?,?,'k1','image',11,1,1)").run(a.id, window)).toThrow(/QUOTA_EXCEEDED/);
    sqlite.prepare("INSERT INTO runs(id,user_id,window_id,idempotency_key,kind,credits,created_at,updated_at) VALUES ('r2',?,?,'k2','image',4,1,1)").run(a.id, window);
    expect((sqlite.prepare("SELECT used FROM usage_windows WHERE id=?").get(window) as any).used).toBe(4);
    sqlite.prepare("UPDATE runs SET status='failed' WHERE id='r2'").run();
    sqlite.prepare("UPDATE runs SET status='failed' WHERE id='r2'").run();
    expect((sqlite.prepare("SELECT used FROM usage_windows WHERE id=?").get(window) as any).used).toBe(0);
  });
});

describe("Stripe webhook", () => {
  const secret = "whsec_local_test_only";
  const stripe = new Stripe("sk_test_local_only", { httpClient: Stripe.createFetchHttpClient() });
  it("rejects forged signatures and applies a paid subscription read back from Stripe", async () => {
    const { env, sqlite } = testEnv({ STRIPE_SECRET_KEY: "sk_test_local_only", STRIPE_WEBHOOK_SECRET: secret, STRIPE_PRICE_GROWTH: "price_growth" });
    const a = signedIn(sqlite);
    sqlite.prepare("UPDATE users SET stripe_customer='cus_1' WHERE id=?").run(a.id);
    await expect(webhook(new Request("https://x/api/billing/webhook", { method: "POST", headers: { "stripe-signature": "bad" }, body: "{}" }), env)).rejects.toThrow("Invalid signature");
    const sub = {
      id: "sub_1", object: "subscription", customer: "cus_1", status: "active", cancel_at_period_end: false, metadata: {},
      items: { data: [{ id: "si_1", price: { id: "price_growth" }, current_period_start: now() - 10, current_period_end: now() + 30 * 86400 }] },
      latest_invoice: { id: "in_1", status: "paid" },
    };
    vi.stubGlobal("fetch", async () => Response.json(sub));
    const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", object: "event", created: now(), data: { object: sub } });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret });
    await webhook(new Request("https://x/api/billing/webhook", { method: "POST", headers: { "stripe-signature": signature }, body }), env);
    const me = await call(worker, env, "GET", "/api/auth/me", undefined, a.cookie);
    expect(me.data.user).toMatchObject({ plan: "growth", limit: 500, postsLimit: 600, hasSubscription: true });
  });
});

describe("posting schedule", () => {
  it("lists slots in the workspace time zone across DST", () => {
    const from = Date.UTC(2026, 2, 27, 0, 0) / 1000; // Friday before the EU clock change
    const s = slots({ timezone: "Europe/Sofia", times: ["09:00"], days: [0, 1, 2, 3, 4, 5, 6], autoSchedule: false, accounts: [] }, from, 3);
    expect(s.map((t) => new Date(t * 1000).toISOString())).toEqual([
      "2026-03-27T07:00:00.000Z", "2026-03-28T07:00:00.000Z", "2026-03-29T06:00:00.000Z", "2026-03-30T06:00:00.000Z",
    ]);
    expect(zonedTime(2026, 1, 1, 12, 0, "UTC")).toBe(Date.UTC(2026, 0, 1, 12) / 1000);
    const taken = [s[0]];
    expect(nextFreeSlot({ timezone: "Europe/Sofia", times: ["09:00"], days: [0, 1, 2, 3, 4, 5, 6], autoSchedule: false, accounts: [] }, from, taken)).toBe(s[1]);
  });
});

describe("on-screen text", () => {
  it("drops emoji and wraps long text inside the frame", () => {
    expect(screenText("hello 🔥 world\n\n\nnext")).toBe("hello world\nnext");
    const layout = layoutOverlay("a ".repeat(200), defaultLook(), 1080, 1920);
    expect(layout.lines.every((l) => l.width <= 1080 * 0.82)).toBe(true);
    expect(layout.lines.length * layout.lineHeight).toBeLessThanOrEqual(1920 * 0.7 + layout.lineHeight);
    const items = overlayItems("hi there", { ...defaultLook(), background: "#ffffff" }, 1080, 1920);
    expect(items.map((i) => i.kind)).toEqual(["box", "text"]);
  });
});

describe("public address", () => {
  const fetchAt = (env: any, url: string, method = "GET") =>
    worker.fetch(new Request(url, { method, redirect: "manual" }), env, { waitUntil: () => {}, passThroughOnException: () => {} } as any);
  it("sends the other domains to SITE_URL with the same path, keeping the method", async () => {
    const { env } = testEnv();
    for (const host of ["https://www.app.test", "https://app.example"]) {
      const r = await fetchAt(env, `${host}/pricing?plan=growth`);
      expect(r.status).toBe(308);
      expect(r.headers.get("location")).toBe(`${SITE}/pricing?plan=growth`);
    }
    expect((await fetchAt(env, "https://www.app.test/api/billing/webhook", "POST")).status).toBe(308);
  });
  it("leaves the site itself, workers.dev and local development alone", async () => {
    const { env } = testEnv();
    for (const url of [`${SITE}/api/health`, "https://ad-app.someone.workers.dev/api/health", "http://localhost:8787/api/health"])
      expect((await fetchAt(env, url)).status).toBe(200);
  });
});
