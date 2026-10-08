import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";

// Social OAuth credentials are stored encrypted (AES-256-GCM) with TOKEN_ENCRYPTION_KEY, 32 random bytes in base64.
// A sealed value is "v1.<iv>.<ciphertext>" (base64url); the version leaves room to rotate the key later.

const NOT_SET_UP = "Social publishing is not set up yet.";
const VERSION = "v1";
const keys = new Map<string, Promise<CryptoKey>>();

export function b64url(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromB64(text: string) {
  const s = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s.padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function keyBytes(env: Env) {
  const raw = env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  try {
    const bytes = fromB64(raw);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}
/** Whether TOKEN_ENCRYPTION_KEY holds a usable key (32 bytes, base64). */
export const encryptionReady = (env: Env) => keyBytes(env) !== null;

function key(env: Env) {
  const bytes = keyBytes(env);
  if (!bytes) throw new HTTPException(503, { message: NOT_SET_UP });
  const id = env.TOKEN_ENCRYPTION_KEY!.trim();
  let k = keys.get(id);
  if (!k) {
    k = crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    keys.set(id, k);
  }
  return k;
}

/** Encrypts a JSON-serialisable value. */
export async function seal(env: Env, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), data));
  return `${VERSION}.${b64url(iv)}.${b64url(cipher)}`;
}

/** Decrypts a value made by `seal`; throws if it was changed, damaged or sealed with another key. */
export async function open<T>(env: Env, sealed: string): Promise<T> {
  const k = await key(env);
  const [version, iv, cipher, extra] = String(sealed).split(".");
  if (version !== VERSION || !iv || !cipher || extra !== undefined) throw new Error("Sealed value is not readable");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, k, fromB64(cipher));
  } catch {
    throw new Error("Sealed value is not readable");
  }
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
