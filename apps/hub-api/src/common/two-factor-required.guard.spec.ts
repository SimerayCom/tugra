import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { TwoFactorRequiredGuard } from "./two-factor-required.guard";

type Req = { method?: string; path?: string; headers?: Record<string, string | string[] | undefined> };

function ctx(req: Req, type: "http" | "ws" = "http"): ExecutionContext {
  return { getType: () => type, getHandler: () => undefined, getClass: () => undefined, switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

function make(opts: { exempt?: boolean; jwtSub?: string | null; required?: boolean }) {
  const reflector = { getAllAndOverride: () => opts.exempt ?? false } as never;
  const config = { get: () => "secret" } as never;
  const jwt = {
    verifyAsync: async () => {
      if (opts.jwtSub == null) throw new Error("bad token");
      return { sub: opts.jwtSub, type: "access" };
    },
  } as never;
  const policy = { setupRequired: jest.fn().mockResolvedValue(opts.required ?? false) };
  return { guard: new TwoFactorRequiredGuard(reflector, config, jwt, policy as never), policy };
}

const authed = (path: string, method = "GET"): Req => ({ method, path, headers: { authorization: "Bearer tok" } });

describe("TwoFactorRequiredGuard", () => {
  it("lets an owner who still has to enrol reach account self-service and the public bootstrap reads", async () => {
    expect(await make({ jwtSub: "u1", required: true, exempt: true }).guard.canActivate(ctx(authed("/api/v1/auth/2fa/setup", "POST")))).toBe(true);
    for (const p of ["/api/v1/instance/status", "/api/v1/instance/branding", "/api/v1/instance/version", "/health", "/version"]) {
      expect(await make({ jwtSub: "u1", required: true }).guard.canActivate(ctx(authed(p)))).toBe(true);
    }
  });

  it("blocks everything else with a 403 two_factor_required (reads included)", async () => {
    for (const [path, method] of [["/api/v1/applications", "GET"], ["/api/v1/servers/s1", "DELETE"], ["/api/v1/instance/settings", "PATCH"], ["/api/v1/instance/status-extra", "GET"]] as const) {
      const { guard } = make({ jwtSub: "u1", required: true });
      const err = await guard.canActivate(ctx(authed(`${path}?x=1`, method))).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({ code: "two_factor_required" });
    }
  });

  it("allows a user who does not need to enrol (policy off, enrolled or unprivileged)", async () => {
    expect(await make({ jwtSub: "u1", required: false }).guard.canActivate(ctx(authed("/applications")))).toBe(true);
  });

  it("falls through to the route's own guard for no/forged tokens and for non-http contexts", async () => {
    const { guard, policy } = make({ jwtSub: null, required: true });
    expect(await guard.canActivate(ctx(authed("/applications")))).toBe(true);
    expect(await guard.canActivate(ctx({ path: "/applications", headers: {} }))).toBe(true);
    expect(await make({ jwtSub: "u1", required: true }).guard.canActivate(ctx(authed("/applications"), "ws"))).toBe(true);
    expect(policy.setupRequired).not.toHaveBeenCalled();
  });
});
