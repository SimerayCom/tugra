import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DnsCredentialsService } from "./dns-credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { CloudflareApiClient } from "../tunnel/cloudflare-api.client";

const row = { id: "dc1", name: "cf", teamId: "t1", provider: "cloudflare", apiTokenEnc: "enc(TOKENVAL)", cfAccountId: null, lastVerifiedAt: null, createdAt: new Date() };

function make(over: { verifyValid?: boolean; access?: Partial<TeamAccessService>; prisma?: Partial<PrismaService> } = {}) {
  const audit = { log: jest.fn() } as unknown as AuditService;
  const crypto = { encrypt: jest.fn((s: string) => `enc(${s})`), decrypt: jest.fn((s: string) => s.replace(/^enc\(|\)$/g, "")) } as unknown as CryptoService;
  const verifyToken = jest.fn().mockResolvedValue({ valid: over.verifyValid ?? true });
  const cf = { verifyToken } as unknown as CloudflareApiClient;
  const access =
    over.access ??
    ({ requirePermission: jest.fn().mockResolvedValue(undefined), permissionsByTeam: jest.fn() } as unknown as TeamAccessService);
  const prisma =
    over.prisma ??
    ({
      dnsCredential: {
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
        findUnique: jest.fn().mockResolvedValue(row),
        findMany: jest.fn().mockResolvedValue([row]),
        delete: jest.fn(),
      },
    } as unknown as PrismaService);
  const svc = new DnsCredentialsService(prisma as PrismaService, access as TeamAccessService, audit, crypto, cf);
  return { svc, prisma, access, crypto, cf, verifyToken, audit };
}

describe("DnsCredentialsService", () => {
  it("create verifies the token with Cloudflare BEFORE persisting, encrypts it, stamps lastVerifiedAt", async () => {
    const { svc, prisma, crypto, verifyToken } = make();
    const v = await svc.create("u1", { teamId: "t1", name: "cf", provider: "cloudflare", apiToken: "TOKENVAL" });
    expect(verifyToken).toHaveBeenCalledWith("TOKENVAL", undefined);
    expect(crypto.encrypt).toHaveBeenCalledWith("TOKENVAL");
    const createArg = (prisma.dnsCredential!.create as jest.Mock).mock.calls[0][0];
    expect(createArg.data.apiTokenEnc).toBe("enc(TOKENVAL)");
    expect(createArg.data.lastVerifiedAt).toBeInstanceOf(Date);
    // the view never leaks the token or its ciphertext
    expect(JSON.stringify(v)).not.toContain("TOKENVAL");
    expect(JSON.stringify(v)).not.toContain("apiTokenEnc");
    expect(v).toMatchObject({ id: "dc1", provider: "cloudflare", canWrite: true });
  });

  it("create forwards cfAccountId to verifyToken so account-owned tokens verify at the account endpoint", async () => {
    const { svc, verifyToken } = make();
    await svc.create("u1", { teamId: "t1", name: "cf", provider: "cloudflare", apiToken: "ACCTOK", cfAccountId: "acc123" });
    expect(verifyToken).toHaveBeenCalledWith("ACCTOK", "acc123");
  });

  it("create requires the 'integrations' permission and rejects (no persist) when Cloudflare rejects the token", async () => {
    const requirePermission = jest.fn().mockResolvedValue(undefined);
    const { svc, prisma } = make({ verifyValid: false, access: { requirePermission } as unknown as TeamAccessService });
    await expect(svc.create("u1", { teamId: "t1", name: "cf", provider: "cloudflare", apiToken: "bad" })).rejects.toBeInstanceOf(BadRequestException);
    expect(requirePermission).toHaveBeenCalledWith("u1", "t1", "integrations");
    expect(prisma.dnsCredential!.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("update only re-encrypts + re-verifies (and refreshes lastVerifiedAt) when a new token is supplied", async () => {
    const { svc, prisma, verifyToken } = make();
    await svc.update("u1", "dc1", { name: "renamed" });
    expect(verifyToken).not.toHaveBeenCalled();
    const d1 = (prisma.dnsCredential!.update as jest.Mock).mock.calls[0][0].data;
    expect(d1.apiTokenEnc).toBeUndefined();
    expect(d1.lastVerifiedAt).toBeUndefined();

    await svc.update("u1", "dc1", { apiToken: "NEWTOK" });
    expect(verifyToken).toHaveBeenCalledWith("NEWTOK", undefined); // no incoming cfAccountId; stored is null → user-token path
    const d2 = (prisma.dnsCredential!.update as jest.Mock).mock.calls[1][0].data;
    expect(d2.apiTokenEnc).toBe("enc(NEWTOK)");
    expect(d2.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it("list returns team creds with canWrite from the 'integrations' permission, never the token", async () => {
    const permissionsByTeam = jest.fn().mockResolvedValue(new Map([["t1", new Set(["integrations"])]]));
    const prisma = { dnsCredential: { findMany: jest.fn().mockResolvedValue([row]) } } as unknown as PrismaService;
    const { svc } = make({ access: { permissionsByTeam } as unknown as TeamAccessService, prisma });
    const out = await svc.list("u1");
    expect(out).toEqual([expect.objectContaining({ id: "dc1", provider: "cloudflare", canWrite: true })]);
    expect(JSON.stringify(out)).not.toContain("apiTokenEnc");
  });

  it("test re-verifies the stored (decrypted) token and refreshes lastVerifiedAt", async () => {
    const { svc, prisma, verifyToken, crypto } = make();
    await expect(svc.test("u1", "dc1")).resolves.toEqual({ ok: true });
    expect(crypto.decrypt).toHaveBeenCalledWith("enc(TOKENVAL)");
    expect(verifyToken).toHaveBeenCalledWith("TOKENVAL", undefined); // stored cfAccountId is null → user-token path
    expect((prisma.dnsCredential!.update as jest.Mock).mock.calls[0][0].data).toEqual({ lastVerifiedAt: expect.any(Date) });
  });

  it("remove / update / test 404 when the credential is missing", async () => {
    const prisma = { dnsCredential: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    const { svc } = make({ prisma });
    await expect(svc.remove("u1", "nope")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.update("u1", "nope", { name: "x" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.test("u1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });
});
