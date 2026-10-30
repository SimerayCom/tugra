import { BadRequestException, ConflictException } from "@nestjs/common";
import { HubBackupService } from "./hub-backup.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { BackupRunnerService } from "../backups/backup-runner.service";
import { HubBackupRunnerService } from "./hub-backup-runner.service";
import { HubBackupSchedulerService } from "./hub-backup-scheduler.service";

const LOCAL = { id: "s-local", teamId: "t1", capabilities: ["backup"] };

function make(over: { local?: unknown; dest?: unknown } = {}) {
  const upsert = jest.fn().mockResolvedValue({ id: "singleton", enabled: true, intervalHours: 24, retention: 7, destinationId: null });
  const prisma = {
    hubBackupConfig: { findUnique: jest.fn().mockResolvedValue(null), upsert },
    hubBackup: { findMany: jest.fn().mockResolvedValue([]) },
    backupDestination: { findUnique: jest.fn().mockResolvedValue("dest" in over ? over.dest : { id: "d1", teamId: "t1" }) },
  } as unknown as PrismaService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const agentWs = { sendCommand: jest.fn() } as unknown as AgentWsServer;
  const runner = { localServer: jest.fn().mockResolvedValue("local" in over ? over.local : LOCAL) } as unknown as HubBackupRunnerService;
  const apply = jest.fn().mockResolvedValue(undefined);
  const scheduler = { apply } as unknown as HubBackupSchedulerService;
  const backups = { destinationSpecById: jest.fn() } as unknown as BackupRunnerService;
  return { svc: new HubBackupService(prisma, audit, agentWs, runner, scheduler, backups), upsert, apply };
}

describe("HubBackupService.update", () => {
  it("upserts the config and re-applies the schedule", async () => {
    const { svc, upsert, apply } = make();
    await svc.update("u1", { enabled: true, intervalHours: 12, retention: 5, destinationId: null });
    expect(upsert).toHaveBeenCalled();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("409s when there is no local server", async () => {
    const { svc } = make({ local: null });
    await expect(svc.update("u1", { enabled: true, intervalHours: 24, retention: 7 })).rejects.toBeInstanceOf(ConflictException);
  });

  it("409s when the local agent lacks the backup capability", async () => {
    const { svc } = make({ local: { ...LOCAL, capabilities: ["deploy"] } });
    await expect(svc.update("u1", { enabled: true, intervalHours: 24, retention: 7 })).rejects.toBeInstanceOf(ConflictException);
  });

  it("400s when the destination belongs to another team", async () => {
    const { svc } = make({ dest: { id: "d1", teamId: "OTHER" } });
    await expect(svc.update("u1", { enabled: true, intervalHours: 24, retention: 7, destinationId: "d1" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("400s when the destination does not exist", async () => {
    const { svc } = make({ dest: null });
    await expect(svc.update("u1", { enabled: true, intervalHours: 24, retention: 7, destinationId: "d1" })).rejects.toBeInstanceOf(BadRequestException);
  });
});
