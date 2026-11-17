/**
 * The short, safe excerpt of a source API's JSON error `message` that goes into an import error.
 *
 * Coolify answers every 4xx with `{"message": "..."}` and the message is the only thing that tells the several 403 causes
 * apart (API switched off, this hub not in Allowed IPs, a project-scoped token, a token with more access than its creator).
 * The body is third-party text, so it is reduced before it reaches an error: only the `message` string, control characters
 * stripped, anything that looks like a secret or token replaced, and at most {@link MAX_API_MESSAGE} characters kept. A body
 * that is not JSON, has no string `message`, or is empty yields `null` (the caller then reports the bare status).
 */
export const MAX_API_MESSAGE = 100;

const REDACTED = "[redacted]";

/** Replace every occurrence of a configured secret (the token, with and without its `Bearer ` prefix). */
function redactKnown(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const raw of secrets) {
    const s = raw.replace(/^Bearer\s+/i, "").trim();
    if (s.length >= 6) out = out.split(s).join(REDACTED);
  }
  return out;
}

/** Shape-based redaction for a secret the caller does not know (an echoed other token, a key, a password). */
function redactShapes(text: string): string {
  return (
    text
      // Laravel Sanctum plain-text token: `<id>|<40 alphanumerics>`
      .replace(/\b\d+\|[A-Za-z0-9]{16,}\b/g, REDACTED)
      // an Authorization header or bearer value
      .replace(/\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, REDACTED)
      // `token=abc`, `password: abc`, `api_key = abc`, `secret "abc"`
      .replace(/\b(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|authorization|credential)s?\b\s*[:=]\s*["']?[^\s"',;]+/gi, REDACTED)
      // PEM blocks
      .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g, REDACTED)
      // JWT
      .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, REDACTED)
      // a long unbroken token-like run (hex, base64, base64url, provider prefixes such as ghp_/sk-) that is not an ordinary word
      .replace(/\b[A-Za-z0-9][A-Za-z0-9_+/=.-]{19,}\b/g, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? REDACTED : /^[0-9a-f]{20,}$/i.test(run) ? REDACTED : run))
  );
}

export function safeApiMessage(body: Buffer | string, secrets: readonly string[] = []): string | null {
  const text = typeof body === "string" ? body : body.toString("utf8");
  if (!text || text.length > 64 * 1024) return null; // a document, not an error body
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const message = (parsed as Record<string, unknown>).message;
  if (typeof message !== "string") return null;
  const cleaned = redactShapes(redactKnown(message, secrets))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_API_MESSAGE ? `${cleaned.slice(0, MAX_API_MESSAGE - 1).trimEnd()}…` : cleaned;
}
