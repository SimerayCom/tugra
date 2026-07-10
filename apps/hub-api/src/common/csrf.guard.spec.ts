import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { CsrfGuard } from "./csrf.guard";

type Req = { method?: string; headers?: Record<string, string | string[] | undefined> };

function ctx(req: Req, type: "http" | "ws" = "http"): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** Reflector stub — `exempt` decides the @CsrfExempt lookup result. */
function reflector(exempt = false): Reflector {
  return { getAllAndOverride: () => exempt } as unknown as Reflector;
}

describe("CsrfGuard", () => {
  const guard = new CsrfGuard(reflector());
  const cookieHdr = (csrf: string) => `tg_access=AT; tg_refresh=RT; tg_csrf=${csrf}`;

  it("allows safe methods (GET/HEAD/OPTIONS) unconditionally", () => {
    expect(guard.canActivate(ctx({ method: "GET", headers: { cookie: cookieHdr("x") } }))).toBe(true);
    expect(guard.canActivate(ctx({ method: "HEAD", headers: {} }))).toBe(true);
  });

  it("skips non-http contexts (WS)", () => {
    expect(guard.canActivate(ctx({ method: "POST" }, "ws"))).toBe(true);
  });

  it("exempts bearer-authed requests (no ambient credential)", () => {
    const req = { method: "POST", headers: { authorization: "Bearer abc", cookie: cookieHdr("tok") } };
    // Bearer present → exempt even though a cookie is also present and no CSRF header is sent.
    expect(guard.canActivate(ctx(req))).toBe(true);
  });

  it("allows mutations with no session cookie (public endpoints)", () => {
    expect(guard.canActivate(ctx({ method: "POST", headers: {} }))).toBe(true);
    expect(guard.canActivate(ctx({ method: "POST", headers: { cookie: "other=1" } }))).toBe(true);
  });

  it("rejects a cookie-authed mutation with a missing CSRF header", () => {
    const req = { method: "POST", headers: { cookie: cookieHdr("tok") } };
    expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
  });

  it("rejects a cookie-authed mutation with a mismatched CSRF header", () => {
    const req = { method: "PATCH", headers: { cookie: cookieHdr("tok"), "x-csrf-token": "nope" } };
    expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
  });

  it("allows a cookie-authed mutation when header === tg_csrf cookie (double-submit)", () => {
    const req = { method: "DELETE", headers: { cookie: cookieHdr("tok"), "x-csrf-token": "tok" } };
    expect(guard.canActivate(ctx(req))).toBe(true);
  });

  it("guards even when only the refresh cookie is present (e.g. /auth/refresh)", () => {
    const req = { method: "POST", headers: { cookie: "tg_refresh=RT; tg_csrf=tok" } };
    expect(() => guard.canActivate(ctx(req))).toThrow(ForbiddenException);
    const ok = { method: "POST", headers: { cookie: "tg_refresh=RT; tg_csrf=tok", "x-csrf-token": "tok" } };
    expect(guard.canActivate(ctx(ok))).toBe(true);
  });

  it("exempts @CsrfExempt routes (public login/register) even with a stale session cookie", () => {
    const exemptGuard = new CsrfGuard(reflector(true));
    // Cookie present, no CSRF header → would 403 normally, but the route opted out.
    const req = { method: "POST", headers: { cookie: cookieHdr("tok") } };
    expect(exemptGuard.canActivate(ctx(req))).toBe(true);
  });

  it("does not crash on a co-resident cookie with a malformed percent-sequence", () => {
    // A foreign `pref=100%` in the jar must not throw (URIError) out of the guard.
    const req = { method: "POST", headers: { cookie: "pref=100%; tg_access=AT; tg_csrf=tok", "x-csrf-token": "tok" } };
    expect(guard.canActivate(ctx(req))).toBe(true);
  });
});
