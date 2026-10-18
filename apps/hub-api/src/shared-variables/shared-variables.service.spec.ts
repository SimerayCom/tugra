import { ForbiddenException } from "@nestjs/common";
import { SharedVariablesService } from "./shared-variables.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";

const ALL_PERMS = new Set([
  "apps:deploy",
  "apps:config",
  "databases",
  "backups",
  "servers:manage",
  "servers:ops",
  "terminal",
  "bulk",
  "monitors",
  "projects",
  "integrations",
  "variables",
]);

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
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
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
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const v = await make(prisma, access).upsert("u1", "t1", "FOO", "bar");
    expect(saved.valueEnc).toBe("enc:bar");
    expect(v.value).toBe("bar");
  });

  it("hides values AND reports canWrite=false for non-write members", async () => {
    const prisma = {
      sharedVariable: { findMany: jest.fn().mockResolvedValue([{ id: "v1", teamId: "t1", key: "FOO", valueEnc: "enc:bar", createdAt: new Date() }]) },
    } as unknown as PrismaService;
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set()]])) } as unknown as TeamAccessService;
    const list = await make(prisma, access).list("u1", "t1");
    expect(list[0].value).toBeNull();
    expect(list[0].canWrite).toBe(false);
  });

  it("reveals values AND reports canWrite=true for writers", async () => {
    const prisma = {
      sharedVariable: { findMany: jest.fn().mockResolvedValue([{ id: "v1", teamId: "t1", key: "FOO", valueEnc: "enc:bar", createdAt: new Date() }]) },
    } as unknown as PrismaService;
    const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(ALL_PERMS)]])) } as unknown as TeamAccessService;
    const list = await make(prisma, access).list("u1", "t1");
    expect(list[0].value).toBe("bar");
    expect(list[0].canWrite).toBe(true);
  });

  describe("list(?q)", () => {
    // A WRITER (ALL_PERMS) so the decrypted `value` is actually populated in the view — the exact condition
    // under which a value-oracle would be possible if `value` were searchable.
    const twoVars = () => {
      const prisma = {
        sharedVariable: {
          findMany: jest.fn().mockResolvedValue([
            { id: "v1", teamId: "t1", key: "FOO", valueEnc: "enc:bar", createdAt: new Date() },
            { id: "v2", teamId: "t1", key: "DB_PASSWORD", valueEnc: "enc:supersecret", createdAt: new Date() },
          ]),
        },
      } as unknown as PrismaService;
      const access = { permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", new Set(ALL_PERMS)]])) } as unknown as TeamAccessService;
      return make(prisma, access);
    };

    it("filters by KEY (case-insensitive)", async () => {
      expect((await twoVars().list("u1", "t1", "db")).map((v) => v.key)).toEqual(["DB_PASSWORD"]);
    });

    it("NEVER matches on the decrypted value — a query equal to a secret value returns nothing", async () => {
      expect(await twoVars().list("u1", "t1", "supersecret")).toEqual([]);
    });

    it("returns all when q is absent (non-breaking)", async () => {
      expect((await twoVars().list("u1", "t1")).length).toBe(2);
    });
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
