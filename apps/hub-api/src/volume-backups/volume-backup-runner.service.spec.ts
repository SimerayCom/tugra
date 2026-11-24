import { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupAlertsService } from "../backups/backup-alerts.service";

/** Alerts stub: every failure notifies (no throttle), no recovery. */
const noAlerts = () =>
  ({ shouldNotifyFailure: jest.fn().mockResolvedValue(true), recover: jest.fn().mockResolvedValue(false) }) as unknown as BackupAlertsService;

describe("VolumeBackupRunnerService.prune — per-backup destination", () => {
  it("never counts or prunes the rows of a pre-migration safety copy", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { volumeBackup: { findMany, delete: jest.fn() }, volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const svc = new VolumeBackupRunnerService(prisma, { log: jest.fn() } as unknown as AuditService, {} as unknown as CryptoService, { sendCommand: jest.fn() } as unknown as AgentWsServer, { fireForEvent: jest.fn() } as unknown as NotificationsService, noAlerts());
    await svc.prune({ id: "app1", serverId: "s1", volumes: [{ name: "data" }], volumeBackupRetention: 1 } as never);
    expect(findMany.mock.calls[0][0].where).toMatchObject({ NOT: { createdBy: { startsWith: "migration-snapshot:" } } });
  });

  it("deletes each stale volume backup from its OWN destination", async () => {
    const rows = [
      { id: "keep", filename: "k", volumeName: "data", destinationId: "d0" },
      { id: "s1", filename: "f1", volumeName: "data", destinationId: "dA" },
      { id: "s2", filename: "f2", volumeName: "data", destinationId: "dB" },
    ];
    const del = jest.fn().mockResolvedValue({});
    const prisma = {
      volumeBackup: { findMany: jest.fn().mockResolvedValue(rows), delete: del },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]) },
      backupDestination: { findUnique: jest.fn().mockResolvedValue(null) }, // → LOCAL
    } as unknown as PrismaService;
    const svc = new VolumeBackupRunnerService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      {} as unknown as CryptoService,
      { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }) } as unknown as AgentWsServer,
      { fireForEvent: jest.fn().mockResolvedValue(undefined) } as unknown as NotificationsService,
      noAlerts(),
    );
    const spy = jest.spyOn(svc, "destinationSpecById");
    // one volume "data", retention 1 → keep newest, delete the two older from their own dests
    await svc.prune({ id: "app1", serverId: "s1", volumes: [{ name: "data" }], volumeBackupRetention: 1 } as never);
    expect(spy).toHaveBeenCalledWith("dA");
    expect(spy).toHaveBeenCalledWith("dB");
    expect(spy).not.toHaveBeenCalledWith("d0");
    expect(del).toHaveBeenCalledTimes(2);
  });
});

describe("VolumeBackupRunnerService.runBackup — aggregated notification", () => {
  const app = {
    id: "app1", name: "blog", teamId: "t1", serverId: "s1",
    volumes: [{ name: "data" }, { name: "cache" }],
    volumeBackupDestinationId: null, volumeBackupRetention: 7,
  };

  function make(sendCommand: jest.Mock) {
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      appMove: { findFirst: jest.fn().mockResolvedValue(null) }, // no live app move
      volumeBackup: {
        create: jest.fn().mockResolvedValue({ id: "vb" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "vb", status: "SUCCESS" }),
        findMany: jest.fn().mockResolvedValue([]), // prune finds nothing to delete
        delete: jest.fn(),
      },
      volumeBackupPolicy: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const fireForEvent = jest.fn().mockResolvedValue(undefined);
    const svc = new VolumeBackupRunnerService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      {} as unknown as CryptoService,
      { sendCommand } as unknown as AgentWsServer,
      { fireForEvent } as unknown as NotificationsService,
      noAlerts(),
    );
    return { svc, fireForEvent };
  }

  it("fires volume_backup_success with the SUMMED, stringified size when every volume succeeds", async () => {
    const { svc, fireForEvent } = make(jest.fn().mockResolvedValue({ exitCode: 0, output: "1048576" }));
    await svc.runBackup("app1", "u1");
    expect(fireForEvent).toHaveBeenCalledWith(
      "t1",
      "volume_backup_success",
      expect.objectContaining({ appName: "blog", volumes: "2", sizeBytes: "2097152", failedVolumes: "" }),
    );
    const ctx = fireForEvent.mock.calls[0][2] as Record<string, unknown>;
    expect(typeof ctx.sizeBytes).toBe("string"); // BigInt would throw when the queue serializes
  });

  it("fires volume_backup_failed listing the failed volumes when any volume fails (size dropped)", async () => {
    // first volume OK, second exits non-zero → the run is reported as failed
    const send = jest
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "1048576" })
      .mockResolvedValueOnce({ exitCode: 1, output: "boom" });
    const { svc, fireForEvent } = make(send);
    await svc.runBackup("app1", "u1");
    expect(fireForEvent).toHaveBeenCalledWith(
      "t1",
      "volume_backup_failed",
      expect.objectContaining({ appName: "blog", volumes: "2", sizeBytes: "", failedVolumes: "cache" }),
    );
  });
});

describe("VolumeBackupRunnerService — persisted run outcome + throttle", () => {
  const app = {
    id: "app1", name: "blog", teamId: "t1", serverId: "s1",
    volumes: [{ name: "data" }, { name: "cache" }],
    volumeBackupDestinationId: null, volumeBackupRetention: 7,
  };
  function makeCapture(sendCommand: jest.Mock, alerts = noAlerts()) {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      appMove: { findFirst: jest.fn().mockResolvedValue(null) }, // no live app move
      volumeBackup: {
        create: jest.fn().mockResolvedValue({ id: "vb" }),
        update,
        findUnique: jest.fn().mockResolvedValue({ id: "vb" }),
        findMany: jest.fn().mockResolvedValue([]),
        delete: jest.fn(),
      },
    } as unknown as PrismaService;
    const fireForEvent = jest.fn().mockResolvedValue(undefined);
    const svc = new VolumeBackupRunnerService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      {} as unknown as CryptoService,
      { sendCommand } as unknown as AgentWsServer,
      { fireForEvent } as unknown as NotificationsService,
      alerts,
    );
    return { svc, update, fireForEvent, alerts };
  }

  it("FAILED volume: persists scrubbed errorTail + exitCode + durationMs; SUCCESS volume persists durationMs only", async () => {
    const { svc, update } = makeCapture(
      jest
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, output: "512" })
        .mockResolvedValueOnce({ exitCode: 2, output: "tar: write error\nmc: <ERROR> postgres://AKIA1234:sekretkey99@s3/b" }),
    );
    await svc.runBackup("app1", "u1");
    const ok = update.mock.calls[0][0].data;
    expect(ok.status).toBe("SUCCESS");
    expect(ok.errorTail).toBeNull();
    expect(ok.exitCode).toBe(0);
    expect(typeof ok.durationMs).toBe("number");
    const bad = update.mock.calls[1][0].data;
    expect(bad.status).toBe("FAILED");
    expect(bad.exitCode).toBe(2);
    expect(bad.errorTail).toContain("tar: write error");
    expect(bad.errorTail).not.toContain("sekretkey99"); // URI userinfo redacted
    expect(typeof bad.durationMs).toBe("number");
  });

  it("FAILED (agent throws): errorTail from the error, durationMs set", async () => {
    const { svc, update } = makeCapture(jest.fn().mockRejectedValue(new Error("agent offline")));
    await svc.runBackup("app1", "u1");
    const data = update.mock.calls[0][0].data;
    expect(data.status).toBe("FAILED");
    expect(data.errorTail).toContain("agent offline");
    expect(typeof data.durationMs).toBe("number");
  });

  it("throttled failure → no volume_backup_failed; success → recovery requested", async () => {
    const alerts = { shouldNotifyFailure: jest.fn().mockResolvedValue(false), recover: jest.fn() } as unknown as BackupAlertsService;
    const bad = makeCapture(jest.fn().mockResolvedValue({ exitCode: 1, output: "x" }), alerts);
    await bad.svc.runBackup("app1", "u1");
    expect(alerts.shouldNotifyFailure).toHaveBeenCalledWith("volume", "app1");
    expect(bad.fireForEvent).not.toHaveBeenCalled();
    expect(alerts.recover).not.toHaveBeenCalled();
    const ok = makeCapture(jest.fn().mockResolvedValue({ exitCode: 0, output: "1" }));
    await ok.svc.runBackup("app1", "u1");
    expect(ok.alerts.recover).toHaveBeenCalledWith("volume", "app1", "t1", expect.objectContaining({ appName: "blog" }));
  });
});

describe("VolumeBackupRunnerService.runBackup — app move", () => {
  const app = { id: "app1", name: "blog", teamId: "t1", serverId: "s1", volumes: [{ name: "data" }], volumeBackupDestinationId: null, volumeBackupRetention: 7 };
  function make(move: unknown) {
    const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "1" });
    const prisma = { application: { findUnique: jest.fn().mockResolvedValue(app) }, appMove: { findFirst: jest.fn().mockResolvedValue(move) }, volumeBackup: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), delete: jest.fn() } } as unknown as PrismaService;
    const svc = new VolumeBackupRunnerService(prisma, { log: jest.fn() } as unknown as AuditService, {} as unknown as CryptoService, { sendCommand } as unknown as AgentWsServer, { fireForEvent: jest.fn() } as unknown as NotificationsService, noAlerts());
    return { svc, sendCommand, prisma };
  }

  it("the SCHEDULED run skips an app with a live move (no row, no command); the next tick runs normally", async () => {
    const t = make({ id: "mv1", phase: "TRANSFERRING" });
    expect(await t.svc.runBackup("app1")).toEqual([]);
    expect(t.sendCommand).not.toHaveBeenCalled();
    expect(t.prisma.volumeBackup.create as jest.Mock).not.toHaveBeenCalled();
  });

  it("a MANUAL run is told why (409 app_move_in_progress)", async () => {
    const t = make({ id: "mv1", phase: "STOPPING_SOURCE" });
    await expect(t.svc.runBackup("app1", "u1")).rejects.toMatchObject({ response: expect.objectContaining({ code: "app_move_in_progress" }) });
    expect(t.sendCommand).not.toHaveBeenCalled();
  });
});
