import type { Env } from "../types";
import type { PlatformId } from "../../shared/social";

// The common shape of a social network: OAuth connection, token refresh and publishing.

/** OAuth credentials of one connected account; stored sealed (server/crypto.ts), never sent to the browser. */
export type Tokens = {
  accessToken: string;
  refreshToken?: string;
  /** Unix seconds. */
  expiresAt?: number;
  /** Unix seconds; absent when the refresh token does not expire on a schedule. */
  refreshExpiresAt?: number;
  scope?: string;
  extra?: Record<string, string>;
};
export type Profile = { externalId: string; name: string; handle?: string; avatarUrl?: string };

/** Provider state saved between steps (publications.ticket): IDs to resume or poll, never credentials. */
export type Ticket = Record<string, string>;

/** A file the provider uploads from us (`key`/`bytes` in env.MEDIA) or fetches itself (`url`, a capability link). */
export type MediaFile = { key: string; bytes: number; url: string; mime: string };
export type PublishMedia =
  | ({ kind: "video"; duration: number } & MediaFile)
  | { kind: "photos"; items: MediaFile[] };

export type PublishContext = {
  publicationId: string;
  account: { externalId: string; handle: string | null };
  tokens: Tokens;
  /** Caption and hashtags, already cut to the platform's limit. */
  text: string;
  /** The parts of `text`, for platforms that format hashtags themselves (LinkedIn). */
  caption: string;
  hashtags: string[];
  /** The post's tracked link, already in `text` (LinkedIn adds it to its own formatting). */
  link?: string;
  /** A short title (YouTube title, TikTok photo title, LinkedIn video title), at most 100 characters. */
  title: string;
  /** Contains realistic AI-generated people, voices or footage (disclosed where the platform asks). */
  synthetic: boolean;
  media: PublishMedia;
  /**
   * Saves provider state before an irreversible call (and after IDs are known), so a step that is retried or replayed
   * resumes with `status` instead of publishing a second time.
   */
  checkpoint(ticket: Ticket): Promise<void>;
};

export type PublishResult =
  | { state: "published"; externalId: string; url?: string }
  | { state: "processing"; ticket: Ticket }
  | { state: "failed"; code: FailureCode; retryable: boolean; detail?: string };

/** Short, stable failure codes; people see the plain-English message for each (errors.ts). */
export type FailureCode =
  | "AUTH_EXPIRED"
  | "PERMISSION"
  | "RATE_LIMITED"
  | "ACCOUNT_LIMITED"
  | "MEDIA_REJECTED"
  | "NOT_CONFIGURED"
  | "NO_CHANNEL"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "INTERRUPTED"
  | "NOT_READY"
  | "PLAN";

/**
 * Lifetime counts of one published post, as the network reports them; null when it doesn't share that number.
 * `limited`: some counts need a permission the connection lacks (the person reconnects to allow them).
 */
export type PostStats = { views: number | null; likes: number | null; comments: number | null; shares: number | null; /** Instagram only. */ saves?: number | null; limited?: boolean };

export interface Platform {
  id: PlatformId;
  /** The developer app's credentials are set. */
  configured(env: Env): boolean;
  scopes: readonly string[];
  /** Refresh the access token when it has less than this many seconds left. */
  refreshWindow: number;
  authorizeUrl(env: Env, a: { state: string; redirectUri: string; codeVerifier: string }): Promise<string>;
  exchange(env: Env, a: { code: string; redirectUri: string; codeVerifier: string }): Promise<{ tokens: Tokens; profile: Profile }>;
  refresh?(env: Env, tokens: Tokens): Promise<Tokens>;
  /** Starts the post: returns it published, or a ticket to poll with `status`. */
  publish(env: Env, ctx: PublishContext): Promise<PublishResult>;
  status?(env: Env, ctx: PublishContext, ticket: Ticket): Promise<PublishResult>;
  /**
   * Stats of published posts by external ID; posts the network doesn't return (deleted, private) are left out.
   * Throws a SocialError for the account as a whole (PERMISSION: the connection lacks the stats scope).
   */
  stats?(env: Env, tokens: Tokens, ids: string[]): Promise<Map<string, PostStats>>;
}
