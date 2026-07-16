import { ApiTokensService } from "./api-tokens.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { hashToken } from "./api-token.util";

const audit = { log: jest.fn() } as unknown as AuditService;

describe("ApiTokensService", () => {
  it("returns the raw token once and stores only its hash", async () => {
    let saved: Record<string, unknown> = {};
    const prisma = {
      apiToken: {
        create: jest.fn().mockImplementation(({ data }) => {
          saved = data;
          return Promise.resolve({ id: "t1", createdAt: new Date(), expiresAt: null, lastUsedAt: null, ...data });
        }),
      },
    } as unknown as PrismaService;
    const svc = new ApiTokensService(prisma, audit);
    const res = await svc.create("u1", { name: "ci", scopes: ["read", "deploy"] });
    expect(res.token).toMatch(/^tugra_pat_/);
    expect(saved.tokenHash).toBe(hashToken(res.token));
    expect(saved.tokenHash).not.toBe(res.token);
    expect(saved.scopes).toEqual(["read", "deploy"]);
    expect(res.view.scopes).toEqual(["read", "deploy"]);
    expect(res.view).not.toHaveProperty("tokenHash");
  });

  it("validates a good token to its owner, carrying scopes + tokenId", async () => {
    const prisma = {
      apiToken: {
        findUnique: jest.fn().mockResolvedValue({ id: "t1", userId: "u9", scopes: ["read", "write"], expiresAt: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const user = await new ApiTokensService(prisma, audit).validate("tugra_pat_abc");
    expect(user).toEqual({ userId: "u9", scopes: ["read", "write"], tokenId: "t1" });
  });

  it("rejects expired, unknown, and non-PAT tokens", async () => {
    const prisma = {
      apiToken: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ id: "t1", userId: "u9", expiresAt: new Date(Date.now() - 1000) }) // expired
          .mockResolvedValueOnce(null), // unknown
        update: jest.fn(),
      },
    } as unknown as PrismaService;
    const svc = new ApiTokensService(prisma, audit);
    expect(await svc.validate("tugra_pat_expired")).toBeNull();
    expect(await svc.validate("tugra_pat_unknown")).toBeNull();
    expect(await svc.validate("not-a-pat")).toBeNull(); // never hits DB
  });
});
