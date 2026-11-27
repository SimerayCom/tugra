import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { TEAM_PERMISSIONS, type TeamPermission } from "@tugra/shared";
import { SCOPES, type Scope } from "../api-tokens/scopes";

export const OAUTH_ACCESS_PREFIX = "tugra_oat_";
export const OAUTH_REFRESH_PREFIX = "tugra_ort_";
export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;

export function newAccessToken(): string {
  return `${OAUTH_ACCESS_PREFIX}${randomBytes(32).toString("base64url")}`;
}
export function newRefreshToken(): string {
  return `${OAUTH_REFRESH_PREFIX}${randomBytes(32).toString("base64url")}`;
}
export function newAuthCode(): string {
  return randomBytes(32).toString("base64url");
}
export function isOAuthAccessToken(raw: string | undefined | null): boolean {
  return !!raw && raw.startsWith(OAUTH_ACCESS_PREFIX);
}

/** RFC 7636 code_verifier: 43-128 chars of the unreserved set. */
export function isValidCodeVerifier(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(v);
}

/** RFC 7636 code_challenge for S256: base64url(sha256(verifier)), always 43 chars. */
export function isValidCodeChallenge(c: unknown): c is string {
  return typeof c === "string" && /^[A-Za-z0-9_-]{43}$/.test(c);
}

/** PKCE S256 check: does `verifier` hash to the stored challenge? Constant-time. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!isValidCodeVerifier(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/**
 * A redirect URI a public client may register: absolute, https (any host) or http on a loopback host,
 * no fragment, no credentials. Custom schemes are refused (an app on the same device could claim them).
 */
export function isAllowedRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || raw.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return false;
}

/** Exact string match against the registered list (no prefix, no query-insensitive matching). */
export function redirectUriMatches(registered: readonly string[], candidate: string | undefined | null): boolean {
  return typeof candidate === "string" && registered.includes(candidate);
}

/** The host shown on the consent screen. */
export function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/** Parse a space-delimited `scope` parameter into known scopes (unknown values are dropped). */
export function parseScopes(raw: unknown): Scope[] {
  if (typeof raw !== "string") return [];
  const out = new Set<Scope>();
  for (const s of raw.split(/\s+/)) if ((SCOPES as readonly string[]).includes(s)) out.add(s as Scope);
  return [...out];
}

const CONFIG_PERMISSIONS: readonly TeamPermission[] = [
  "apps:config",
  "databases",
  "backups",
  "servers:manage",
  "monitors",
  "projects",
  "integrations",
  "variables",
];

/** The most a member can be granted as OAuth scopes: `read` always, `write` with any configuration permission,
 *  `deploy` with apps:deploy, and `read:secrets`/`admin` only with the full permission set (OWNER/ADMIN). */
export function maxScopesForPermissions(perms: ReadonlySet<string>): Scope[] {
  const out: Scope[] = ["read"];
  if (CONFIG_PERMISSIONS.some((p) => perms.has(p))) out.push("write");
  if (perms.has("apps:deploy")) out.push("deploy");
  if (TEAM_PERMISSIONS.every((p) => perms.has(p))) out.push("read:secrets", "admin");
  return out;
}

/** Requested scopes limited to what the member's permissions allow. Never empty: falls back to `read`. */
export function clampScopes(requested: readonly Scope[], perms: ReadonlySet<string>): Scope[] {
  const allowed = new Set(maxScopesForPermissions(perms));
  const out = requested.filter((s) => allowed.has(s));
  return out.length ? out : ["read"];
}

export function wwwAuthenticate(resourceMetadataUrl: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl}"`;
}
