import { randomBytes } from "node:crypto";
import { hashToken } from "../api-tokens/api-token.util";

// One-time importer MIGRATION token. Same family as the enroll (tugra_en_) and PAT (tugra_pat_) tokens, but
// hashed at rest like the PAT — the enroll token's plaintext storage + DB-equality check is deliberately NOT
// mirrored. The distinct prefix lets the guard reject a wrong-format value before any DB hit and makes a
// leaked token greppable by secret scanners.
export const MIGRATION_TOKEN_PREFIX = "tugra_mig_";

/** How long a freshly minted migration token stays valid (1h, like the enroll token). Reissue mints a new one. */
export const MIGRATION_TOKEN_TTL_MS = 60 * 60 * 1000;

// 32 random bytes → 43 base64url chars (256-bit entropy, matching the PAT rather than enroll's 24). The
// base64url alphabet is shell-safe, so the token can sit unquoted in the curl command exactly like enroll.
const TOKEN_BODY_LEN = 43;
export const MIGRATION_TOKEN_RE = new RegExp(`^${MIGRATION_TOKEN_PREFIX}[A-Za-z0-9_-]{${TOKEN_BODY_LEN}}$`);

/** A fresh migration token. The raw value is returned to the caller only once (mint/reissue); only its hash is stored. */
export function generateMigrationToken(): string {
  return `${MIGRATION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Is this a well-formed migration token? Cheap guard-side reject (bounds the hashed input) + a shell-safety assert. */
export function isMigrationToken(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length <= 64 && MIGRATION_TOKEN_RE.test(raw);
}

/** SHA-256 hex of the raw token — only this is stored. Shares the single hashing scheme in the repo. */
export function hashMigrationToken(raw: string): string {
  return hashToken(raw);
}
