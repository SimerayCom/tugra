/** Minimal `.env` parsing for the env editor's bulk-edit mode (KEY=VALUE per line).
 *
 * The round-trip `parseDotenv(toDotenv(rows))` must return the same rows for ANY values — including
 * secrets that contain newlines, quotes, backslashes, leading/trailing spaces or '=' (PEM keys, JSON
 * blobs). The bulk editor Apply→Save path persists whatever this produces straight into the encrypted
 * env blob, so a lossy round-trip silently corrupts stored secrets. We therefore quote-and-escape on
 * serialize and understand quoted (incl. multi-line) values on parse.
 *
 * Deliberate choices for a SECRETS editor (not a general config loader):
 *  - A value is NOT split on an inline `# comment`. Stripping ` #...` would silently truncate a secret
 *    that legitimately contains ` #` (e.g. a password). Our own serializer quotes any value containing
 *    `#`, so this never affects the round-trip; it only keeps pasted values verbatim.
 *  - Unknown escapes keep their backslash (`\p` stays `\p`), so pasted Windows paths and regexes survive.
 *  - An unterminated quote is read leniently to end-of-input rather than throwing; the server rejects the
 *    resulting newline value, so it surfaces as an error, never as silently-persisted corruption. */

export interface EnvRow {
  key: string;
  value: string;
}

/** A value that can't be written bare on a `KEY=value` line without changing its meaning on the way back
 *  (whitespace that would be trimmed, quote/backslash/comment chars, or newlines/tabs). Empty is fine bare. */
function needsQuote(v: string): boolean {
  if (v === "") return false;
  return /[\n\r\t"'#\\]/.test(v) || v !== v.trim();
}

/** Serialize one value: bare when safe, otherwise a double-quoted string with `\`, `"` and CR escaped.
 *  Literal LF and TAB are kept verbatim inside the quotes (they survive the round-trip unescaped), so a
 *  multi-line secret stays human-readable in the textarea rather than collapsing to `\n` sequences. */
function serializeValue(v: string): string {
  if (!needsQuote(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r")}"`;
}

/** Serialize rows back to `.env` text (skips rows with an empty key). Assumes valid env keys (the editor
 *  validates those separately via invalidKeys); a key with `=`/`#`/newline is out of scope here. */
export function toDotenv(rows: EnvRow[]): string {
  return rows
    .filter((r) => r.key.trim())
    .map((r) => `${r.key.trim()}=${serializeValue(r.value)}`)
    .join("\n");
}

/** Strip trailing spaces and tabs with a backward scan — NOT `/[ \t]+$/`, whose unanchored start
 *  backtracks O(n^2) on a long run of whitespace followed by a non-space (a pasted blob could freeze
 *  the tab). */
function trimTrailingBlanks(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end -= 1;
  return s.slice(0, end);
}

/**
 * Parse pasted `.env` text into rows. Handles LF, CRLF and lone-CR line endings; skips blanks and `#`
 * comments; strips an optional `export `; splits on the first `=`. A value may be bare, single-quoted
 * (literal) or double-quoted (with `\n`/`\r`/`\t`/`\\`/`\"` escapes; any other `\X` keeps its backslash);
 * a quote left open at end of line continues onto the next line (real multi-line secrets).
 */
export function parseDotenv(text: string): EnvRow[] {
  const rows: EnvRow[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/^\s+/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;
    let body = trimmed;
    const exp = body.match(/^export[ \t]+/);
    if (exp) body = body.slice(exp[0].length);
    const eq = body.indexOf("=");
    if (eq < 0) continue;
    const key = body.slice(0, eq).trim();
    if (!key) continue;
    const rest = body.slice(eq + 1).replace(/^[ \t]+/, ""); // tolerate `KEY = value`
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let buf = rest.slice(1);
      let value = "";
      let closed = false;
      for (;;) {
        let k = 0;
        while (k < buf.length) {
          const c = buf[k];
          if (quote === '"' && c === "\\" && k + 1 < buf.length) {
            const n = buf[k + 1];
            value += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n === "\\" ? "\\" : n === '"' ? '"' : "\\" + n;
            k += 2;
            continue;
          }
          if (c === quote) {
            closed = true;
            break;
          }
          value += c;
          k += 1;
        }
        if (closed || i + 1 >= lines.length) break; // unterminated at EOF: keep what we have
        i += 1;
        value += "\n";
        buf = lines[i];
      }
      rows.push({ key, value });
    } else {
      // Bare value: trim trailing blanks (serializeValue never emits a bare value with edge whitespace).
      rows.push({ key, value: trimTrailingBlanks(rest) });
    }
  }
  return rows;
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

/**
 * Whether the env editor may persist `rows`. The server replaces the WHOLE env blob on save, so saving an
 * empty map wipes every variable. `stored` is the loaded env (react-query `data`): it is `undefined` while
 * the query is pending OR after it errored, and only then is `rows` still the initial `[]` — so an early or
 * post-error Save would silently wipe everything. Gate on this: it is false until the env has loaded, and
 * false when the rows already match what's stored (nothing to save), true only when there's a real change.
 */
export function envDirty(rows: EnvRow[], stored: Record<string, string> | undefined): boolean {
  if (!stored) return false; // not loaded yet, or the load failed — never safe to save
  const map: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) map[r.key.trim()] = r.value;
  const mapKeys = Object.keys(map);
  const storedKeys = Object.keys(stored);
  if (mapKeys.length !== storedKeys.length) return true;
  for (const k of mapKeys) if (stored[k] !== map[k]) return true;
  return false;
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
