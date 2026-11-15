import type { ConfigService } from "@nestjs/config";
import { buildExporterCrypto, runExport } from "./export-destination-keys";
import type { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";

const crypto = { decrypt: (s: string) => { if (s === "enc:BAD") throw new Error("cannot open"); return s.replace(/^enc:/, ""); } } as unknown as CryptoService;
const d1 = { id: "d1", name: "prod s3", teamId: "t1", type: "S3", s3Bucket: "bk", s3Endpoint: "s3.x", s3Region: "r", s3Prefix: "p", encryptionEnabled: true, encryptionKey: "enc:KEY-ONE" };
const prismaOf = (rows: unknown[]) => ({ backupDestination: { findMany: jest.fn().mockResolvedValue(rows) } }) as unknown as PrismaService;
const dests = [d1];

describe("scripts/export-destination-keys runExport", () => {
  it("outputs decrypted keys with exit 0", async () => {
    const r = await runExport(prismaOf(dests), crypto, "K");
    expect(r.exitCode).toBe(0);
    expect(r.manifest.destinations[0].encryption.passphrase).toBe("KEY-ONE");
  });
  it("exit code 2 when a row is undecryptable (manifest still printed)", async () => {
    const r = await runExport(prismaOf([...dests, { ...dests[0], id: "d3", encryptionKey: "enc:BAD" }]), crypto, "K");
    expect(r.exitCode).toBe(2);
    expect(r.manifest.destinations).toHaveLength(1);
  });
  it("an empty destinations list for no encrypted destinations, exit 0", async () => {
    const r = await runExport(prismaOf([]), crypto, "K");
    expect(r.exitCode).toBe(0);
    expect(r.manifest.destinations).toEqual([]);
    expect(r.manifest.v).toBe(1);
  });
});

describe("scripts/export-destination-keys under an active data key (keyring rotated)", () => {
  const ROOT = "root-passphrase-0123456789";
  const cfg = { get: (k: string) => (k === "SECRETS_ENCRYPTION_KEY" ? ROOT : undefined) } as unknown as ConfigService;

  /** A prisma exposing just the keyring tables the PrismaKeyringStore reads, holding one ACTIVE data key. */
  async function rotated() {
    const wrapper = new CryptoService(cfg);
    await wrapper.onModuleInit();
    const dk = wrapper.generateDataKey();
    const wraps = wrapper.wrapForRoots(dk.key).map((w) => ({ keyId: dk.id, ...w }));
    const prisma = {
      secretsKeyring: { findUnique: jest.fn().mockResolvedValue({ epoch: 1 }) },
      secretsKey: { findMany: jest.fn().mockResolvedValue([{ id: dk.id, state: "ACTIVE", activatedAt: new Date(), demotedAt: null }]) },
      secretsKeyWrap: { findMany: jest.fn().mockResolvedValue(wraps) },
      backupDestination: { findMany: jest.fn() },
    };
    const live = buildExporterCrypto(cfg, prisma as unknown as PrismaService);
    await live.onModuleInit();
    return { prisma, live };
  }

  it("exports a tk1 destination key with exit 0 (the exporter's ring includes the keyring)", async () => {
    const { prisma, live } = await rotated();
    const ct = live.encrypt("KEY-AFTER-ROTATION");
    expect(ct.startsWith("tk1.")).toBe(true);
    prisma.backupDestination.findMany.mockResolvedValue([{ ...d1, encryptionKey: ct }]);
    const exporter = buildExporterCrypto(cfg, prisma as unknown as PrismaService);
    await exporter.onModuleInit();
    const r = await runExport(prisma as unknown as PrismaService, exporter, ROOT);
    expect(r.exitCode).toBe(0);
    expect(r.manifest.destinations[0].encryption.passphrase).toBe("KEY-AFTER-ROTATION");
  });

  it("an env-only ring (the old wiring) cannot read it: exit 2, which is what hub-migrate must treat as loud", async () => {
    const { prisma, live } = await rotated();
    prisma.backupDestination.findMany.mockResolvedValue([{ ...d1, encryptionKey: live.encrypt("K") }]);
    const envOnly = new CryptoService(cfg);
    await envOnly.onModuleInit();
    const r = await runExport(prisma as unknown as PrismaService, envOnly, ROOT);
    expect(r.exitCode).toBe(2);
    expect(r.manifest.destinations).toHaveLength(0);
  });
});
