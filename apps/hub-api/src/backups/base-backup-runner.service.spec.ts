import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { BaseBackupRunnerService } from "./base-backup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupAlertsService } from "./backup-alerts.service";
import { PitrClaimsService } from "./pitr-claims.service";

const db = { id: "db1", name: "shop", teamId: "t1", serverId: "s1", engine: "POSTGRES", version: "16", backupDestinationId: null, credentials: "enc" };
const spec = { id: "db1", engine: "POSTGRES", image: "postgres:16", port: 5432, hostPort: null, credentials: { username: "tugra", password: "s3cr3tPassw0rd", database: "appdb" } };

/** Mutable baseBackup row store + a backup-table spy to prove the logical table is never touched. */
function make(opts: { sendResult?: { output: string; exitCode: number } | Error; inflight?: unknown; dbOverride?: Record<string, unknown>; alerts?: Partial<BackupAlertsService>; replaying?: boolean } = {}) {
  const create = jest.fn().mockResolvedValue({ id: "bb1" });
  const update = jest.fn().mockResolvedValue({});
  const findUnique = jest.fn().mockResolvedValue({ id: "bb1", status: "SUCCESS" });
  const findFirst = jest.fn().mockResolvedValue(opts.inflight ?? null);
  const findMany = jest.fn().mockResolvedValue([]);
  const updateMany = jest.fn().mockResolvedValue({});
  const del = jest.fn().mockResolvedValue({});
  const deleteMany = jest.fn().mockResolvedValue({});
  // The LOGICAL backup table — the base runner must NEVER call it (coexistence proof).
  const backup = { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() };
  const prisma = {
    database: { findUnique: jest.fn().mockResolvedValue({ ...db, ...opts.dbOverride }) },
    baseBackup: { create, update, findUnique, findFirst, findMany, updateMany, delete: del, deleteMany },
    backup,
    // pruneBase skips while a PITR replay of this db is RUNNING (it may be streaming a base object)
    restore: { findFirst: jest.fn().mockResolvedValue(opts.replaying ? { id: "r1" } : null) },
  } as unknown as PrismaService;
  const sr = opts.sendResult ?? { output: "TUGRA_BASE_SEGSIZE 16MB\nwrite-ahead log start point: 0/2000028 on timeline 1\n1048576", exitCode: 0 };
  const sendCommand = jest.fn((..._args: unknown[]) => (sr instanceof Error ? Promise.reject(sr) : Promise.resolve(sr)));
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const runner = {
    destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }),
    toSpec: jest.fn().mockReturnValue(spec),
  } as unknown as BackupRunnerService;
  const alerts = { shouldNotifyFailure: jest.fn().mockResolvedValue(true), recover: jest.fn().mockResolvedValue(false), ...opts.alerts } as unknown as BackupAlertsService;
  const svc = new BaseBackupRunnerService(
    prisma,
    { log: jest.fn() } as unknown as AuditService,
    { sendCommand } as unknown as AgentWsServer,
    { fireForEvent } as unknown as NotificationsService,
    runner,
    alerts,
    new PitrClaimsService(),
  );
  return { svc, create, update, findFirst, findMany, del, sendCommand, fireForEvent, alerts, backup };
}

describe("BaseBackupRunnerService.runBaseBackup", () => {
  it("records RUNNING→SUCCESS with size + LSN + timeline, over the 'backup' capability at the base timeout", async () => {
    const { svc, update, sendCommand, fireForEvent, alerts } = make();
    await svc.runBaseBackup("db1", "u1");
    const [serverId, cmd, cap, timeout] = sendCommand.mock.calls[0];
    expect(serverId).toBe("s1");
    expect(cmd).toContain("pg_basebackup");
    expect(cap).toBe("backup");
    expect(timeout).toBe(3_600_000);
    const data = update.mock.calls.at(-1)![0].data;
    expect(data).toMatchObject({ status: "SUCCESS", sizeBytes: 1048576n, startLsn: "0/2000028", timeline: 1 });
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_success", expect.objectContaining({ dbName: "shop (base backup)", sizeBytes: "1048576" }));
    expect(alerts.recover).toHaveBeenCalledWith("basebackup", "db1", "t1", expect.anything());
  });

  it("drops the PITR anchor (start LSN + timeline) when the cluster's wal_segment_size is not 16MB or unknown — a snapshot, never a wrong anchor", async () => {
    const m64 = make({ sendResult: { output: "TUGRA_BASE_SEGSIZE 64MB\nwrite-ahead log start point: 0/8000028 on timeline 1\n1048576", exitCode: 0 } });
    await m64.svc.runBaseBackup("db1", "u1");
    expect(m64.update.mock.calls.at(-1)![0].data).toMatchObject({ status: "SUCCESS", startLsn: null, timeline: null });
    const unknown = make({ sendResult: { output: "write-ahead log start point: 0/8000028 on timeline 1\n1048576", exitCode: 0 } });
    await unknown.svc.runBaseBackup("db1", "u1");
    expect(unknown.update.mock.calls.at(-1)![0].data).toMatchObject({ status: "SUCCESS", startLsn: null, timeline: null });
  });

  it("NEVER touches the logical backup table (coexistence)", async () => {
    const { svc, backup } = make();
    await svc.runBaseBackup("db1", "u1");
    for (const fn of Object.values(backup)) expect(fn).not.toHaveBeenCalled();
  });

  it("rejects a non-Postgres database", async () => {
    const { svc } = make({ dbOverride: { engine: "MYSQL" } });
    await expect(svc.runBaseBackup("db1", "u1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("FAILED (non-zero exit): scrubs the secret from errorTail, sends a cleanup delete, fires throttled backup_failed", async () => {
    const { svc, update, sendCommand, fireForEvent, alerts } = make({ sendResult: { output: "FATAL: password authentication failed for s3cr3tPassw0rd", exitCode: 1 } });
    await svc.runBaseBackup("db1", "u1");
    const data = update.mock.calls.at(-1)![0].data;
    expect(data.status).toBe("FAILED");
    expect(data.errorTail).not.toContain("s3cr3tPassw0rd");
    expect(data.errorTail).toContain("<redacted>");
    // a cleanup delete of the partial artifact was dispatched
    expect(sendCommand.mock.calls.some((c) => /rm -f .*db1\/base/.test(String(c[1])))).toBe(true);
    expect(alerts.shouldNotifyFailure).toHaveBeenCalledWith("basebackup", "db1");
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.objectContaining({ dbName: "shop (base backup)" }));
  });

  it("suppresses the failure notification when the throttle says no (row still recorded FAILED)", async () => {
    const { svc, update, fireForEvent } = make({ sendResult: { output: "boom", exitCode: 2 }, alerts: { shouldNotifyFailure: jest.fn().mockResolvedValue(false) } });
    await svc.runBaseBackup("db1", "u1");
    expect(update.mock.calls.at(-1)![0].data.status).toBe("FAILED");
    expect(fireForEvent).not.toHaveBeenCalledWith("t1", "backup_failed", expect.anything());
  });

  it("an offline agent is recorded FAILED (not thrown) and cleaned up", async () => {
    const { svc, update, sendCommand } = make({ sendResult: new Error("agent offline") });
    await svc.runBaseBackup("db1", "u1");
    expect(update.mock.calls.at(-1)![0].data).toMatchObject({ status: "FAILED" });
    expect(update.mock.calls.at(-1)![0].data.errorTail).toContain("agent offline");
    expect(sendCommand.mock.calls.some((c) => /rm -f .*db1\/base/.test(String(c[1])))).toBe(true);
  });

  it("in-flight guard: a fresh RUNNING row is returned without starting a second base", async () => {
    const { svc, sendCommand, create } = make({ inflight: { id: "bbRunning", status: "RUNNING" } });
    const r = await svc.runBaseBackup("db1", "u1");
    expect(r).toMatchObject({ id: "bbRunning" });
    expect(create).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("atomic inflight guard: a lost create race (P2002) returns the winner instead of starting a parallel base", async () => {
    const { svc, sendCommand, create, findFirst } = make();
    // findFirst: null at the check, then the winning RUNNING row after the partial-unique-index P2002.
    findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "bbWinner", status: "RUNNING" });
    create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("unique violation", { code: "P2002", clientVersion: "x" }));
    const r = await svc.runBaseBackup("db1", "u1");
    expect(r).toMatchObject({ id: "bbWinner" });
    expect(sendCommand).not.toHaveBeenCalled(); // never launched a second base
  });
});

describe("BaseBackupRunnerService.pruneBase", () => {
  it("keeps the newest 3 SUCCESS bases, deleting older ones from each row's OWN destination, never touching prisma.backup", async () => {
    const rows = ["k1", "k2", "k3", "s1", "s2"].map((id, i) => ({ id, filename: `${id}.basebackup.tar.gz`, destinationId: `d${i}`, createdAt: new Date(Date.now() - i * 1000) }));
    const del = jest.fn().mockResolvedValue({});
    const backup = { findMany: jest.fn(), delete: jest.fn() };
    const prisma = {
      baseBackup: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { status: string } }) => Promise.resolve(where.status === "SUCCESS" ? rows : [])),
        delete: del,
        deleteMany: jest.fn().mockResolvedValue({}),
      },
      backup,
      restore: { findFirst: jest.fn().mockResolvedValue(null) }, // no PITR replay in flight
    } as unknown as PrismaService;
    const destinationSpecById = jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } });
    const sendCommand = jest.fn().mockResolvedValue({ output: "", exitCode: 0 });
    const svc = new BaseBackupRunnerService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      { sendCommand } as unknown as AgentWsServer,
      { fireForEvent: jest.fn() } as unknown as NotificationsService,
      { destinationSpecById } as unknown as BackupRunnerService,
      { shouldNotifyFailure: jest.fn(), recover: jest.fn() } as unknown as BackupAlertsService,
      new PitrClaimsService(),
    );
    await svc.pruneBase({ id: "db1", serverId: "s1" } as never);
    expect(del).toHaveBeenCalledTimes(2); // s1, s2 (the two oldest beyond 3)
    expect(del).toHaveBeenCalledWith({ where: { id: "s1" } });
    expect(del).toHaveBeenCalledWith({ where: { id: "s2" } });
    expect(destinationSpecById).toHaveBeenCalledWith("d3");
    expect(backup.delete).not.toHaveBeenCalled();
  });
});
