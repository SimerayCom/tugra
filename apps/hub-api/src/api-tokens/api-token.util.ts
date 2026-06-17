import { createHash, randomBytes } from "node:crypto";

export const API_TOKEN_PREFIX = "tugra_pat_";

/** A fresh personal access token. The raw value is shown to the user only once. */
export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** SHA-256 hex of the raw token — only this is stored. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** First chars for display in the token list (never the full secret). */
export function tokenPrefix(raw: string): string {
  return raw.slice(0, 16);
}

export function isApiToken(raw: string | undefined | null): boolean {
  return !!raw && raw.startsWith(API_TOKEN_PREFIX);
}
