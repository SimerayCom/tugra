import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { EmailVerifiedGuard } from "./email-verified.guard";

type Req = { method?: string; headers?: Record<string, string | string[] | undefined> };

function ctx(req: Req, type: "http" | "ws" = "http"): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function make(opts: {
  enforce?: boolean;
  exempt?: boolean;
  jwtSub?: string | null; // null → verify throws (expired/forged)
  emailVerified?: boolean;
  userExists?: boolean;
}) {
  const reflector = { getAllAndOverride: () => opts.exempt ?? false } as any;
  const config = {
    get: (k: string) =>
      k === "REQUIRE_EMAIL_VERIFICATION" ? (opts.enforce ? "true" : "false") : "secret",
  } as any;
  const jwt = {
    verifyAsync: async () => {
      if (opts.jwtSub == null) throw new Error("bad token");
      return { sub: opts.jwtSub, type: "access" };
    },
  } as any;
  const prisma = {
    user: {
      findUnique: async () =>
        opts.userExists === false ? null : { emailVerified: opts.emailVerified ?? false },
    },
  } as any;
  return new EmailVerifiedGuard(reflector, config, jwt, prisma);
}

const authed = (method = "POST") => ({ method, headers: { authorization: "Bearer tok" } });

describe("EmailVerifiedGuard", () => {
  it("allows everything when enforcement is off (default)", async () => {
    const g = make({ enforce: false, jwtSub: "u1", emailVerified: false });
    expect(await g.canActivate(ctx(authed()))).toBe(true);
  });

  it("skips non-http contexts", async () => {
    const g = make({ enforce: true, jwtSub: "u1", emailVerified: false });
    expect(await g.canActivate(ctx(authed(), "ws"))).toBe(true);
  });

  it("allows non-mutating methods (reads)", async () => {
    const g = make({ enforce: true, jwtSub: "u1", emailVerified: false });
    expect(await g.canActivate(ctx(authed("GET")))).toBe(true);
  });

  it("allows @AllowUnverified routes even when unverified", async () => {
    const g = make({ enforce: true, exempt: true, jwtSub: "u1", emailVerified: false });
    expect(await g.canActivate(ctx(authed()))).toBe(true);
  });

  it("allows a mutation with no resolvable user (public / bad token → JwtAuthGuard handles it)", async () => {
    const noToken = make({ enforce: true, jwtSub: "u1", emailVerified: false });
    expect(await noToken.canActivate(ctx({ method: "POST", headers: {} }))).toBe(true);
    const forged = make({ enforce: true, jwtSub: null, emailVerified: false });
    expect(await forged.canActivate(ctx(authed()))).toBe(true);
  });

  it("allows a verified user to mutate", async () => {
    const g = make({ enforce: true, jwtSub: "u1", emailVerified: true });
    expect(await g.canActivate(ctx(authed("PATCH")))).toBe(true);
  });

  it("blocks an unverified user's mutation with 403", async () => {
    const g = make({ enforce: true, jwtSub: "u1", emailVerified: false });
    await expect(g.canActivate(ctx(authed("DELETE")))).rejects.toThrow(ForbiddenException);
  });

  it("resolves the user from the tg_access cookie too", async () => {
    const g = make({ enforce: true, jwtSub: "u1", emailVerified: false });
    const req = { method: "POST", headers: { cookie: "tg_access=tok" } };
    await expect(g.canActivate(ctx(req))).rejects.toThrow(ForbiddenException);
  });
});
