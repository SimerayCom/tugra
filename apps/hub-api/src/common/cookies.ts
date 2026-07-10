import { randomBytes } from "node:crypto";

// Cookie names for the browser session. httpOnly access+refresh can't be read by JS (XSS-safe);
// the CSRF cookie is JS-readable and echoed back in a header (double-submit).
export const TG_ACCESS = "tg_access";
export const TG_REFRESH = "tg_refresh";
export const TG_CSRF = "tg_csrf";

const ACCESS_MAX_AGE = 15 * 60 * 1000; // 15 min (matches the access-JWT TTL)
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days (matches the refresh-JWT TTL)

/** Minimal express Response surface for cookies — avoids a hard @types/express dependency. */
export interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options?: Record<string, unknown>): void;
}

/** Parse a raw `Cookie` header into a name → value map. */
export function parseCookies(header?: string | string[]): Record<string, string> {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const v = part.slice(i + 1).trim();
    // A foreign cookie in the jar may hold a malformed percent-sequence (e.g. `pref=100%`);
    // decodeURIComponent throws URIError on those — fall back to the raw value rather than let a
    // co-resident cookie crash auth/CSRF/WS parsing (this runs on the request hot path).
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Whether cookies carry the Secure flag. On by default in production (HTTPS); off on localhost
 * http so dev works (a Secure cookie is dropped over http). Overridable via COOKIE_SECURE.
 */
export function cookiesSecure(): boolean {
  const explicit = process.env.COOKIE_SECURE;
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  return process.env.NODE_ENV === "production";
}

const sessionOpts = (secure: boolean) => ({ httpOnly: true, sameSite: "lax" as const, secure, path: "/" });

/**
 * Set the session cookies (httpOnly access + refresh) and the JS-readable CSRF token. Returns the
 * CSRF value. On refresh, pass the current CSRF via `opts.csrf` so it's preserved (a fresh maxAge
 * without a value change) — that keeps the double-submit token stable across background refreshes.
 */
export function setAuthCookies(
  res: CookieResponse,
  tokens: { accessToken: string; refreshToken: string },
  opts?: { csrf?: string },
): string {
  const secure = cookiesSecure();
  res.cookie(TG_ACCESS, tokens.accessToken, { ...sessionOpts(secure), maxAge: ACCESS_MAX_AGE });
  res.cookie(TG_REFRESH, tokens.refreshToken, { ...sessionOpts(secure), maxAge: REFRESH_MAX_AGE });
  const csrf = opts?.csrf || randomBytes(32).toString("base64url");
  res.cookie(TG_CSRF, csrf, { httpOnly: false, sameSite: "lax", secure, path: "/", maxAge: REFRESH_MAX_AGE });
  return csrf;
}

/** Clear all three session cookies (logout). */
export function clearAuthCookies(res: CookieResponse): void {
  const secure = cookiesSecure();
  for (const name of [TG_ACCESS, TG_REFRESH, TG_CSRF]) {
    res.clearCookie(name, { path: "/", sameSite: "lax", secure });
  }
}
