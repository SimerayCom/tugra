import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { InstanceOwnerGuard } from "./instance-owner.guard";
import type { PrismaService } from "../prisma/prisma.service";

function ctxFor(userId: string | undefined, type = "http"): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => ({ user: userId ? { userId } : undefined }) }),
  } as unknown as ExecutionContext;
}

function guard(isInstanceOwner: boolean | null): InstanceOwnerGuard {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(isInstanceOwner === null ? null : { isInstanceOwner }) },
  } as unknown as PrismaService;
  return new InstanceOwnerGuard(prisma);
}

describe("InstanceOwnerGuard", () => {
  it("allows the instance owner", async () => {
    await expect(guard(true).canActivate(ctxFor("u1"))).resolves.toBe(true);
  });

  it("blocks a non-owner", async () => {
    await expect(guard(false).canActivate(ctxFor("u2"))).rejects.toThrow(ForbiddenException);
  });

  it("blocks when the user record is missing", async () => {
    await expect(guard(null).canActivate(ctxFor("ghost"))).rejects.toThrow(ForbiddenException);
  });

  it("blocks when there is no authenticated user (fail-closed)", async () => {
    await expect(guard(true).canActivate(ctxFor(undefined))).rejects.toThrow(ForbiddenException);
  });

  it("passes through non-http contexts", async () => {
    await expect(guard(false).canActivate(ctxFor(undefined, "ws"))).resolves.toBe(true);
  });
});
