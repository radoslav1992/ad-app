import type { Env } from "./types";
import { now } from "./types";

// Small JSON records maintenance keeps in D1 (operations_state): the last hourly run, failed stages, the last operator
// alert and the last Stripe reconciliation. A missing or unreadable record reads as null.
export async function readState<T>(e: Env, key: string): Promise<T | null> {
  const row = await e.DB.prepare("SELECT value FROM operations_state WHERE key=?").bind(key).first<{ value: string }>();
  try { return row ? (JSON.parse(row.value) as T) : null; } catch { return null; }
}
export async function writeState(e: Env, key: string, value: unknown) {
  await e.DB.prepare("INSERT INTO operations_state(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .bind(key, JSON.stringify(value), now()).run();
}
