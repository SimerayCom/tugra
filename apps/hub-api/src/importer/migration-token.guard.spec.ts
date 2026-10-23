import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { MigrationTokenGuard } from "./migration-token.guard";
import type { MigrationTokenService } from "./migration-token.service";
import { generateMigrationToken } from "./migration-token";

function ctxFor(authorization?: string): { ctx: ExecutionContext; req: { headers: Record<string, unknown>; migration?: unknown } } {
  const req = { headers: authorization ? { authorization } : {}, migration: undefined as unknown };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { ctx, req };
}

function guard(validated: unknown) {
  const validate = jest.fn().mockResolvedValue(validated);
  const tokens = { validate } as unknown as MigrationTokenService;
  return { g: new MigrationTokenGuard(tokens), validate };
}

const TOK = generateMigrationToken();

describe("MigrationTokenGuard", () => {
  it("accepts a valid token, attaches req.migration = {opId, actorId, expiresAt}, returns true", async () => {
    const resolved = { opId: "op-1", actorId: "user-1", expiresAt: new Date() };
    const { g } = guard(resolved);
    const { ctx, req } = ctxFor(`Bearer ${TOK}`);
    await expect(g.canActivate(ctx)).resolves.toBe(true);
    expect(req.migration).toEqual(resolved);
  });

  it("rejects malformed input with ONE uniform 401 and WITHOUT hitting the DB (validate not called)", async () => {
    for (const h of [undefined, "Basic abc", "Bearer ", `Bearer tugra_pat_${"a".repeat(43)}`, "Bearer tugra_mig_short"]) {
      const { g, validate } = guard({ opId: "op-1", actorId: "u", expiresAt: new Date() });
      const { ctx } = ctxFor(h);
      await expect(g.canActivate(ctx)).rejects.toThrow(new UnauthorizedException("invalid or expired migration token"));
      expect(validate).not.toHaveBeenCalled();
    }
  });

  it("rejects a well-formed but unknown/expired token (validate → null) with the same 401 message", async () => {
    const { g } = guard(null);
    const { ctx } = ctxFor(`Bearer ${TOK}`);
    await expect(g.canActivate(ctx)).rejects.toThrow(new UnauthorizedException("invalid or expired migration token"));
  });
});
