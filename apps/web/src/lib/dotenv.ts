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
