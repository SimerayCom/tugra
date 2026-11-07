import { BackupRunnerService } from "./backup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupAlertsService } from "../backups/backup-alerts.service";

/** Alerts stub: every failure notifies (no throttle), no recovery. */
const noAlerts = () =>
  ({ shouldNotifyFailure: jest.fn().mockResolvedValue(true), recover: jest.fn().mockResolvedValue(false) }) as unknown as BackupAlertsService;

const db = {
  id: "db1", name: "shop", teamId: "t1", serverId: "s1", engine: "POSTGRES",
  credentials: "enc", backupDestinationId: null, backupRetention: 7,
};

function make(sendCommand: jest.Mock) {
  const prisma = {
    database: { findUnique: jest.fn().mockResolvedValue(db) },
    backup: {
      create: jest.fn().mockResolvedValue({ id: "b1" }),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ id: "b1" }),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    },
  } as unknown as PrismaService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const crypto = { decrypt: () => JSON.stringify({ username: "u", password: "p", database: "d" }) } as unknown as CryptoService;
  const agentWs = { sendCommand } as unknown as AgentWsServer;
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const notifications = { fireForEvent } as unknown as NotificationsService;
  return { svc: new BackupRunnerService(prisma, audit, crypto, agentWs, notifications, noAlerts()), fireForEvent };
}

describe("BackupRunnerService backup-failure notification", () => {
  it("fires backup_failed when the dump command exits non-zero", async () => {
    const { svc, fireForEvent } = make(jest.fn().mockResolvedValue({ exitCode: 1, output: "" }));
    await svc.runBackup("db1", "u1");
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.objectContaining({ dbName: expect.stringContaining("shop") }));
  });

  it("fires backup_failed when the agent command throws", async () => {
    const { svc, fireForEvent } = make(jest.fn().mockRejectedValue(new Error("agent offline")));
    await svc.runBackup("db1", "u1");
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.objectContaining({ dbName: expect.stringContaining("shop"), errorTail: expect.stringContaining("agent offline") }));
  });

  it("fires backup_success (with a STRINGIFIED size) when the dump succeeds", async () => {
    const { svc, fireForEvent } = make(jest.fn().mockResolvedValue({ exitCode: 0, output: "1048576" }));
    await svc.runBackup("db1", "u1");
    expect(fireForEvent).toHaveBeenCalledWith(
      "t1",
      "backup_success",
      expect.objectContaining({ dbName: "shop", sizeBytes: "1048576" }),
    );
    // sizeBytes must be a string: a raw Prisma BigInt would throw when the queue JSON-serializes the job.
    const ctx = fireForEvent.mock.calls[0][2] as Record<string, unknown>;
    expect(typeof ctx.sizeBytes).toBe("string");
    expect(fireForEvent).not.toHaveBeenCalledWith("t1", "backup_failed", expect.anything());
  });

  it("does NOT fire backup_success when persisting the SUCCESS row throws (row ends FAILED)", async () => {
    // dump exits 0, but the first backup.update (status:SUCCESS) rejects → catch records FAILED. A false
    // backup_success for a FAILED row must not fire; backup_failed does.
    const update = jest.fn().mockRejectedValueOnce(new Error("db deadlock")).mockResolvedValue({});
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
      backup: {
        create: jest.fn().mockResolvedValue({ id: "b1" }),
        update,
        findUnique: jest.fn().mockResolvedValue({ id: "b1" }),
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn(),
      },
    } as unknown as PrismaService;
    const fireForEvent = jest.fn().mockResolvedValue(undefined);
    const svc = new BackupRunnerService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      { decrypt: () => JSON.stringify({ username: "u", password: "p", database: "d" }) } as unknown as CryptoService,
      { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "123" }) } as unknown as AgentWsServer,
      { fireForEvent } as unknown as NotificationsService,
      noAlerts(),
    );
    await svc.runBackup("db1", "u1");
    expect(fireForEvent).not.toHaveBeenCalledWith("t1", "backup_success", expect.anything());
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.anything());
  });
});

describe("BackupRunnerService — persisted run outcome", () => {
  /** Capture every backup.update payload so the persisted columns can be asserted. */
  function makeCapture(sendCommand: jest.Mock, alerts = noAlerts(), creds = { username: "u", password: "s3cr3tPassw0rd", database: "d" }) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      database: { findUnique: jest.fn().mockResolvedValue(db) },
      backup: {
        create: jest.fn().mockResolvedValue({ id: "b1" }),
        update,
        findUnique: jest.fn().mockResolvedValue({ id: "b1" }),
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn(),
      },
    } as unknown as PrismaService;
    const fireForEvent = jest.fn().mockResolvedValue(undefined);
    const svc = new BackupRunnerService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      { decrypt: () => JSON.stringify(creds) } as unknown as CryptoService,
      { sendCommand } as unknown as AgentWsServer,
      { fireForEvent } as unknown as NotificationsService,
      alerts,
    );
    return { svc, update, fireForEvent, alerts };
  }

  it("FAILED (non-zero exit): persists a scrubbed errorTail + exitCode + durationMs", async () => {
    const { svc, update } = makeCapture(
      jest.fn().mockResolvedValue({ exitCode: 3, output: "pg_dump: error: connection failed\nDETAIL:  Key (email)=(a@b.c) exists" }),
    );
    await svc.runBackup("db1", "u1");
    const data = update.mock.calls[0][0].data;
    expect(data.status).toBe("FAILED");
    expect(data.exitCode).toBe(3);
    expect(data.errorTail).toContain("pg_dump: error: connection failed");
    expect(data.errorTail).not.toContain("a@b.c"); // row data redacted (scrubRestoreOutput)
    expect(typeof data.durationMs).toBe("number");
    expect(data.durationMs).toBeGreaterThanOrEqual(0);
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it("FAILED errorTail never contains the DB password or S3 secrets, nor URI userinfo", async () => {
    const { svc, update, fireForEvent } = makeCapture(
      jest.fn().mockResolvedValue({
        exitCode: 1,
        output: "FATAL: password authentication failed for s3cr3tPassw0rd\nconnect postgres://u:s3cr3tPassw0rd@db:5432/d\nPGPASSWORD=hunter22xx",
      }),
    );
    await svc.runBackup("db1", "u1");
    const tail = update.mock.calls[0][0].data.errorTail as string;
    expect(tail).not.toContain("s3cr3tPassw0rd");
    expect(tail).not.toContain("hunter22xx");
    expect(tail).toContain("<redacted>");
    // the notification ctx is scrubbed the same way
    const ctx = fireForEvent.mock.calls.find((c) => c[1] === "backup_failed")![2] as { errorTail: string };
    expect(ctx.errorTail).not.toContain("s3cr3tPassw0rd");
  });

  it("FAILED (agent throws): persists the message as errorTail, exitCode null, durationMs set", async () => {
    const { svc, update } = makeCapture(jest.fn().mockRejectedValue(new Error("agent offline")));
    await svc.runBackup("db1", "u1");
    const data = update.mock.calls[0][0].data;
    expect(data.status).toBe("FAILED");
    expect(data.exitCode).toBeNull();
    expect(data.errorTail).toContain("agent offline");
    expect(typeof data.durationMs).toBe("number");
  });

  it("SUCCESS: persists durationMs + exitCode 0 and NO errorTail", async () => {
    const { svc, update } = makeCapture(jest.fn().mockResolvedValue({ exitCode: 0, output: "2048" }));
    await svc.runBackup("db1", "u1");
    const data = update.mock.calls[0][0].data;
    expect(data.status).toBe("SUCCESS");
    expect(data.exitCode).toBe(0);
    expect(data.errorTail).toBeNull();
    expect(typeof data.durationMs).toBe("number");
    expect(data.sizeBytes).toBe(2048n);
  });

  it("failure notification is gated by the throttle (suppressed repeat → no backup_failed, row still recorded)", async () => {
    const alerts = { shouldNotifyFailure: jest.fn().mockResolvedValue(false), recover: jest.fn() } as unknown as BackupAlertsService;
    const { svc, update, fireForEvent } = makeCapture(jest.fn().mockResolvedValue({ exitCode: 1, output: "boom" }), alerts);
    await svc.runBackup("db1", "u1");
    expect(alerts.shouldNotifyFailure).toHaveBeenCalledWith("database", "db1");
    expect(fireForEvent).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.errorTail).toContain("boom"); // still persisted
  });

  it("a SUCCESS asks the alerts service for a recovery notice (and never on a failure)", async () => {
    const ok = makeCapture(jest.fn().mockResolvedValue({ exitCode: 0, output: "1" }));
    await ok.svc.runBackup("db1", "u1");
    expect(ok.alerts.recover).toHaveBeenCalledWith("database", "db1", "t1", expect.objectContaining({ dbName: "shop" }));
    const bad = makeCapture(jest.fn().mockResolvedValue({ exitCode: 1, output: "x" }));
    await bad.svc.runBackup("db1", "u1");
    expect(bad.alerts.recover).not.toHaveBeenCalled();
  });
});

describe("BackupRunnerService.prune — per-backup destination", () => {
  it("deletes each stale backup from its OWN destination", async () => {
    const rows = [
      { id: "keep", filename: "k", destinationId: "d0" },
      { id: "s1", filename: "f1", destinationId: "dA" },
      { id: "s2", filename: "f2", destinationId: "dB" },
    ];
    const del = jest.fn().mockResolvedValue({});
    const prisma = {
      backup: { findMany: jest.fn().mockResolvedValue(rows), delete: del },
      backupDestination: { findUnique: jest.fn().mockResolvedValue(null) }, // → LOCAL
    } as unknown as PrismaService;
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const svc = new BackupRunnerService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      {} as unknown as CryptoService,
      { sendCommand } as unknown as AgentWsServer,
      {} as unknown as NotificationsService,
      noAlerts(),
    );
    const spy = jest.spyOn(svc, "destinationSpecById");
    // retention 1 → keep the newest, delete the two older ones from their own dests
    await svc.prune({ id: "db1", serverId: "s1", backupRetention: 1 } as never);
    expect(spy).toHaveBeenCalledWith("dA");
    expect(spy).toHaveBeenCalledWith("dB");
    expect(spy).not.toHaveBeenCalledWith("d0");
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("age retention: deletes SUCCESS backups older than backupRetentionDays, always keeping the newest", async () => {
    const day = 86_400_000;
    const now = Date.now();
    const rows = [
      { id: "new", filename: "n", destinationId: "d0", createdAt: new Date(now - 1 * day) }, // newest, 1 day old
      { id: "old1", filename: "o1", destinationId: "dA", createdAt: new Date(now - 5 * day) },
      { id: "old2", filename: "o2", destinationId: "dB", createdAt: new Date(now - 10 * day) },
    ];
    const del = jest.fn().mockResolvedValue({});
    const prisma = {
      backup: { findMany: jest.fn().mockResolvedValue(rows), delete: del },
      backupDestination: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = new BackupRunnerService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      {} as unknown as CryptoService,
      { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }) } as unknown as AgentWsServer,
      {} as unknown as NotificationsService,
      noAlerts(),
    );
    // High count so the count rule keeps all 3; the 3-day age limit deletes the two older-than-3-days ones.
    await svc.prune({ id: "db1", serverId: "s1", backupRetention: 100, backupRetentionDays: 3 } as never);
    expect(del).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith({ where: { id: "old1" } });
    expect(del).toHaveBeenCalledWith({ where: { id: "old2" } });
    expect(del).not.toHaveBeenCalledWith({ where: { id: "new" } });
  });

  it("destinationSpecById: a LOCAL destination carries its encryption config (not collapsed to cleartext)", async () => {
    const prisma = {
      backupDestination: {
        findUnique: jest.fn().mockResolvedValue({
          id: "dL",
          type: "LOCAL",
          encryptionEnabled: true,
          encryptionKey: "enc(key)",
        }),
      },
    } as unknown as PrismaService;
    const crypto = { decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, "$1") } as unknown as CryptoService;
    const svc = new BackupRunnerService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      crypto,
      {} as unknown as AgentWsServer,
      {} as unknown as NotificationsService,
      noAlerts(),
    );
    const spec = await svc.destinationSpecById("dL");
    expect(spec.type).toBe("LOCAL");
    expect(spec.encryption.enabled).toBe(true); // was silently dropped before the fix
    expect(spec.encryption.key).toBe("key"); // decrypted, so the dump is actually gpg-encrypted on disk
  });

  it("destinationSpecById: a missing destination falls back to the unencrypted LOCAL default", async () => {
    const prisma = {
      backupDestination: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = new BackupRunnerService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      { decrypt: (v: string) => v } as unknown as CryptoService,
      {} as unknown as AgentWsServer,
      {} as unknown as NotificationsService,
      noAlerts(),
    );
    const spec = await svc.destinationSpecById("nope");
    expect(spec.type).toBe("LOCAL");
    expect(spec.encryption.enabled).toBe(false);
  });
});
