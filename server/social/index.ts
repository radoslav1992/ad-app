import { isPlatform, type PlatformId } from "../../shared/social";
import type { Platform } from "./types";
import { tiktok } from "./tiktok";
import { instagram } from "./instagram";
import { youtube } from "./youtube";
import { linkedin } from "./linkedin";

/** Every network we connect to and publish on. */
export const socialPlatforms: Record<PlatformId, Platform> = { tiktok, instagram, youtube, linkedin };

export function platformFor(id: string): Platform {
  if (!isPlatform(id)) throw new Error("Unknown platform");
  return socialPlatforms[id];
}

export type { Platform, PublishContext, PublishMedia, PublishResult, MediaFile, Profile, Ticket, Tokens, FailureCode } from "./types";
export { SocialError, failureMessage, nothingPosted } from "./errors";
