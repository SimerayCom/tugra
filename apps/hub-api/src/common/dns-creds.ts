/**
 * DNS-01 provider credentials are a flat KEY=VALUE map rendered into a single-line-per-variable `--env-file` for the
 * proxy. A line break or NUL in a key or value would define an extra variable, so they are refused at write time.
 * A token pasted with a trailing newline is the common mistake: values are trimmed first, which is also how rows
 * stored before this validation existed keep working (`trimDnsCreds` at render time).
 */
import { isValidUserEnvKey } from "./env-key";

/** Each value with surrounding whitespace (incl. a trailing newline) removed. Never mutates the input. */
export function trimDnsCreds(creds: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) out[k] = typeof v === "string" ? v.trim() : v;
  return out;
}

/** First problem with a DNS credential map (after trimming), or null. Names the key, never the value. */
export function dnsCredsIssue(creds: Record<string, string>): string | null {
  for (const [k, raw] of Object.entries(creds)) {
    if (!isValidUserEnvKey(k)) return `DNS credential name ${JSON.stringify(k.slice(0, 40))} is not valid (no spaces, '=' or control characters)`;
    if (/[\r\n\u0000]/.test(raw.trim())) return `DNS credential ${k} must be a single line (no line break or NUL inside the value)`;
  }
  return null;
}
