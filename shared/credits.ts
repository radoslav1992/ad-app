// What AI work costs in credits. The server charges by these constants and the pricing page shows them, so the
// two cannot drift. Rendering a post (text, slides, music, captions) never costs credits; it counts as one post.

/** One AI image (slide, background, character portrait). */
export const IMAGE_CREDITS = 1;
/** One AI video clip of CLIP_SECONDS (a moving background). */
export const CLIP_CREDITS = 6;
export const CLIP_SECONDS = 5;
/** Voice: one credit per started VOICE_CHARS characters of speech. */
export const VOICE_CHARS = 150;
/** Talking AI creator: credits per started AVATAR_STEP seconds — library characters, and your own from a photo. */
export const AVATAR_STEP = 5;
export const avatarRates = { library: 2, custom: 4 } as const;
export type AvatarKind = keyof typeof avatarRates;
/** Speech to text of a long video (for clips): one credit per started SPEECH_CREDIT_SECONDS of it. */
export const SPEECH_CREDIT_SECONDS = 600;
/** English speech runs at about 15 characters a second; prices are estimated from the script before it is spoken. */
export const SPEECH_CHARS_PER_SECOND = 15;

export const voiceCredits = (text: string) => Math.ceil(text.trim().length / VOICE_CHARS);
export const speechSeconds = (text: string) => Math.max(2, Math.ceil(text.trim().length / SPEECH_CHARS_PER_SECOND));
export const avatarCredits = (seconds: number, kind: AvatarKind) => Math.ceil(seconds / AVATAR_STEP) * avatarRates[kind];
/** A spoken line on a talking character: the voice plus the video it is lip-synced into. */
export const talkingCredits = (text: string, kind: AvatarKind) => voiceCredits(text) + avatarCredits(speechSeconds(text), kind);

/** Transcribing a video of `seconds` (shown before it is charged). */
export const speechCredits = (seconds: number) => Math.max(1, Math.ceil(seconds / SPEECH_CREDIT_SECONDS));

/** "1 credit", "12 credits" */
export const creditsLabel = (n: number) => `${n.toLocaleString("en-US")} credit${n === 1 ? "" : "s"}`;
