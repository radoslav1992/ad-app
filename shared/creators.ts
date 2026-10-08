// Creators at scale: the list filters and page sizes the client and server agree on, and look-ID parsing for the
// admins' bulk import from HeyGen.

export const creatorGenders = ["female", "male"] as const;
export type CreatorGender = "" | (typeof creatorGenders)[number];
/** Whose creators to list: everyone's shared library, the person's own, or both. */
export type CreatorSource = "all" | "library" | "own";
/** The first page without a `limit` matches what the post writer sees (its 60 newest, own first). */
export const CREATOR_PAGE = 60;
export const CREATOR_PAGE_MAX = 100;

/** A HeyGen look ID as the API returns it (the same check the provider applies before any request). */
export const LOOK_ID = /^[a-zA-Z0-9_-]{1,160}$/;
/**
 * Look IDs per bulk-import request. Each look costs up to ~9 subrequests (HeyGen, the preview download and its
 * redirects, the R2 upload, D1) and a Worker request may make 1,000, so this leaves room to spare.
 */
export const BULK_LOOKS = 50;
/** Look IDs one paste may hold; the admin page sends them in small requests to show progress. */
export const BULK_PASTE = 500;

/** Look IDs pasted one per line or separated by commas (also spaces, tabs or semicolons): in order, each once. */
export function parseLookIds(text: string) {
  const ids: string[] = [], seen = new Set<string>();
  let repeated = 0;
  for (const raw of text.split(/[\s,;]+/)) {
    // Quotes come along when IDs are copied from JSON or a spreadsheet.
    const id = raw.replace(/^["'`]+|["'`]+$/g, "");
    if (!id) continue;
    if (seen.has(id)) { repeated++; continue; }
    seen.add(id);
    ids.push(id);
  }
  return { ids, repeated };
}

/** One look's outcome: added, already in the library, never usable (and why), or failed for now (worth a retry). */
export type LookImport = {
  lookId: string; status: "imported" | "exists" | "unusable" | "failed"; id?: string; name?: string; error?: string;
};
