import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Pure helpers for verifying incoming git webhooks and deciding whether a push
 * should trigger a deploy. No I/O — fully unit-testable.
 */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * GitHub-style verification: `X-Hub-Signature-256: sha256=<hex>` is the HMAC-SHA256
 * of the raw request body keyed by the per-app secret.
 */
export function verifyGithubSignature(
  secret: string,
  rawBody: Buffer | string,
  header?: string | null,
): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, header);
}

/** GitLab-style verification: `X-Gitlab-Token` equals the per-app secret. */
export function verifyGitlabToken(secret: string, header?: string | null): boolean {
  if (!header) return false;
  return safeEqual(secret, header);
}

/** Extract the git ref (e.g. "refs/heads/main") from a push payload. */
export function parseRef(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "ref" in payload) {
    const ref = (payload as { ref?: unknown }).ref;
    return typeof ref === "string" ? ref : null;
  }
  return null;
}

/** True when the pushed ref targets the app's tracked branch. */
export function refMatchesBranch(ref: string | null, branch: string): boolean {
  if (!ref) return false;
  return ref === `refs/heads/${branch}`;
}

export function generateWebhookToken(): string {
  return `tugra_wh_${randomBytes(24).toString("base64url")}`;
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}
