/** Pure helpers for a notification channel's routing rule (categories, minimum severity, Telegram topics).
 *  The vocabulary (category + severity ids) comes from GET /channels/events; nothing here hardcodes it. */

export interface RoutingDraft {
  categories: string[];
  minSeverity: string;
  /** category → raw input text (kept as strings so a half-typed number is not coerced mid-edit) */
  topics: Record<string, string>;
}

export const toggleIn = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/** Draft state for an existing channel (legacy rows without routing fields read as "no rule"). */
export function draftFromChannel(c: { categories?: string[]; minSeverity?: string; topics?: Record<string, number> | null }): RoutingDraft {
  const topics: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.topics ?? {})) topics[k] = String(v);
  return { categories: c.categories ?? [], minSeverity: c.minSeverity ?? "info", topics };
}

/**
 * Turn the topic inputs into the API shape. Blank entries are dropped, and entries for categories that
 * are not selected are ignored; anything that is not a positive integer is reported in `invalid` so the
 * form can refuse to save instead of silently sending nothing.
 */
export function parseTopics(topics: Record<string, string>, categories: string[]): { topics: Record<string, number>; invalid: string[] } {
  const out: Record<string, number> = {};
  const invalid: string[] = [];
  for (const [cat, raw] of Object.entries(topics)) {
    const text = raw.trim();
    if (!text || !categories.includes(cat)) continue;
    const n = Number(text);
    if (Number.isInteger(n) && n > 0 && n <= 2147483647) out[cat] = n;
    else invalid.push(cat);
  }
  return { topics: out, invalid };
}
