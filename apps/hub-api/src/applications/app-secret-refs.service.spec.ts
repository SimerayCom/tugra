import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { Application } from "@prisma/client";
import { AppSecretRefsService } from "./app-secret-refs.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { VaultApiClient } from "../secret-providers/vault-api.client";

const provider = { id: "sp1", teamId: "t1", name: "prod-vault", kind: "vault", address: "https://vault.example.com", tokenEnc: "enc(VTOK)" };
const app = { id: "a1", teamId: "t1", isPreview: false, environmentId: "e1", envEnc: null } as unknown as Application;

function make(
  over: {
    refs?: Array<{ id: string; envVar: string; providerId: string; remoteKey: string; provider: typeof provider | null; createdAt?: Date }>;
    fetchImpl?: jest.Mock;
    findProvider?: jest.Mock;
    findRefUnique?: jest.Mock;
    findRefFirst?: jest.Mock;
    findDbLink?: jest.Mock;
  } = {},
) {
  const audit = { log: jest.fn() } as unknown as AuditService;
  const crypto = { decrypt: jest.fn((s: string) => s.replace(/^enc\(|\)$/g, "")) } as unknown as CryptoService;
  const fetchSecret = over.fetchImpl ?? jest.fn().mockResolvedValue("s3cr3t");
  const vault = { fetchSecret } as unknown as VaultApiClient;
  const access = {
    requirePermission: jest.fn().mockResolvedValue(undefined),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined), // does not invoke the resolveProjectId callback
  } as unknown as TeamAccessService;
  const prisma = {
    application: { findUnique: jest.fn().mockResolvedValue(app) },
    secretProvider: { findFirst: over.findProvider ?? jest.fn().mockResolvedValue(provider) },
    secretRef: {
      findMany: jest.fn().mockResolvedValue(
        (over.refs ?? []).map((r) => ({ createdAt: new Date(), createdBy: "u1", appId: "a1", ...r })),
      ),
      findUnique: over.findRefUnique ?? jest.fn().mockResolvedValue(null),
      findFirst: over.findRefFirst ?? jest.fn(),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: "ref-new", createdAt: new Date(), provider, ...data }),
      ),
      delete: jest.fn(),
    },
    appDatabaseLink: { findUnique: over.findDbLink ?? jest.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;
  const svc = new AppSecretRefsService(prisma, access, audit, crypto, vault);
  return { svc, prisma, access, crypto, vault, fetchSecret, audit };
}

describe("AppSecretRefsService.resolveSecretEnv", () => {
  it("returns {} for a preview app (no refs of its own in v1)", async () => {
    const { svc, prisma } = make();
    const env = await svc.resolveSecretEnv({ ...app, isPreview: true });
    expect(env).toEqual({});
    expect(prisma.secretRef!.findMany as jest.Mock).not.toHaveBeenCalled();
  });

  it("returns {} when the app has no refs", async () => {
    const { svc } = make({ refs: [] });
    expect(await svc.resolveSecretEnv(app)).toEqual({});
  });

  it("fetches each ref through Vault (decrypting the provider token) and maps envVar -> value", async () => {
    const { svc, fetchSecret, crypto } = make({
      refs: [
        { id: "r1", envVar: "DB_PASSWORD", providerId: "sp1", remoteKey: "secret/app#DB_PASSWORD", provider },
        { id: "r2", envVar: "API_KEY", providerId: "sp1", remoteKey: "secret/app#API_KEY", provider },
      ],
      fetchImpl: jest.fn().mockResolvedValueOnce("pw").mockResolvedValueOnce("key"),
    });
    const env = await svc.resolveSecretEnv(app);
    expect(env.DB_PASSWORD).toBe("pw");
    expect(env.API_KEY).toBe("key");
    expect(crypto.decrypt).toHaveBeenCalledWith("enc(VTOK)");
    expect(fetchSecret).toHaveBeenCalledWith("https://vault.example.com", "VTOK", "secret/app#DB_PASSWORD");
  });

  it("FAILS the deploy loudly when a fetch throws — naming the env var + provider, never the value", async () => {
    const { svc } = make({
      refs: [{ id: "r1", envVar: "DB_PASSWORD", providerId: "sp1", remoteKey: "secret/app#DB_PASSWORD", provider }],
      fetchImpl: jest.fn().mockRejectedValue(new Error("Vault secret not found at \"secret/app\"")),
    });
    const err = await svc.resolveSecretEnv(app).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toContain("DB_PASSWORD");
    expect((err as Error).message).toContain("prod-vault");
  });

  it("FAILS the deploy when a fetched value contains a newline (env-file injection guard), without echoing the value", async () => {
    const { svc } = make({
      refs: [{ id: "r1", envVar: "DB_PASSWORD", providerId: "sp1", remoteKey: "secret/app#DB_PASSWORD", provider }],
      fetchImpl: jest.fn().mockResolvedValue("x\nPATH=/evil"),
    });
    const err = await svc.resolveSecretEnv(app).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toContain("DB_PASSWORD");
    expect((err as Error).message).not.toContain("/evil"); // value never echoed
  });

  it("fails when a ref's provider is in another team", async () => {
    const foreign = { ...provider, teamId: "t2" };
    const { svc } = make({ refs: [{ id: "r1", envVar: "X", providerId: "sp1", remoteKey: "secret/app#X", provider: foreign }] });
    await expect(svc.resolveSecretEnv(app)).rejects.toThrow(/not in this app's team/);
  });

  it("fails for an unsupported provider kind", async () => {
    const weird = { ...provider, kind: "doppler" };
    const { svc } = make({ refs: [{ id: "r1", envVar: "X", providerId: "sp1", remoteKey: "x", provider: weird }] });
    await expect(svc.resolveSecretEnv(app)).rejects.toThrow(/unsupported secret provider kind/);
  });
});

describe("AppSecretRefsService.create", () => {
  it("binds a secret and audits WITHOUT the locator or value", async () => {
    const { svc, prisma, audit } = make();
    const v = await svc.create("u1", "a1", { providerId: "sp1", envVar: "DB_PASSWORD", remoteKey: "secret/app#DB_PASSWORD" });
    expect(v).toMatchObject({ envVar: "DB_PASSWORD", providerId: "sp1", providerName: "prod-vault", kind: "vault" });
    const auditMeta = (audit.log as jest.Mock).mock.calls.at(-1)![0].meta;
    expect(JSON.stringify(auditMeta)).not.toContain("secret/app"); // remoteKey never audited
    expect(prisma.secretRef!.create as jest.Mock).toHaveBeenCalled();
  });

  it("rejects an invalid env var name (no persist)", async () => {
    const { svc, prisma } = make();
    await expect(svc.create("u1", "a1", { providerId: "sp1", envVar: "BAD-KEY", remoteKey: "secret/app#X" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create("u1", "a1", { providerId: "sp1", envVar: "PATH", remoteKey: "secret/app#X" })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.secretRef!.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("rejects a malformed Vault locator up front (no persist)", async () => {
    const { svc, prisma } = make();
    await expect(svc.create("u1", "a1", { providerId: "sp1", envVar: "DB_PASSWORD", remoteKey: "no-hash-here" })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.secretRef!.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("404 when the provider is not in the app's team", async () => {
    const { svc } = make({ findProvider: jest.fn().mockResolvedValue(null) });
    await expect(svc.create("u1", "a1", { providerId: "other", envVar: "X", remoteKey: "secret/app#X" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("requires 'integrations' on the provider's team", async () => {
    const { svc, access } = make();
    await svc.create("u1", "a1", { providerId: "sp1", envVar: "DB_PASSWORD", remoteKey: "secret/app#DB_PASSWORD" });
    expect(access.requirePermission).toHaveBeenCalledWith("u1", "t1", "integrations");
  });

  it("conflict when the env var is already bound", async () => {
    const { svc } = make({ findRefUnique: jest.fn().mockResolvedValue({ id: "existing" }) });
    await expect(svc.create("u1", "a1", { providerId: "sp1", envVar: "DB_PASSWORD", remoteKey: "secret/app#DB_PASSWORD" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("conflict when the env var is already used by a database link (would silently override the DB URI)", async () => {
    const { svc, prisma } = make({ findDbLink: jest.fn().mockResolvedValue({ id: "dl1", envVar: "DATABASE_URL" }) });
    await expect(svc.create("u1", "a1", { providerId: "sp1", envVar: "DATABASE_URL", remoteKey: "secret/app#DATABASE_URL" })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.secretRef!.create as jest.Mock).not.toHaveBeenCalled();
  });
});

describe("AppSecretRefsService.remove", () => {
  it("404 for a foreign ref id", async () => {
    const { svc } = make({ findRefFirst: jest.fn().mockResolvedValue(null) });
    await expect(svc.remove("u1", "a1", "nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("deletes and audits an owned ref", async () => {
    const { svc, prisma, audit } = make({ findRefFirst: jest.fn().mockResolvedValue({ id: "r1", appId: "a1", providerId: "sp1", envVar: "DB_PASSWORD" }) });
    await svc.remove("u1", "a1", "r1");
    expect(prisma.secretRef!.delete as jest.Mock).toHaveBeenCalledWith({ where: { id: "r1" } });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.secret_ref.delete" }));
  });
});
