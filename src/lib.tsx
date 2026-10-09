import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { PlanId } from "../shared/plans";
import type { Onboarding } from "../shared/onboarding";
import type { Profile } from "../shared/profile";
import type { WorkspaceSettings } from "../shared/schedule";
import type { PostFormatId, Spec } from "../shared/formats";
import type { SpeechStatus } from "../shared/speech";

// The app's API client, signed-in state and shared types. Every request goes to /api on this site.

export type User = {
  id: string; name: string; email: string; verified: boolean; admin: boolean; onboarding: Onboarding;
  plan: PlanId; used: number; limit: number; postsUsed: number; postsLimit: number;
  trialEndsAt: number | null; trialEnded: boolean; periodEnd: number | null; hasSubscription: boolean; paymentIssue: boolean;
  /** The plan is an administrator's free month (until periodEnd), not a paid subscription. */
  granted?: boolean;
};
export type Workspace = {
  id: string; name: string; website: string | null; description: string | null; logoAssetId: string | null;
  profile: Profile; settings: WorkspaceSettings; ready?: number; images?: { id: string; kind: string; name: string; width: number; height: number }[];
  scan: { status: "idle" | "scanning" | "ready" | "failed"; step: string | null; error: string | null; at: number | null };
};
export type Post = {
  id: string; workspaceId: string; format: PostFormatId; status: "pending" | "approved" | "rejected";
  renderStatus: "queued" | "running" | "ready" | "failed"; renderError: string | null; phase: string | null;
  hook: string; caption: string; title: string; hashtags: string[]; topic: string; why: string; pattern: string | null;
  duration: number; videoAssetId: string | null; coverAssetId: string | null; slides: string[]; revision: number;
  createdAt: number; updatedAt: number; reviewedAt: number | null; spec?: Spec;
};
export type Asset = {
  id: string; kind: string; name: string; mime: string; bytes: number; duration: number; width: number; height: number;
  status: "uploading" | "checking" | "ready" | "failed"; workspaceId: string | null; hasAudio: boolean | null; error: string | null; createdAt: number; url: string;
  /** Speech found in an own video or track (null: never looked for), and the language it was heard in. */
  speech?: SpeechStatus | null; speechLanguage?: string | null;
};
export type LibraryItem = { id: string; kind: "music" | "clip" | "greenscreen"; name: string; tags: string[]; duration: number; width: number; height: number; url: string; thumb: string | null };
export type Character = { id: string; name: string; description: string; gender: string; own: boolean; premium: boolean; image: string };

const NETWORK_ERROR = "We can't reach the server. Check your connection and try again.";
export class ApiError extends Error {
  constructor(message: string, public status: number, public data: any) {
    super(message);
  }
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch("/api" + path, {
      ...options,
      headers: { ...(options.body && typeof options.body === "string" ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
  } catch (e) {
    if (options.signal?.aborted || (e as Error)?.name === "AbortError") throw e;
    // Still a TypeError, which callers read as "the request may not have arrived" (they keep the idempotency key).
    throw new TypeError(NETWORK_ERROR);
  }
  const data: any = await r.json().catch(() => ({ error: "Unexpected answer from the server. Please try again." }));
  if (!r.ok) throw new ApiError(data.error || "Something went wrong. Please try again.", r.status, data);
  return data as T;
}
export const post = <T = any,>(path: string, data: unknown = {}) => api<T>(path, { method: "POST", body: JSON.stringify(data) });
export const put = <T = any,>(path: string, data: unknown = {}) => api<T>(path, { method: "PUT", body: JSON.stringify(data) });
export const patch = <T = any,>(path: string, data: unknown = {}) => api<T>(path, { method: "PATCH", body: JSON.stringify(data) });
export const del = <T = any,>(path: string, data?: unknown) => api<T>(path, { method: "DELETE", ...(data !== undefined && { body: JSON.stringify(data) }) });
export const errorText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");
export const fileUrl = (assetId: string | null | undefined) => (assetId ? `/api/media/${assetId}/file` : "");

/** Uploads a file in the server's 8 MiB parts and returns the asset once it is ready (or failed its check). */
export async function uploadFile(file: File, workspaceId?: string, onProgress?: (share: number) => void): Promise<Asset> {
  const mime = file.type || (file.name.endsWith(".mov") ? "video/quicktime" : "");
  const start = await post<{ id: string; partSize: number; parts: number }>("/media/uploads", { name: file.name.slice(0, 160), mime, bytes: file.size, workspaceId });
  for (let n = 1; n <= start.parts; n++) {
    const chunk = file.slice((n - 1) * start.partSize, Math.min(file.size, n * start.partSize));
    await api(`/media/uploads/${start.id}/parts/${n}`, { method: "PUT", body: chunk, headers: { "Content-Type": "application/octet-stream" } });
    onProgress?.(n / start.parts);
  }
  let { asset } = await post<{ asset: Asset }>(`/media/uploads/${start.id}/complete`);
  // Videos and tracks are checked by the server; wait for the result (usually a few seconds).
  for (let i = 0; i < 90 && asset.status === "checking"; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    asset = (await api<{ asset: Asset }>(`/media/${asset.id}`)).asset;
  }
  return asset;
}

export const AuthContext = createContext<{ user: User | null; loading: boolean; failed?: boolean; refresh: () => Promise<void> }>({
  user: null, loading: true, refresh: async () => {},
});
export const useAuth = () => useContext(AuthContext);

/** Runs `fn` every `ms` while `active` (and once at start), stopping when the component unmounts. */
export function usePoll(fn: () => unknown, ms: number, active = true) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}
/** Loads `path` (re-loading when it changes); `reload` fetches again. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(!!path);
    void reload();
  }, [reload, path]);
  return { data, error, loading, reload, setData };
}
export const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
export const seconds = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
export const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
/** "6d 23h left" */
export function timeLeft(until: number) {
  const s = Math.max(0, until - Date.now() / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h left` : h ? `${h}h ${m}m left` : `${m}m left`;
}
export const newKey = () => crypto.randomUUID();
