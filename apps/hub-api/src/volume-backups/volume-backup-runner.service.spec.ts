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
  it("deletes each stale volume backup from its OWN destination", async () => {
    const rows = [
      { id: "keep", filename: "k", volumeName: "data", destinationId: "d0" },
      { id: "s1", filename: "f1", volumeName: "data", destinationId: "dA" },
      { id: "s2", filename: "f2", volumeName: "data", destinationId: "dB" },
    ];
    const del = jest.fn().mockResolvedValue({});
    const prisma = {
      volumeBackup: { findMany: jest.fn().mockResolvedValue(rows), delete: del },
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
      volumeBackup: {
        create: jest.fn().mockResolvedValue({ id: "vb" }),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: "vb", status: "SUCCESS" }),
        findMany: jest.fn().mockResolvedValue([]), // prune finds nothing to delete
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
