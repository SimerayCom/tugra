import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { CloudCredentialsService } from "./cloud-credentials.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { CloudProviderFactory } from "./providers/provider-factory.service";

const row = { id: "cc1", name: "hz", teamId: "t1", provider: "hetzner", apiTokenEnc: "enc(TOKENVAL)", createdAt: new Date() };

function make(over: { verifyValid?: boolean; access?: Partial<TeamAccessService>; prisma?: Partial<PrismaService> } = {}) {
  const audit = { log: jest.fn() } as unknown as AuditService;
  const crypto = { encrypt: jest.fn((s: string) => `enc(${s})`), decrypt: jest.fn((s: string) => s.replace(/^enc\(|\)$/g, "")) } as unknown as CryptoService;
  const verifyToken = jest.fn().mockResolvedValue({ valid: over.verifyValid ?? true });
  const providers = { get: jest.fn().mockReturnValue({ verifyToken }) } as unknown as CloudProviderFactory;
  const access =
    over.access ?? ({ requirePermission: jest.fn().mockResolvedValue(undefined), permissionsByTeam: jest.fn() } as unknown as TeamAccessService);
  const prisma =
    over.prisma ??
    ({ cloudCredential: { create: jest.fn().mockResolvedValue(row), update: jest.fn().mockResolvedValue(row), findUnique: jest.fn().mockResolvedValue(row), delete: jest.fn() } } as unknown as PrismaService);
  const svc = new CloudCredentialsService(prisma as PrismaService, access as TeamAccessService, audit, crypto, providers);
  return { svc, prisma, access, crypto, providers, verifyToken, audit };
}

describe("CloudCredentialsService", () => {
  it("create verifies the token with the provider BEFORE persisting, then encrypts", async () => {
    const { svc, prisma, crypto, verifyToken } = make();
    const v = await svc.create("u1", { teamId: "t1", name: "hz", provider: "hetzner", apiToken: "TOKENVAL" });
    expect(verifyToken).toHaveBeenCalledWith("TOKENVAL");
    expect(crypto.encrypt).toHaveBeenCalledWith("TOKENVAL");
    const createArg = (prisma.cloudCredential!.create as jest.Mock).mock.calls[0][0];
    expect(createArg.data.apiTokenEnc).toBe("enc(TOKENVAL)");
    // the view never leaks the token or its ciphertext
    expect(JSON.stringify(v)).not.toContain("TOKENVAL");
    expect(JSON.stringify(v)).not.toContain("apiTokenEnc");
    expect(v).toMatchObject({ id: "cc1", provider: "hetzner", canWrite: true });
  });

  it("create rejects (and never persists) when the provider rejects the token", async () => {
    const { svc, prisma } = make({ verifyValid: false });
    await expect(svc.create("u1", { teamId: "t1", name: "hz", provider: "hetzner", apiToken: "bad" })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.cloudCredential!.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("update only re-encrypts + re-verifies when a new token is supplied", async () => {
    const { svc, prisma, verifyToken } = make();
    await svc.update("u1", "cc1", { name: "renamed" });
    expect(verifyToken).not.toHaveBeenCalled();
    expect((prisma.cloudCredential!.update as jest.Mock).mock.calls[0][0].data.apiTokenEnc).toBeUndefined();

    await svc.update("u1", "cc1", { apiToken: "NEWTOK" });
    expect(verifyToken).toHaveBeenCalledWith("NEWTOK");
    expect((prisma.cloudCredential!.update as jest.Mock).mock.calls[1][0].data.apiTokenEnc).toBe("enc(NEWTOK)");
  });

  it("test decrypts the stored token and re-verifies it", async () => {
    const { svc, verifyToken, crypto } = make();
    await expect(svc.test("u1", "cc1")).resolves.toEqual({ ok: true });
    expect(crypto.decrypt).toHaveBeenCalledWith("enc(TOKENVAL)");
    expect(verifyToken).toHaveBeenCalledWith("TOKENVAL");
  });

  it("forbids a non-integrations member from creating", async () => {
    const access = { requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("nope")) } as unknown as TeamAccessService;
    const { svc } = make({ access });
    await expect(svc.create("u1", { teamId: "t1", name: "x", provider: "hetzner", apiToken: "t" })).rejects.toBeInstanceOf(ForbiddenException);
  });
});
