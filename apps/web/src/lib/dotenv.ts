/** Minimal .env parsing for the env editor's bulk-edit mode (KEY=VALUE per line). */

export interface EnvRow {
  key: string;
  value: string;
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parse pasted `.env` text into rows. Skips blanks/comments; splits on the first `=`. */
export function parseDotenv(text: string): EnvRow[] {
  const rows: EnvRow[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    rows.push({ key, value: stripQuotes(line.slice(eq + 1).trim()) });
  }
  return rows;
}

/** Serialize rows back to `.env` text (skips rows with an empty key). */
export function toDotenv(rows: EnvRow[]): string {
  return rows
    .filter((r) => r.key.trim())
    .map((r) => `${r.key.trim()}=${r.value}`)
    .join("\n");
}

/** A valid env var name (mirrors the hub's ENV_KEY_RE): a letter/underscore, then word chars. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keys that appear on more than one row (trimmed, non-empty), in first-seen order.
 * Saving a map silently keeps only the last value for a duplicate key — the editor uses this to
 * warn and block instead of losing data quietly.
 */
export function duplicateKeys(rows: EnvRow[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r.key.trim();
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const dups: string[] = [];
  for (const [k, n] of counts) if (n > 1) dups.push(k);
  return dups;
}

/** Non-empty keys that aren't valid env var names (the server would reject these). */
export function invalidKeys(rows: EnvRow[]): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const r of rows) {
    const k = r.key.trim();
    if (k && !ENV_KEY_RE.test(k) && !seen.has(k)) {
      seen.add(k);
      bad.push(k);
    }
  }
  return bad;
}
