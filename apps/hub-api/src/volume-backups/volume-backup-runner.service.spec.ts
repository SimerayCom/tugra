import { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";

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
