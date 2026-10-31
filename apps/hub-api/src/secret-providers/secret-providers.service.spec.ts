import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { SecretProvidersService } from "./secret-providers.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { VaultApiClient } from "./vault-api.client";

const row = {
  id: "sp1",
  name: "vault",
  teamId: "t1",
  kind: "vault",
  address: "https://vault.example.com",
  tokenEnc: "enc(TOKENVAL)",
  lastVerifiedAt: null,
  createdAt: new Date(),
  _count: { refs: 0 },
};

function make(
  over: {
    verifyValid?: boolean;
    verifyThrows?: boolean;
    refCount?: number;
    access?: Partial<TeamAccessService>;
    prisma?: Partial<PrismaService>;
  } = {},
) {
  const audit = { log: jest.fn() } as unknown as AuditService;
  const crypto = {
    encrypt: jest.fn((s: string) => `enc(${s})`),
    decrypt: jest.fn((s: string) => s.replace(/^enc\(|\)$/g, "")),
  } as unknown as CryptoService;
  const verify = over.verifyThrows
    ? jest.fn().mockRejectedValue(new Error("unreachable"))
    : jest.fn().mockResolvedValue({ valid: over.verifyValid ?? true });
  const vault = { verify } as unknown as VaultApiClient;
  const access =
    over.access ??
    ({ requirePermission: jest.fn().mockResolvedValue(undefined), permissionsByTeam: jest.fn() } as unknown as TeamAccessService);
  const prisma =
    over.prisma ??
    ({
      secretProvider: {
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
        findUnique: jest.fn().mockResolvedValue(row),
        findMany: jest.fn().mockResolvedValue([row]),
        delete: jest.fn(),
      },
      secretRef: { count: jest.fn().mockResolvedValue(over.refCount ?? 0) },
    } as unknown as PrismaService);
  const svc = new SecretProvidersService(prisma as PrismaService, access as TeamAccessService, audit, crypto, vault);
  return { svc, prisma, access, crypto, vault, verify, audit };
}

describe("SecretProvidersService", () => {
  it("create verifies the token against the store BEFORE persisting, encrypts it, stamps lastVerifiedAt, and never leaks it", async () => {
    const { svc, prisma, crypto, verify } = make();
    const v = await svc.create("u1", { teamId: "t1", name: "vault", kind: "vault", address: "https://vault.example.com", token: "TOKENVAL" });
    expect(verify).toHaveBeenCalledWith("https://vault.example.com", "TOKENVAL");
    expect(crypto.encrypt).toHaveBeenCalledWith("TOKENVAL");
    const createArg = (prisma.secretProvider!.create as jest.Mock).mock.calls[0][0];
    expect(createArg.data.tokenEnc).toBe("enc(TOKENVAL)");
    expect(createArg.data.lastVerifiedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(v)).not.toContain("TOKENVAL");
    expect(JSON.stringify(v)).not.toContain("tokenEnc");
    expect(v).toMatchObject({ id: "sp1", kind: "vault", canWrite: true, refCount: 0 });
  });

  it("create requires 'integrations' and does NOT persist when the store rejects the token", async () => {
    const requirePermission = jest.fn().mockResolvedValue(undefined);
    const { svc, prisma } = make({ verifyValid: false, access: { requirePermission } as unknown as TeamAccessService });
    await expect(
      svc.create("u1", { teamId: "t1", name: "vault", kind: "vault", address: "https://vault.example.com", token: "bad" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "integrations");
    expect(prisma.secretProvider!.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("create rejects (no persist) when the store is unreachable", async () => {
    const { svc, prisma } = make({ verifyThrows: true });
    await expect(
      svc.create("u1", { teamId: "t1", name: "vault", kind: "vault", address: "https://vault.example.com", token: "x" }),
    ).rejects.toThrow(/could not reach/);
    expect(prisma.secretProvider!.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("update only re-encrypts + re-verifies when a new token is supplied", async () => {
    const { svc, prisma, verify } = make();
    await svc.update("u1", "sp1", { name: "renamed" });
    expect(verify).not.toHaveBeenCalled();
    const d1 = (prisma.secretProvider!.update as jest.Mock).mock.calls[0][0].data;
    expect(d1.tokenEnc).toBeUndefined();
    expect(d1.lastVerifiedAt).toBeUndefined();

    const { svc: svc2, verify: verify2 } = make();
    await svc2.update("u1", "sp1", { token: "NEWTOK" });
    expect(verify2).toHaveBeenCalledWith("https://vault.example.com", "NEWTOK");
  });

  it("update re-verifies the stored token against a changed address", async () => {
    const { svc, verify, crypto } = make();
    await svc.update("u1", "sp1", { address: "https://vault-2.example.com" });
    expect(crypto.decrypt).toHaveBeenCalledWith("enc(TOKENVAL)");
    expect(verify).toHaveBeenCalledWith("https://vault-2.example.com", "TOKENVAL");
  });

  it("remove is blocked (409) while refs still point at the provider", async () => {
    const { svc, prisma } = make({ refCount: 2 });
    await expect(svc.remove("u1", "sp1")).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.secretProvider!.delete as jest.Mock).not.toHaveBeenCalled();
  });

  it("remove deletes when no refs remain", async () => {
    const { svc, prisma } = make({ refCount: 0 });
    await svc.remove("u1", "sp1");
    expect(prisma.secretProvider!.delete as jest.Mock).toHaveBeenCalledWith({ where: { id: "sp1" } });
  });

  it("test re-verifies the stored token and refreshes lastVerifiedAt", async () => {
    const { svc, prisma, verify } = make();
    await svc.test("u1", "sp1");
    expect(verify).toHaveBeenCalledWith("https://vault.example.com", "TOKENVAL");
    expect((prisma.secretProvider!.update as jest.Mock).mock.calls[0][0].data.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("missing provider is a 404 on update/remove/test", async () => {
    const prisma = {
      secretProvider: { findUnique: jest.fn().mockResolvedValue(null) },
      secretRef: { count: jest.fn() },
    } as unknown as PrismaService;
    const { svc } = make({ prisma });
    await expect(svc.update("u1", "nope", { name: "x" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.remove("u1", "nope")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.test("u1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });
});
