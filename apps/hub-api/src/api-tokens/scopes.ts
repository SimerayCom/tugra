// API-token scope vocabulary + the pure enforcement logic. A personal access token (PAT) carries a
// subset of these; a browser session carries the wildcard "*" (full access). Kept dependency-free so the
// guard, the decorator and the redaction helpers all share one source of truth.

export const SCOPES = ["read", "write", "deploy", "admin", "read:secrets"] as const;
export type Scope = (typeof SCOPES)[number];

/** The scope an endpoint needs by default, inferred from its HTTP method (fail-safe: an un-annotated
 *  mutating route requires `write`, so a read-only token can never write it). @RequireScopes overrides. */
export function methodDefaultScope(method: string): Scope {
  const m = String(method ?? "GET").toUpperCase();
  if (m === "DELETE") return "admin"; // deletes are destructive → admin (SPEC)
  if (m === "POST" || m === "PUT" || m === "PATCH") return "write";
  return "read"; // GET / HEAD / OPTIONS
}

/** Does a token's granted scopes satisfy a required scope? `admin`/`*` pass everything; `read` is implied
 *  by ANY granted scope; `write`/`deploy`/`read:secrets` are independent (a `write` token is not a
 *  `deploy` token and vice-versa). */
export function scopeSatisfies(tokenScopes: readonly string[], required: Scope): boolean {
  if (tokenScopes.includes("*") || tokenScopes.includes("admin")) return true;
  if (tokenScopes.includes(required)) return true;
  if (required === "read" && tokenScopes.length > 0) return true;
  return false;
}

/** Whether the caller may see decrypted secret fields (env values, db passwords, shared-variable values,
 *  webhook secrets). Only `read:secrets` (or the superset `admin`/`*`) unlocks them. */
export function canReadSecrets(scopes: readonly string[]): boolean {
  return scopes.includes("*") || scopes.includes("admin") || scopes.includes("read:secrets");
}
