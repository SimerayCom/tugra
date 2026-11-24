import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubBackupRunnerService } from "./hub-backup-runner.service";
import { HubBackupSchedulerService } from "./hub-backup-scheduler.service";
import { HubBackupService } from "./hub-backup.service";
import { DestinationKeysExportService } from "./destination-keys-export.service";
import { DestinationKeysExportSchema, HubBackupConfigSchema } from "./dto";
import { hubBackupPassphrase } from "./hub-backup-script";
import { buildKeyManifest, sealOpensslCompatible } from "../destinations/key-manifest";
import { LOCAL_DEST } from "../backups/destination";
import { GIB } from "../backups/retention";
import type { PrismaService } from "../prisma/prisma.service";
import type { CryptoService } from "../crypto/crypto.service";
import type { AuditService } from "../audit/audit.service";
import type { ConfigService } from "@nestjs/config";

const DAY = 86_400_000;

describe("HubBackupConfigSchema — cron + retention", () => {
  const base = { enabled: true, intervalHours: 24, retention: 7 };
  it("accepts cron (1h floor), retentionDays and maxSizeGb, nullable; stays strict", () => {
    expect(HubBackupConfigSchema.safeParse({ ...base, cron: "0 3 * * *", retentionDays: 30, maxSizeGb: 20 }).success).toBe(true);
    expect(HubBackupConfigSchema.safeParse({ ...base, cron: null, retentionDays: null, maxSizeGb: null }).success).toBe(true);
    expect(HubBackupConfigSchema.safeParse({ ...base, cron: "*/10 * * * *" }).success).toBe(false);
    expect(HubBackupConfigSchema.safeParse({ ...base, maxSizeGb: 0 }).success).toBe(false);
    expect(HubBackupConfigSchema.safeParse({ ...base, surprise: 1 }).success).toBe(false);
  });
});

describe("HubBackupService.update — persists the new fields only when sent", () => {
  function make() {
    const upsert = jest.fn().mockResolvedValue({ id: "singleton", enabled: true, intervalHours: 24, cron: "0 3 * * *" });
    const prisma = {
      hubBackupConfig: { findUnique: jest.fn().mockResolvedValue(null), upsert },
      hubBackup: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const runner = { localServer: jest.fn().mockResolvedValue({ id: "s", teamId: "t1", capabilities: ["backup"] }) };
    const apply = jest.fn();
    const svc = new HubBackupService(prisma, { log: jest.fn() } as unknown as AuditService, {} as never, runner as never, { apply } as never, {} as never, { list: jest.fn().mockResolvedValue([]) } as never, { get: jest.fn() } as never);
    return { svc, upsert, apply };
  }
  it("absent leaves, null clears, a value sets; the scheduler gets the cron", async () => {
    const t = make();
    await t.svc.update("u1", { enabled: true, intervalHours: 24, retention: 7 });
    expect(t.upsert.mock.calls[0][0].update).not.toHaveProperty("cron");
    expect(t.upsert.mock.calls[0][0].update).not.toHaveProperty("maxSizeGb");
    await t.svc.update("u1", { enabled: true, intervalHours: 24, retention: 7, cron: null, retentionDays: 14, maxSizeGb: 5 });
    expect(t.upsert.mock.calls[1][0].update).toMatchObject({ cron: null, retentionDays: 14, maxSizeGb: 5 });
    expect(t.apply).toHaveBeenCalled();
  });
});

describe("HubBackupRunnerService.prune — age and size", () => {
  const row = (id: string, ageDays: number, gb: number | null) => ({
    id, filename: `${id}.gpg`, destinationId: null, status: "SUCCESS",
    createdAt: new Date(Date.now() - ageDays * DAY), sizeBytes: gb == null ? null : BigInt(gb) * GIB,
  });
  function make(rows: unknown[]) {
    const del = jest.fn().mockResolvedValue({});
    const prisma = {
      hubBackup: {
        findMany: jest.fn().mockImplementation(({ where }) => Promise.resolve(where.status === "SUCCESS" ? rows : [])),
        delete: del,
        deleteMany: jest.fn(),
      },
    } as unknown as PrismaService;
    const send = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const svc = new HubBackupRunnerService(prisma, {} as never, { sendCommand: send } as never, {} as never, { destinationSpecById: jest.fn().mockResolvedValue(LOCAL_DEST) } as never, {} as ConfigService);
    return { svc, del, send };
  }

  it("default keep-N behaves as before (newest `retention` survive)", async () => {
    const { svc, del } = make([row("a", 1, 1), row("b", 2, 1), row("c", 3, 1)]);
    await svc.prune({ retention: 2, retentionDays: null, maxSizeGb: null }, "s1");
    expect(del.mock.calls.map((c) => c[0].where.id)).toEqual(["c"]);
  });

  it("deletes by age and by total size (oldest first), never the newest", async () => {
    const { svc, del } = make([row("a", 1, 4), row("b", 5, 4), row("c", 20, 4), row("d", 25, 4)]);
    await svc.prune({ retention: 10, retentionDays: 10, maxSizeGb: 5 }, "s1");
    // age: c, d out. size: a+b = 8 > 5 -> b out (a protected)
    expect(del.mock.calls.map((c) => c[0].where.id).sort()).toEqual(["b", "c", "d"]);
  });
});

describe("HubBackupSchedulerService.apply — cron", () => {
  it("is covered in hub-backup-scheduler.service.spec.ts", () => {
    expect(typeof HubBackupSchedulerService.prototype.applySafe).toBe("function");
  });
});

// ── destination key export ──
const crypto = { decrypt: (s: string) => { if (s === "enc:BAD") throw new Error("cannot open"); return s.replace(/^enc:/, ""); } } as unknown as CryptoService;
const dests = [
  { id: "d1", name: "prod s3", teamId: "t1", type: "S3", s3Bucket: "bk", s3Endpoint: "s3.x", s3Region: "r", s3Prefix: "p", s3AccessKey: "enc:AK", s3SecretKey: "enc:SK", encryptionEnabled: true, encryptionKey: "enc:KEY-ONE" },
  { id: "d2", name: "disk", teamId: "t1", type: "LOCAL", s3Bucket: null, s3Endpoint: null, s3Region: null, s3Prefix: null, s3AccessKey: null, s3SecretKey: null, encryptionEnabled: true, encryptionKey: "enc:KEY-TWO" },
];
const prismaOf = (rows: unknown[]) => ({ backupDestination: { findMany: jest.fn().mockResolvedValue(rows) } }) as unknown as PrismaService;

describe("buildKeyManifest", () => {
  it("lists encrypted destinations with decrypted keys + a fingerprint, the hub passphrase, and NO S3 credentials", async () => {
    const prisma = prismaOf(dests);
    const { manifest, undecryptable } = await buildKeyManifest(prisma, crypto, "SECRETKEY");
    expect(undecryptable).toEqual([]);
    expect(manifest.v).toBe(1);
    expect(manifest.destinations.map((d) => [d.id, d.encryption.passphrase])).toEqual([["d1", "KEY-ONE"], ["d2", "KEY-TWO"]]);
    expect(manifest.destinations[0].encryption.sha256).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.destinations[0].s3).toEqual({ bucket: "bk", endpoint: "s3.x", region: "r", prefix: "p" });
    expect(manifest.destinations[1].s3).toBeNull();
    expect(manifest.hubBackup.passphrase).toBe(hubBackupPassphrase("SECRETKEY"));
    expect(JSON.stringify(manifest)).not.toMatch(/"AK"|"SK"|accessKey|secretKey/);
    // only encrypted rows are requested
    expect((prisma.backupDestination.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({ encryptionEnabled: true });
  });

  it("never silently omits an undecryptable row: it is reported by id", async () => {
    const { manifest, undecryptable } = await buildKeyManifest(prismaOf([...dests, { ...dests[0], id: "d3", encryptionKey: "enc:BAD" }]), crypto, "K");
    expect(undecryptable).toEqual(["d3"]);
    expect(manifest.destinations).toHaveLength(2);
  });
});

describe("sealOpensslCompatible", () => {
  it("produces the openssl enc layout and round-trips with node:crypto", () => {
    const sealed = sealOpensslCompatible(Buffer.from("hello keys"), "a-long-passphrase", Buffer.from("saltsalt"));
    expect(sealed.subarray(0, 8).toString()).toBe("Salted__");
    expect(sealed.subarray(8, 16).toString()).toBe("saltsalt");
    expect(sealed.length % 16).toBe(0);
  });

  const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;
  (hasOpenssl ? it : it.skip)("opens with `openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256`", () => {
    const dir = mkdtempSync(join(tmpdir(), "tugra-seal-"));
    try {
      const file = join(dir, "keys.enc");
      writeFileSync(file, sealOpensslCompatible(Buffer.from('{"v":1,"k":"secret"}'), "correct horse battery"));
      const out = execFileSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "600000", "-md", "sha256", "-in", file, "-pass", "pass:correct horse battery"]);
      expect(out.toString()).toBe('{"v":1,"k":"secret"}');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DestinationKeysExportService.exportSealed", () => {
  function make(rows: unknown[]) {
    const audit = { log: jest.fn() };
    const config = { get: () => "SECRETKEY" } as unknown as ConfigService;
    return { svc: new DestinationKeysExportService(prismaOf(rows), audit as unknown as AuditService, crypto, config), audit };
  }
  it("returns the sealed file + count + undecryptable ids, and audits the COUNT only (no passphrase / key)", async () => {
    const { svc, audit } = make([...dests, { ...dests[0], id: "d3", encryptionKey: "enc:BAD" }]);
    const res = await svc.exportSealed("u1", "my-sealing-passphrase");
    expect(res.filename).toMatch(/^tugra-destination-keys-\d{8}\.enc$/);
    expect(res.format).toBe("openssl-aes-256-cbc-pbkdf2-sha256-600000");
    expect(res.destinationCount).toBe(2);
    expect(res.undecryptable).toEqual(["d3"]);
    expect(Buffer.from(res.contentBase64, "base64").subarray(0, 8).toString()).toBe("Salted__");
    const logged = JSON.stringify(audit.log.mock.calls);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "instance.backup.keys_export", meta: { count: 2 } }));
    expect(logged).not.toContain("my-sealing-passphrase");
    expect(logged).not.toContain("KEY-ONE");
  });
});

describe("DestinationKeysExportSchema", () => {
  it("rejects a passphrase under 12 characters, and unknown keys", () => {
    expect(DestinationKeysExportSchema.safeParse({ passphrase: "short" }).success).toBe(false);
    expect(DestinationKeysExportSchema.safeParse({ passphrase: "long enough pass" }).success).toBe(true);
    expect(DestinationKeysExportSchema.safeParse({ passphrase: "long enough pass", x: 1 }).success).toBe(false);
  });
});

describe("HubBackupController (owner-only export route)", () => {
  it("sits behind JwtAuthGuard + InstanceOwnerGuard (non-owners get 403 from the guard)", () => {
    const { HubBackupController } = jest.requireActual("./hub-backup.controller") as typeof import("./hub-backup.controller");
    const guards = Reflect.getMetadata("__guards__", HubBackupController) as Array<{ name: string }>;
    expect(guards.map((g) => g.name)).toEqual(["JwtAuthGuard", "InstanceOwnerGuard"]);
    const route = Reflect.getMetadata("path", HubBackupController.prototype.exportKeys);
    expect(route).toBe("destination-keys/export");
  });
});
