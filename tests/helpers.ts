import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";

const hex = (n: number) => Array.from(randomBytes(n), (b) => b.toString(16).padStart(2, "0")).join("");

/** A D1 stand-in over node:sqlite with every migration applied (triggers included). */
export function database() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort())
    sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  const prepare = (sql: string, args: unknown[] = []): any => ({
    bind: (...v: unknown[]) => prepare(sql, v),
    first: async (column?: string) => {
      const row: any = sqlite.prepare(sql).get(...(args as any[])) || null;
      return column && row ? row[column] : row;
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as any[])) }),
    run: async () => {
      const r = sqlite.prepare(sql).run(...(args as any[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  const db: any = {
    prepare,
    batch: async (q: any[]) => {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const s of q) result.push(await s.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { sqlite, db };
}

/** An R2 stand-in: put/get (with ranges)/head/delete/list and multipart uploads. */
export function bucket() {
  const objects = new Map<string, { bytes: Uint8Array; metadata: any; httpMetadata: any }>();
  const object = (key: string, o: { bytes: Uint8Array; metadata: any; httpMetadata: any }, bytes = o.bytes) => ({
    key,
    body: new Blob([bytes as BlobPart]).stream(),
    size: o.bytes.length,
    customMetadata: o.metadata,
    httpMetadata: o.httpMetadata || {},
    httpEtag: `"${key.length}-${o.bytes.length}"`,
    writeHttpMetadata: (h: Headers) => { if (o.httpMetadata?.contentType) h.set("Content-Type", o.httpMetadata.contentType); },
    arrayBuffer: async () => bytes.slice().buffer,
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  });
  return {
    objects,
    createMultipartUpload: async (key: string, opts: any = {}) => {
      const parts = new Map<number, Uint8Array>();
      return {
        uploadId: "upload-" + key,
        uploadPart: async (partNumber: number, bytes: any) => {
          parts.set(partNumber, new Uint8Array(bytes instanceof Uint8Array ? bytes : await new Response(bytes).arrayBuffer()).slice());
          return { partNumber, etag: String(partNumber) };
        },
        complete: async (ordered: { partNumber: number }[]) => {
          const size = ordered.reduce((n, p) => n + parts.get(p.partNumber)!.length, 0);
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const p of ordered) { const data = parts.get(p.partNumber)!; bytes.set(data, offset); offset += data.length; }
          objects.set(key, { bytes, metadata: opts.customMetadata, httpMetadata: opts.httpMetadata });
        },
        abort: async () => { parts.clear(); },
      };
    },
    resumeMultipartUpload: (key: string, uploadId: string) => ({ key, uploadId, abort: async () => {} }),
    put: async (key: string, input: any, opts: any = {}) => {
      const bytes = input instanceof Uint8Array ? input : typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(await new Response(input).arrayBuffer());
      objects.set(key, { bytes, metadata: opts.customMetadata, httpMetadata: opts.httpMetadata });
      return { key, size: bytes.length };
    },
    get: async (key: string, opts: any = {}) => {
      const o = objects.get(key);
      if (!o) return null;
      const r = opts.range;
      const bytes = r ? o.bytes.slice(r.offset ?? 0, r.length !== undefined ? (r.offset ?? 0) + r.length : undefined) : o.bytes;
      return object(key, o, bytes);
    },
    head: async (key: string) => {
      const o = objects.get(key);
      return o ? { key, size: o.bytes.length, customMetadata: o.metadata, httpMetadata: o.httpMetadata || {} } : null;
    },
    delete: async (keys: string | string[]) => {
      for (const k of [keys].flat()) objects.delete(k);
    },
    list: async ({ prefix = "", cursor }: { prefix?: string; cursor?: string } = {}) => {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0, page = keys.slice(start, start + 1000);
      const truncated = start + 1000 < keys.length;
      return { objects: page.map((key) => ({ key, size: objects.get(key)!.bytes.length })), truncated, cursor: truncated ? String(start + 1000) : undefined };
    },
  };
}

/** A Workflow binding stand-in that records created instances. */
export function workflow() {
  const created: { id?: string; params: any }[] = [];
  return {
    created,
    create: async (opts: { id?: string; params: any }) => { created.push(opts); return { id: opts.id || crypto.randomUUID() }; },
    get: async (id: string) => ({ id, status: async () => ({ status: "running" }), terminate: async () => {} }),
  };
}

export const SITE = "https://app.test";
/** An environment with local bindings; override anything per test. */
export function testEnv(overrides: Record<string, unknown> = {}) {
  const { db, sqlite } = database();
  const env: any = {
    DB: db,
    MEDIA: bucket(),
    AI: { run: async () => { throw new Error("AI not mocked"); } },
    ASSETS: { fetch: async () => new Response("<!doctype html><title>app</title>", { headers: { "Content-Type": "text/html" } }) },
    CONTENT: workflow(),
    SCAN: workflow(),
    PUBLISH: workflow(),
    EMAIL: { sent: [] as any[], send: async (m: any) => { env.EMAIL.sent.push(m); } },
    SITE_URL: SITE,
    APP_ENV: "development",
    REGISTRATION_ENABLED: "true",
    COMPANY_NAME: "Test Co",
    CONTACT_EMAIL: "hello@app.test",
    EMAIL_FROM: "hello@app.test",
    ADMIN_EMAILS: "admin@example.com",
    TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...randomBytes(32))),
    ...overrides,
  };
  return { env, sqlite };
}

/** Creates a verified user with a session; returns the user ID and the cookie header to send. */
export function signedIn(sqlite: DatabaseSync, email = `user-${hex(4)}@example.com`) {
  const id = crypto.randomUUID(), token = hex(32);
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO users(id,email,name,password_hash,verified,created_at) VALUES (?,?,?,?,1,?)").run(id, email, "Test User", "x", now);
  sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)")
    .run(createHash("sha256").update(token).digest("hex"), id, now + 86400);
  return { id, email, cookie: `pl_session=${token}` };
}
/** Gives a user an active paid subscription of `plan` (period from now for 30 days). */
export function subscribe(sqlite: DatabaseSync, userId: string, plan: "starter" | "growth" | "pro") {
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO subscriptions(id,user_id,plan,status,period_start,period_end) VALUES (?,?,?,?,?,?)")
    .run(`sub_${hex(6)}`, userId, plan, "active", now - 60, now + 30 * 86400);
}

/** Calls the Worker like a browser on the site: JSON body, same-origin header, optional session cookie. */
export async function call(worker: { fetch: (r: Request, env: any, ctx: any) => Promise<Response> | Response }, env: any, method: string, path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { Origin: SITE };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(
    new Request(SITE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {} },
  );
  await Promise.all(waits);
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, headers: res.headers };
}
