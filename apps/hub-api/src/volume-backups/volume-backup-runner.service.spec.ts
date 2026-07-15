import { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";

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
