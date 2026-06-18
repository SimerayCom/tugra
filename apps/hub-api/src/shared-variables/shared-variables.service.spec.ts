import { ForbiddenException } from "@nestjs/common";
import { SharedVariablesService } from "./shared-variables.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";

const audit = { log: jest.fn() } as unknown as AuditService;
const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
} as unknown as CryptoService;

function make(prisma: Partial<PrismaService>, access: Partial<TeamAccessService>) {
  return new SharedVariablesService(prisma as PrismaService, access as TeamAccessService, audit, crypto);
}

describe("SharedVariablesService", () => {
  it("forbids a viewer from setting a variable", async () => {
    const access = { requireRole: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    await expect(make({}, access).upsert("u1", "t1", "FOO", "bar")).rejects.toThrow(/nope/);
  });

  it("encrypts the value on upsert", async () => {
    let saved: Record<string, unknown> = {};
    const prisma = {
      sharedVariable: {
        upsert: jest.fn().mockImplementation(({ create }) => {
          saved = create;
          return Promise.resolve({ id: "v1", teamId: "t1", key: "FOO", createdAt: new Date(), ...create });
        }),
      },
    } as unknown as PrismaService;
    const access = { requireRole: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const v = await make(prisma, access).upsert("u1", "t1", "FOO", "bar");
    expect(saved.valueEnc).toBe("enc:bar");
    expect(v.value).toBe("bar");
  });

  it("hides values from non-write members", async () => {
    const prisma = {
      sharedVariable: { findMany: jest.fn().mockResolvedValue([{ id: "v1", teamId: "t1", key: "FOO", valueEnc: "enc:bar", createdAt: new Date() }]) },
    } as unknown as PrismaService;
    const access = { teamRole: jest.fn().mockResolvedValue("VIEWER") } as unknown as TeamAccessService;
    const list = await make(prisma, access).list("u1", "t1");
    expect(list[0].value).toBeNull();
  });

  it("resolvedMap decrypts all team variables", async () => {
    const prisma = {
      sharedVariable: { findMany: jest.fn().mockResolvedValue([
        { key: "A", valueEnc: "enc:1" },
        { key: "B", valueEnc: "enc:two" },
      ]) },
    } as unknown as PrismaService;
    expect(await make(prisma, {}).resolvedMap("t1")).toEqual({ A: "1", B: "two" });
  });
});
