import { z } from "zod";

/** Hard caps as a DoS guard — the real cleanup happens in normalizeTags. */
export const SetTagsSchema = z.object({
  tags: z.array(z.string().max(40)).max(50),
});
export type SetTagsInput = z.infer<typeof SetTagsSchema>;

/**
 * Canonicalize free-text tags: lowercase, trim, collapse anything that isn't
 * [a-z0-9-] into a single hyphen, drop empties, dedupe, sort, cap at 20.
 * Shared by app/server/database setTags so filtering is consistent everywhere.
 */
export function normalizeTags(input: string[]): string[] {
  const cleaned = input
    .map((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean);
  return [...new Set(cleaned)].sort().slice(0, 20);
}
