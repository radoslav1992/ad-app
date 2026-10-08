import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../server/index";
import { call, signedIn, testEnv } from "./helpers";
import { parseLookIds } from "../shared/creators";

/** A JPEG header declaring width×height (enough for imageInfo). */
function jpeg(width = 600, height = 800) {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, ...new Array(40).fill(0)]);
}
function setup(overrides: Record<string, unknown> = {}) {
  const { env, sqlite } = testEnv({ HEYGEN_API_KEY: "hg", ...overrides });
  const admin = signedIn(sqlite, "admin@example.com"), user = signedIn(sqlite);
  return { env, sqlite, admin, user };
}
let seq = 0;
/** A creator row: library (userId null) unless given an owner. */
function creator(sqlite: any, o: { name?: string; description?: string; gender?: string; userId?: string | null; lookId?: string | null; active?: number; at?: number } = {}) {
  const id = crypto.randomUUID(), n = ++seq;
  sqlite.prepare("INSERT INTO characters(id,user_id,name,description,gender,image_key,mime,look_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, o.userId ?? null, o.name ?? `Creator ${n}`, o.description ?? "", o.gender ?? "", `library/${id}/portrait.jpg`, "image/jpeg", o.lookId ?? null, o.active ?? 1, o.at ?? 1000 + n, 1);
  return id;
}
/** HeyGen's look endpoint and the preview CDN, as the provider documents them; anything else is refused. */
function heygen(looks: Record<string, { status?: number; body?: unknown }>, calls: { url: string; key: string | null }[] = []) {
  vi.stubGlobal("fetch", async (input: string | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, key: new Headers(init.headers).get("x-api-key") });
    const m = /^https:\/\/api\.heygen\.com\/v3\/avatars\/looks\/([^/?]+)$/.exec(url);
    if (m) {
      const look = looks[m[1]];
      if (!look) return Response.json({ error: { code: "not_found" } }, { status: 404 });
      return Response.json(look.body ?? {}, { status: look.status ?? 200 });
    }
    if (url.startsWith("https://files.heygen.ai/")) return new Response(jpeg(), { headers: { "Content-Type": "image/jpeg" } });
    throw new TypeError(`unexpected fetch ${url}`);
  });
  return calls;
}
const look = (id: string, engines = ["avatar_iii", "avatar_iv"], name = `Look ${id}`) =>
  ({ body: { data: { id, name, supported_api_engines: engines, preview_image_url: `https://files.heygen.ai/${id}.jpg` } } });
afterEach(() => vi.unstubAllGlobals());

describe("look ID parsing", () => {
  it("splits on lines, commas and spaces, strips quotes and keeps each ID once", () => {
    expect(parseLookIds(' look_a\n"look_b", look_c;look_a\r\n\tlook-d  ,, ')).toEqual({ ids: ["look_a", "look_b", "look_c", "look-d"], repeated: 1 });
    expect(parseLookIds(" \n , ")).toEqual({ ids: [], repeated: 0 });
  });
});

describe("bulk import of HeyGen looks", () => {
  it("imports good looks and reports duplicates, unusable looks and provider errors per ID", async () => {
    const { env, sqlite, admin } = setup();
    const existing = creator(sqlite, { name: "Already here", lookId: "look_dup" });
    const calls = heygen({
      look_good: look("look_good", ["avatar_iii", "avatar_iv"], "Anna in a blue shirt that has a very long name"),
      look_two: look("look_two"),
      look_old: look("look_old", ["avatar_iv"]),
      look_nopreview: { body: { data: { id: "look_nopreview", name: "X", supported_api_engines: ["avatar_iii"] } } },
      look_busy: { status: 429, body: { error: { message: "rate limited" } } },
      look_other: { body: { data: { id: "someone_else", supported_api_engines: ["avatar_iii"] } } },
    });
    const r = await call(worker, env, "POST", "/api/admin/characters/import/bulk", {
      lookIds: "look_good\nlook_dup, look_old\nlook_missing look_nopreview\nbad/id\nlook_busy\nlook_two\nlook_good\nlook_other", gender: "female",
    }, admin.cookie);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.data.results.map((x: any) => [x.lookId, x]));
    // One result per distinct ID, in the order pasted.
    expect(r.data.results.map((x: any) => x.lookId)).toEqual(["look_good", "look_dup", "look_old", "look_missing", "look_nopreview", "bad/id", "look_busy", "look_two", "look_other"]);
    expect(by.look_good).toMatchObject({ status: "imported", name: "Anna in a blue shirt that has a very lon" });
    expect(by.look_two.status).toBe("imported");
    expect(by.look_dup).toMatchObject({ status: "exists", id: existing, name: "Already here" });
    expect(by.look_old).toMatchObject({ status: "unusable", error: expect.stringMatching(/Avatar III/) });
    expect(by.look_missing).toMatchObject({ status: "unusable", error: expect.stringMatching(/no look with this ID/) });
    expect(by.look_nopreview).toMatchObject({ status: "unusable", error: expect.stringMatching(/no preview/) });
    expect(by["bad/id"]).toMatchObject({ status: "unusable", error: expect.stringMatching(/isn't a HeyGen look ID/) });
    expect(by.look_busy).toMatchObject({ status: "failed", error: expect.stringMatching(/Try again/) });
    expect(by.look_other.status).toBe("failed");
    expect(r.data).toMatchObject({ imported: 2, exists: 1, unusable: 4, failed: 2 });
    // Provider text is never passed on.
    expect(JSON.stringify(r.data)).not.toContain("rate limited");

    const row = sqlite.prepare("SELECT * FROM characters WHERE id=?").get(by.look_good.id) as any;
    expect(row).toMatchObject({ user_id: null, look_id: "look_good", gender: "female", mime: "image/jpeg", active: 1 });
    expect(JSON.parse(row.engines)).toEqual(["avatar_iii", "avatar_iv"]);
    expect(env.MEDIA.objects.has(row.image_key)).toBe(true);
    // Only the two imported portraits were stored; nothing is left behind for the failures.
    expect([...env.MEDIA.objects.keys()].filter((k: string) => k.startsWith("library/"))).toHaveLength(2);
    // The duplicate and the malformed ID never reached HeyGen; every HeyGen call carried the key.
    const lookCalls = calls.filter((c) => c.url.startsWith("https://api.heygen.com/"));
    expect(lookCalls.map((c) => c.url.split("/").pop()).sort()).toEqual(["look_busy", "look_good", "look_missing", "look_nopreview", "look_old", "look_other", "look_two"]);
    expect(lookCalls.every((c) => c.key === "hg")).toBe(true);

    // Importing again finds them all in the library.
    const again = await call(worker, env, "POST", "/api/admin/characters/import/bulk", { lookIds: ["look_good", "look_two"] }, admin.cookie);
    expect(again.data).toMatchObject({ imported: 0, exists: 2 });
  });
  it("needs HeyGen, at least one ID and at most a request's worth", async () => {
    const { env, admin } = setup({ HEYGEN_API_KEY: "" });
    expect((await call(worker, env, "POST", "/api/admin/characters/import/bulk", { lookIds: "look_a" }, admin.cookie)).status).toBe(503);
    env.HEYGEN_API_KEY = "hg";
    expect((await call(worker, env, "POST", "/api/admin/characters/import/bulk", { lookIds: " ,\n" }, admin.cookie)).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `look_${i}`).join("\n");
    const r = await call(worker, env, "POST", "/api/admin/characters/import/bulk", { lookIds: many }, admin.cookie);
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/up to 50/);
  });
  it("the single import refuses a look already in the library and explains provider failures", async () => {
    const { env, sqlite, admin } = setup();
    creator(sqlite, { name: "Mia", lookId: "look_dup" });
    heygen({ look_busy: { status: 429 } });
    const dup = await call(worker, env, "POST", "/api/admin/characters/import", { lookId: "look_dup" }, admin.cookie);
    expect(dup.status).toBe(409);
    expect(dup.data.error).toMatch(/already in the library as Mia/);
    const missing = await call(worker, env, "POST", "/api/admin/characters/import", { lookId: "look_missing" }, admin.cookie);
    expect(missing.status).toBe(400);
    expect(missing.data.error).toMatch(/no look with this ID/);
    expect((await call(worker, env, "POST", "/api/admin/characters/import", { lookId: "look_busy" }, admin.cookie)).status).toBe(502);
  });
});

describe("admin-only creator management", () => {
  it("hides every admin creator route from other people", async () => {
    const { env, sqlite, user } = setup();
    const id = creator(sqlite);
    const calls = heygen({});
    for (const [method, path, body] of [
      ["GET", "/api/admin/characters", undefined], ["POST", "/api/admin/characters/import/bulk", { lookIds: "look_a" }],
      ["POST", "/api/admin/characters/import", { lookId: "look_a" }], ["POST", "/api/admin/characters/bulk", { ids: [id], active: false }],
      ["PATCH", `/api/admin/characters/${id}`, { gender: "male" }],
    ] as const) {
      expect((await call(worker, env, method, path, body, user.cookie)).status).toBe(404);
      expect((await call(worker, env, method, path, body)).status).toBe(401);
    }
    expect(calls).toHaveLength(0);
    expect(sqlite.prepare("SELECT active,gender FROM characters WHERE id=?").get(id)).toEqual({ active: 1, gender: "" });
  });
  it("lists the library with search, filters, pages and a total", async () => {
    const { env, sqlite, admin, user } = setup();
    for (let i = 0; i < 70; i++) creator(sqlite, { name: `Lib ${i}`, gender: i % 2 ? "male" : "female", lookId: i % 5 ? `look_${i}` : null, active: i % 7 ? 1 : 0, description: i === 3 ? "Barista in a 100% cotton apron" : "" });
    creator(sqlite, { userId: user.id, name: "Mine" });
    const pages: any[] = [];
    let next: string | null = null;
    do {
      const r: any = await call(worker, env, "GET", `/api/admin/characters?limit=30${next ? `&cursor=${encodeURIComponent(next)}` : ""}`, undefined, admin.cookie);
      expect(r.status).toBe(200);
      if (!next) expect(r.data.total).toBe(70);
      pages.push(...r.data.characters);
      next = r.data.next;
    } while (next);
    expect(pages).toHaveLength(70);
    expect(new Set(pages.map((c) => c.id)).size).toBe(70);
    expect(pages[0].name).toBe("Lib 69");
    expect(pages.some((c) => c.name === "Mine")).toBe(false);
    const q = (s: string) => call(worker, env, "GET", `/api/admin/characters?${s}`, undefined, admin.cookie);
    expect((await q("q=cotton%20barista")).data.characters.map((c: any) => c.name)).toEqual(["Lib 3"]);
    // LIKE wildcards are plain text.
    expect((await q("q=100%25")).data.total).toBe(1);
    expect((await q("q=_")).data.total).toBe(0);
    expect((await q("status=off")).data.total).toBe(10);
    expect((await q("kind=portrait")).data.total).toBe(14);
    expect((await q("gender=male&status=active")).data.characters.every((c: any) => c.gender === "male" && c.active === 1)).toBe(true);
    expect((await q("cursor=nonsense")).status).toBe(400);
  });
  it("switches many creators on or off and sets their gender in one request", async () => {
    const { env, sqlite, admin, user } = setup();
    const ids = [creator(sqlite), creator(sqlite), creator(sqlite)];
    const theirs = creator(sqlite, { userId: user.id });
    const off = await call(worker, env, "POST", "/api/admin/characters/bulk", { ids: [...ids.slice(0, 2), theirs, "missing"], active: false, gender: "female" }, admin.cookie);
    expect(off.data.updated).toBe(2);
    const rows = sqlite.prepare("SELECT id,active,gender FROM characters ORDER BY created_at").all() as any[];
    expect(rows.map((r) => [r.active, r.gender])).toEqual([[0, "female"], [0, "female"], [1, ""], [1, ""]]);
    expect((await call(worker, env, "POST", "/api/admin/characters/bulk", { ids }, admin.cookie)).status).toBe(400);
    // Switched-off creators leave the people's lists.
    expect((await call(worker, env, "GET", "/api/characters", undefined, user.cookie)).data.characters.map((c: any) => c.id).sort()).toEqual([ids[2], theirs].sort());
  });
  it("edits a library creator's gender and unlinks a look", async () => {
    const { env, sqlite, admin } = setup();
    const id = creator(sqlite, { lookId: "look_a", gender: "female" });
    sqlite.prepare("UPDATE characters SET engines='[\"avatar_iii\"]' WHERE id=?").run(id);
    const r = await call(worker, env, "PATCH", `/api/admin/characters/${id}`, { gender: "male", lookId: null }, admin.cookie);
    expect(r.status).toBe(200);
    expect(r.data.character).toMatchObject({ id, gender: "male", look_id: null, engines: "[]" });
    expect((await call(worker, env, "PATCH", `/api/admin/characters/${id}`, { gender: "" }, admin.cookie)).data.character.gender).toBe("");
    expect((await call(worker, env, "PATCH", "/api/admin/characters/missing", { gender: "male" }, admin.cookie)).status).toBe(404);
    // A look links to one library creator only.
    const other = creator(sqlite, { lookId: "look_b" });
    const clash = await call(worker, env, "PATCH", `/api/admin/characters/${id}`, { lookId: "look_b" }, admin.cookie);
    expect(clash.status).toBe(409);
    expect(sqlite.prepare("SELECT look_id FROM characters WHERE id=?").get(other)).toEqual({ look_id: "look_b" });
  });
});

describe("choosing among many creators", () => {
  function library(sqlite: any, userId: string, otherId: string) {
    const ids: { id: string; at: number }[] = [];
    // Pairs share a creation time, so the ID decides between them.
    for (let i = 0; i < 130; i++) {
      const at = 2000 + Math.floor(i / 2);
      ids.push({ id: creator(sqlite, { name: `Library ${i}`, gender: i % 3 === 0 ? "male" : "female", description: i % 10 === 0 ? "Works in an office" : "Outdoors", lookId: `look_${i}`, at }), at });
    }
    const own = [creator(sqlite, { userId, name: "Me", gender: "male", at: 100 }), creator(sqlite, { userId, name: "Office me", at: 50 })];
    creator(sqlite, { userId: otherId, name: "Someone else's" });
    creator(sqlite, { name: "Switched off", active: 0 });
    return { ids, own };
  }
  it("pages through every visible creator once, own first, in a stable order", async () => {
    const { env, sqlite, user, admin } = setup();
    const { ids, own } = library(sqlite, user.id, admin.id);
    const seen: any[] = [];
    let next: string | null = null, first: any = null;
    do {
      const r: any = await call(worker, env, "GET", `/api/characters?limit=48${next ? `&cursor=${encodeURIComponent(next)}` : ""}`, undefined, user.cookie);
      expect(r.status).toBe(200);
      first ??= r.data;
      if (next) expect(r.data.counts).toBeUndefined();
      seen.push(...r.data.characters);
      next = r.data.next;
      // A creator added meanwhile (newest, so before the cursor) never shifts the pages.
      if (seen.length === 48) creator(sqlite, { name: "Added later", at: 99999 });
    } while (next);
    expect(first.counts).toEqual({ library: 130, own: 2 });
    expect(first.making).toEqual([]);
    const newest = [...ids].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).map((x) => x.id);
    expect(seen.map((c) => c.id)).toEqual([...own, ...newest]);
    expect(seen[0]).toEqual({ id: own[0], name: "Me", description: "", gender: "male", own: true, premium: true, image: `/api/characters/${own[0]}/image?v=1` });
    expect(seen[2]).toMatchObject({ own: false, premium: false });
    // Without a limit: the writer's 60, so the first page and the post writer agree.
    const plain = await call(worker, env, "GET", "/api/characters", undefined, user.cookie);
    expect(plain.data.characters).toHaveLength(60);
  });
  it("searches names and descriptions, filters by gender and source, and counts the matches", async () => {
    const { env, sqlite, user, admin } = setup();
    library(sqlite, user.id, admin.id);
    const get = async (s: string) => (await call(worker, env, "GET", `/api/characters?${s}`, undefined, user.cookie)).data;
    const office = await get("q=OFFICE");
    expect(office.counts).toEqual({ library: 13, own: 1 });
    expect(office.characters.map((c: any) => c.name).slice(0, 2)).toEqual(["Office me", "Library 120"]);
    expect((await get("q=office&source=library&limit=5")).characters).toHaveLength(5);
    expect((await get("q=office&source=own")).characters.map((c: any) => c.name)).toEqual(["Office me"]);
    const men = await get("gender=male&limit=100");
    expect(men.counts).toEqual({ library: 44, own: 1 });
    expect(men.characters.every((c: any) => c.gender === "male")).toBe(true);
    expect((await get("q=works%20office%20library%2010")).characters.map((c: any) => c.name)).toEqual(["Library 110", "Library 100", "Library 10"]);
    const none = await get("q=nobody%20here");
    expect(none).toMatchObject({ characters: [], next: null, counts: { library: 0, own: 0 } });
    expect((await get("q=Someone")).characters).toEqual([]);
    expect((await get("q=Switched")).characters).toEqual([]);
    expect((await call(worker, env, "GET", "/api/characters?limit=500", undefined, user.cookie)).status).toBe(400);
  });
  it("returns one creator the person may use", async () => {
    const { env, sqlite, user, admin } = setup();
    const lib = creator(sqlite, { name: "Lib" }), mine = creator(sqlite, { userId: user.id, name: "Mine" });
    const theirs = creator(sqlite, { userId: admin.id }), off = creator(sqlite, { active: 0 });
    expect((await call(worker, env, "GET", `/api/characters/${lib}`, undefined, user.cookie)).data.character).toMatchObject({ id: lib, own: false });
    expect((await call(worker, env, "GET", `/api/characters/${mine}`, undefined, user.cookie)).data.character).toMatchObject({ id: mine, own: true });
    for (const id of [theirs, off, "missing"]) expect((await call(worker, env, "GET", `/api/characters/${id}`, undefined, user.cookie)).status).toBe(404);
  });
  it("lets people change their own creator's gender, not a library one", async () => {
    const { env, sqlite, user } = setup();
    const mine = creator(sqlite, { userId: user.id, gender: "female" }), lib = creator(sqlite);
    expect((await call(worker, env, "PATCH", `/api/characters/${mine}`, { gender: "male" }, user.cookie)).status).toBe(200);
    expect((await call(worker, env, "PATCH", `/api/characters/${mine}`, { name: "Renamed" }, user.cookie)).status).toBe(200);
    expect(sqlite.prepare("SELECT name,gender FROM characters WHERE id=?").get(mine)).toEqual({ name: "Renamed", gender: "male" });
    expect((await call(worker, env, "PATCH", `/api/characters/${mine}`, { gender: "other" }, user.cookie)).status).toBe(400);
    expect((await call(worker, env, "PATCH", `/api/characters/${lib}`, { gender: "male" }, user.cookie)).status).toBe(404);
  });
});
