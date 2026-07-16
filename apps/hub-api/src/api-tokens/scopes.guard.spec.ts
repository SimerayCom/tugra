import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ScopesGuard } from "./scopes.guard";
import type { Scope } from "./scopes";

/** Build an http ExecutionContext whose request carries the given scopes + method. */
function ctxFor(scopes: string[] | undefined, method: string): ExecutionContext {
  const req = { user: scopes === undefined ? {} : { scopes }, method };
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

/** A guard whose reflector always reports the given @RequireScopes value (undefined = not annotated). */
function guardWithRequired(required: Scope[] | undefined): ScopesGuard {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  return new ScopesGuard(reflector);
}

describe("ScopesGuard — method-default (un-annotated routes)", () => {
  const guard = guardWithRequired(undefined);

  it("read token: GET passes, POST/PUT/DELETE blocked", () => {
    expect(guard.canActivate(ctxFor(["read"], "GET"))).toBe(true);
    expect(() => guard.canActivate(ctxFor(["read"], "POST"))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(["read"], "PUT"))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(["read"], "DELETE"))).toThrow(ForbiddenException);
  });

  it("write token: GET + POST/PUT pass, DELETE (admin) blocked", () => {
    expect(guard.canActivate(ctxFor(["write"], "GET"))).toBe(true);
    expect(guard.canActivate(ctxFor(["write"], "POST"))).toBe(true);
    expect(guard.canActivate(ctxFor(["write"], "PATCH"))).toBe(true);
    expect(() => guard.canActivate(ctxFor(["write"], "DELETE"))).toThrow(ForbiddenException);
  });

  it("admin token and browser session (['*']) pass every method", () => {
    for (const scopes of [["admin"], ["*"]]) {
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        expect(guard.canActivate(ctxFor(scopes, m))).toBe(true);
      }
    }
  });
});

describe("ScopesGuard — @RequireScopes overrides", () => {
  it("deploy-gated route: deploy token passes, write-only token blocked", () => {
    const guard = guardWithRequired(["deploy"]);
    expect(guard.canActivate(ctxFor(["deploy"], "POST"))).toBe(true);
    expect(guard.canActivate(ctxFor(["read", "deploy"], "POST"))).toBe(true);
    expect(() => guard.canActivate(ctxFor(["write"], "POST"))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(["read"], "POST"))).toThrow(ForbiddenException);
  });

  it("read:secrets-gated route: only read:secrets/admin/session pass", () => {
    const guard = guardWithRequired(["read:secrets"]);
    expect(guard.canActivate(ctxFor(["read:secrets"], "GET"))).toBe(true);
    expect(guard.canActivate(ctxFor(["admin"], "GET"))).toBe(true);
    expect(guard.canActivate(ctxFor(["*"], "GET"))).toBe(true);
    expect(() => guard.canActivate(ctxFor(["read"], "GET"))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(["write", "deploy"], "GET"))).toThrow(ForbiddenException);
  });

  it("multi-scope route requires ALL listed scopes (write AND read:secrets — reissue enroll token)", () => {
    const guard = guardWithRequired(["write", "read:secrets"]);
    expect(guard.canActivate(ctxFor(["write", "read:secrets"], "POST"))).toBe(true);
    expect(guard.canActivate(ctxFor(["admin"], "POST"))).toBe(true);
    expect(guard.canActivate(ctxFor(["*"], "POST"))).toBe(true);
    expect(() => guard.canActivate(ctxFor(["write"], "POST"))).toThrow(ForbiddenException); // missing read:secrets
    expect(() => guard.canActivate(ctxFor(["read:secrets"], "POST"))).toThrow(ForbiddenException); // missing write
  });
});

describe("ScopesGuard — safety rails", () => {
  it("fails closed when the request has no scopes", () => {
    const guard = guardWithRequired(undefined);
    expect(() => guard.canActivate(ctxFor(undefined, "GET"))).toThrow(ForbiddenException);
  });

  it("passes through non-http contexts (WS/RPC handle their own auth)", () => {
    const guard = guardWithRequired(["admin"]);
    const wsCtx = { getType: () => "ws" } as unknown as ExecutionContext;
    expect(guard.canActivate(wsCtx)).toBe(true);
  });
});
