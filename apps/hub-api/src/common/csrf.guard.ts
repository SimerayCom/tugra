import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { CSRF_EXEMPT } from "./csrf-exempt.decorator";
import { parseCookies, TG_ACCESS, TG_REFRESH, TG_CSRF } from "./cookies";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Double-submit CSRF for COOKIE-authenticated mutations. Because a browser auto-attaches the
 * session cookie, a cross-site page could trigger a state-changing request carrying the victim's
 * cookie. SameSite=Lax already blocks most of that; this adds defense-in-depth: a cookie-authed
 * mutation must send an `X-CSRF-Token` header equal to the JS-readable `tg_csrf` cookie — a value
 * a cross-origin script can't read (no CORS credentials) and can't set on a cross-site simple
 * request. Requests authenticated by a Bearer token (PAT / CLI / e2e) are EXEMPT: a bearer token
 * is never sent ambiently, so those requests aren't CSRF-able.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (ctx.getType() !== "http") return true; // WS / other transports handle their own auth
    // Public, body-authenticated routes (login/register/forgot/reset) opt out — otherwise a browser
    // still holding a stale session cookie would be locked out of re-login by the CSRF check.
    if (this.reflector.getAllAndOverride<boolean>(CSRF_EXEMPT, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest();
    if (!MUTATING.has(String(req.method ?? "GET").toUpperCase())) return true; // reads are safe
    const authz = req.headers?.authorization;
    if (typeof authz === "string" && authz.length > 0) return true; // bearer → not ambient → exempt
    const cookies = parseCookies(req.headers?.cookie);
    if (!cookies[TG_ACCESS] && !cookies[TG_REFRESH]) return true; // no cookie session → nothing to guard
    const header = req.headers?.["x-csrf-token"];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token || token !== cookies[TG_CSRF]) {
      throw new ForbiddenException("missing or invalid CSRF token");
    }
    return true;
  }
}
