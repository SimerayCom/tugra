import { ConflictException } from "@nestjs/common";
import { DestinationsService } from "./destinations.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { CreateDestinationSchema, UpdateDestinationSchema } from "./dto";

const audit = { log: jest.fn() };
const crypto = {
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
} as unknown as CryptoService;
const access = {
  requirePermission: jest.fn().mockResolvedValue(undefined),
  teamRole: jest.fn().mockResolvedValue("OWNER"),
} as unknown as TeamAccessService;

const svcOf = (prisma: unknown, agentWs: unknown = {}) =>
  new DestinationsService(prisma as PrismaService, access, audit as unknown as AuditService, crypto, agentWs as AgentWsServer);

const input = { teamId: "t1", name: "d", type: "S3" as const, s3Bucket: "b", s3Endpoint: "s3.x", s3AccessKey: "AK", s3SecretKey: "SK" };

function createPrisma() {
  const saved: { data?: Record<string, unknown> } = {};
  const prisma = {
    backupDestination: {
      create: jest.fn().mockImplementation(({ data }) => {
        saved.data = data;
        return Promise.resolve({ id: "d1", createdAt: new Date(), ...data });
      }),
    },
  };
  return { prisma, saved };
}

describe("DestinationsService.create — encryption default-on", () => {
  beforeEach(() => audit.log.mockClear());

  it("an omitted flag generates a key, stores ciphertext (not plaintext) and returns the plaintext ONCE", async () => {
    const { prisma, saved } = createPrisma();
    const res = await svcOf(prisma).create("u1", input);
    expect(res.encryptionEnabled).toBe(true);
    expect(res.recoveryKey).toEqual(expect.any(String));
    expect(res.recoveryKey!.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    expect(saved.data!.encryptionKey).not.toBe(res.recoveryKey);
    expect(crypto.decrypt(saved.data!.encryptionKey as string)).toBe(res.recoveryKey);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "destination.create", meta: { encrypted: true } }));
    // the key never reaches the audit entry
    expect(JSON.stringify(audit.log.mock.calls)).not.toContain(res.recoveryKey!);
  });

  it("an explicit false is honoured: no key stored, recoveryKey null, no refusal", async () => {
    const { prisma, saved } = createPrisma();
    const res = await svcOf(prisma).create("u1", { ...input, encryptionEnabled: false });
    expect(res.encryptionEnabled).toBe(false);
    expect(res.recoveryKey).toBeNull();
    expect(saved.data!.encryptionKey).toBeNull();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ meta: { encrypted: false } }));
  });

  it("a LOCAL destination encrypts by default too", async () => {
    const { prisma, saved } = createPrisma();
    const res = await svcOf(prisma).create("u1", { teamId: "t1", name: "disk", type: "LOCAL" });
    expect(res.encryptionEnabled).toBe(true);
    expect(res.recoveryKey).toBeTruthy();
    expect(saved.data!.encryptionEnabled).toBe(true);
  });

  it("every create gets a distinct key", async () => {
    const { prisma } = createPrisma();
    const a = await svcOf(prisma).create("u1", input);
    const b = await svcOf(prisma).create("u1", input);
    expect(a.recoveryKey).not.toBe(b.recoveryKey);
  });

  it("get() never returns the key", async () => {
    const prisma = {
      backupDestination: { findUnique: jest.fn().mockResolvedValue({ id: "d1", teamId: "t1", type: "S3", encryptionEnabled: true, encryptionKey: "enc:SECRETKEY", createdAt: new Date() }) },
      // permissionsByTeam is read by get()
    };
    const a = { ...access, permissionsByTeam: jest.fn().mockResolvedValue(new Map()) } as unknown as TeamAccessService;
    const svc = new DestinationsService(prisma as unknown as PrismaService, a, audit as unknown as AuditService, crypto, {} as AgentWsServer);
    const view = await svc.get("u1", "d1");
    expect(JSON.stringify(view)).not.toContain("SECRETKEY");
    expect(view).not.toHaveProperty("recoveryKey");
    expect(view).not.toHaveProperty("encryptionKey");
  });

  it("the schema leaves the flag optional (the default lives in the service) and update stays strict", () => {
    expect(CreateDestinationSchema.parse(input).encryptionEnabled).toBeUndefined();
    expect(UpdateDestinationSchema.safeParse({ encryptionEnabled: false }).success).toBe(false);
    expect(UpdateDestinationSchema.safeParse({ encryptionKey: "x" }).success).toBe(false);
  });
});

describe("DestinationsService.remove — delete guard", () => {
  function make(opts: { encrypted: boolean; counts?: { backup?: number; volume?: number; base?: number }; pitr?: number }) {
    const dest = { id: "d1", teamId: "t1", type: "S3", encryptionEnabled: opts.encrypted };
    const del = jest.fn().mockResolvedValue(dest);
    const dbUpdate = jest.fn().mockResolvedValue({});
    const appUpdate = jest.fn().mockResolvedValue({});
    const hubUpdate = jest.fn().mockResolvedValue({});
    const hubBackupCount = jest.fn().mockResolvedValue(99);
    const prisma = {
      backupDestination: { findUnique: jest.fn().mockResolvedValue(dest), delete: del },
      database: { count: jest.fn().mockResolvedValue(opts.pitr ?? 0), updateMany: dbUpdate },
      application: { updateMany: appUpdate },
      hubBackupConfig: { updateMany: hubUpdate },
      hubBackup: { count: hubBackupCount },
      backup: { count: jest.fn().mockResolvedValue(opts.counts?.backup ?? 0) },
      volumeBackup: { count: jest.fn().mockResolvedValue(opts.counts?.volume ?? 0) },
      baseBackup: { count: jest.fn().mockResolvedValue(opts.counts?.base ?? 0) },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    return { svc: svcOf(prisma), prisma, del, dbUpdate, appUpdate, hubUpdate, hubBackupCount };
  }

  beforeEach(() => audit.log.mockClear());

  it.each([["Backup", { backup: 2 }], ["VolumeBackup", { volume: 1 }], ["BaseBackup", { base: 1 }]])(
    "409s when the encrypted destination still has %s rows, and deletes nothing",
    async (_n, counts) => {
      const { svc, del, dbUpdate } = make({ encrypted: true, counts });
      await expect(svc.remove("u1", "d1")).rejects.toBeInstanceOf(ConflictException);
      await expect(svc.remove("u1", "d1")).rejects.toThrow(/discardBackups=true/);
      expect(del).not.toHaveBeenCalled();
      expect(dbUpdate).not.toHaveBeenCalled();
    },
  );

  it("counts every non-FAILED status (in-flight RUNNING/PENDING rows too), not just SUCCESS", async () => {
    const { svc, prisma } = make({ encrypted: true });
    await svc.remove("u1", "d1");
    const expected = { where: { destinationId: "d1", status: { not: "FAILED" } } };
    expect(prisma.backup.count).toHaveBeenCalledWith(expected);
    expect(prisma.volumeBackup.count).toHaveBeenCalledWith(expected);
    expect(prisma.baseBackup.count).toHaveBeenCalledWith(expected);
  });

  it("passes with discardBackups and audits how many were discarded", async () => {
    const { svc, del } = make({ encrypted: true, counts: { backup: 2, volume: 1 } });
    await svc.remove("u1", "d1", { discardBackups: true });
    expect(del).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "destination.remove", meta: { discarded: 3 } }));
  });

  it("passes without the flag when the destination is not encrypted, or has no backups", async () => {
    await make({ encrypted: false, counts: { backup: 5 } }).svc.remove("u1", "d1");
    await make({ encrypted: true }).svc.remove("u1", "d1");
  });

  it("does not count HubBackup rows (they use the .env-derived passphrase)", async () => {
    const { svc, hubBackupCount } = make({ encrypted: true });
    await svc.remove("u1", "d1");
    expect(hubBackupCount).not.toHaveBeenCalled();
  });

  it("the PITR 409 stays first (before the key-loss check)", async () => {
    const { svc, prisma } = make({ encrypted: true, counts: { backup: 3 }, pitr: 1 });
    await expect(svc.remove("u1", "d1")).rejects.toThrow(/PITR/);
    expect(prisma.backup.count).not.toHaveBeenCalled();
  });

  it("nulls the database, app volume-backup and hub-backup pointers in one transaction", async () => {
    const { svc, prisma, dbUpdate, appUpdate, hubUpdate } = make({ encrypted: false });
    await svc.remove("u1", "d1");
    expect(dbUpdate).toHaveBeenCalledWith({ where: { backupDestinationId: "d1" }, data: { backupDestinationId: null } });
    expect(appUpdate).toHaveBeenCalledWith({ where: { volumeBackupDestinationId: "d1" }, data: { volumeBackupDestinationId: null } });
    expect(hubUpdate).toHaveBeenCalledWith({ where: { destinationId: "d1" }, data: { destinationId: null } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("DestinationsService.testConnection — encryption check", () => {
  const enc = { id: "d1", teamId: "t1", type: "LOCAL", encryptionEnabled: true, encryptionKey: "enc:k'ey" };
  const s3enc = { ...enc, type: "S3", s3Bucket: "b", s3Endpoint: "s3.x", s3AccessKey: "enc:AK", s3SecretKey: "enc:SK" };
  const prismaOf = (dest: unknown, server: unknown = { id: "s1" }) =>
    ({ backupDestination: { findUnique: jest.fn().mockResolvedValue(dest) }, server: { findFirst: jest.fn().mockResolvedValue(server) } }) as unknown;

  it("LOCAL encrypted: runs only the gpg round-trip, key shq-quoted; OK on TUGRA_ENC_OK", async () => {
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "TUGRA_ENC_OK\n" });
    const res = await svcOf(prismaOf(enc), { sendCommand }).testConnection("u1", "d1");
    expect(res).toMatchObject({ ok: true, encryption: "OK" });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    const script = sendCommand.mock.calls[0][1] as string;
    expect(script).toContain(`--passphrase 'k'\\''ey'`);
    expect(script).not.toContain("mc ls");
    expect(JSON.stringify(res)).not.toContain("k'ey");
  });

  it("exit 5 -> FAILED with the gpg-not-installed message", async () => {
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 5, output: "TUGRA_GPG_MISSING\n" });
    const res = await svcOf(prismaOf(enc), { sendCommand }).testConnection("u1", "d1");
    expect(res).toEqual({ ok: false, message: "gpg is not installed on the host", encryption: "FAILED" });
  });

  it("any other failure -> FAILED, and the key is scrubbed from the message", async () => {
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 6, output: "TUGRA_ENC_FAIL bad key k'ey" });
    const res = await svcOf(prismaOf(enc), { sendCommand }).testConnection("u1", "d1");
    expect(res.ok).toBe(false);
    expect(res.encryption).toBe("FAILED");
    expect(res.message).not.toContain("k'ey");
  });

  it("S3 encrypted: mc ls first, then the round-trip; an mc failure skips the encryption check", async () => {
    const send = jest.fn().mockResolvedValueOnce({ exitCode: 0, output: "" }).mockResolvedValueOnce({ exitCode: 0, output: "TUGRA_ENC_OK" });
    const ok = await svcOf(prismaOf(s3enc), { sendCommand: send }).testConnection("u1", "d1");
    expect(ok).toMatchObject({ ok: true, message: "Connection OK", encryption: "OK" });
    expect(send.mock.calls[0][1]).toContain("mc ls");
    const bad = jest.fn().mockResolvedValue({ exitCode: 1, output: "AccessDenied" });
    const res = await svcOf(prismaOf(s3enc), { sendCommand: bad }).testConnection("u1", "d1");
    expect(res).toMatchObject({ ok: false, encryption: "SKIPPED" });
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it("unencrypted destinations report SKIPPED; a LOCAL encrypted one with no online server keeps today's ok + SKIPPED", async () => {
    expect((await svcOf(prismaOf({ id: "d1", teamId: "t1", type: "LOCAL", encryptionEnabled: false, encryptionKey: null }), { sendCommand: jest.fn() }).testConnection("u1", "d1")).encryption).toBe("SKIPPED");
    const res = await svcOf(prismaOf(enc, null), { sendCommand: jest.fn() }).testConnection("u1", "d1");
    expect(res).toMatchObject({ ok: true, encryption: "SKIPPED" });
  });
});
