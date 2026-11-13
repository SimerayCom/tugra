import { ConflictException } from "@nestjs/common";
import { BackupsService } from "./backups.service";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupSchedulerService } from "./backups.scheduler.service";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupAlertsService } from "./backup-alerts.service";
import { BaseBackupRunnerService } from "./base-backup-runner.service";

/** PITR pins the backup destination: the WAL chain + its anchoring bases must live in ONE store. */
function make(row: { pitrEnabled: boolean; backupDestinationId: string | null }) {
  const db = { id: "db1", teamId: "t1", engine: "POSTGRES", ...row };
  const update = jest.fn().mockResolvedValue({ ...db, backupEnabled: true, backupCron: null, backupIntervalHours: 24 });
  const prisma = { database: { findUnique: jest.fn().mockResolvedValue(db), update } } as unknown as PrismaService;
  const svc = new BackupsService(
    prisma,
    { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService,
    { log: jest.fn() } as unknown as AuditService,
    {} as AgentWsServer,
    {} as BackupRunnerService,
    { schedule: jest.fn(), scheduleCron: jest.fn(), unschedule: jest.fn() } as unknown as BackupSchedulerService,
    {} as NotificationsService,
    { onScheduleChanged: jest.fn() } as unknown as BackupAlertsService,
    {} as BaseBackupRunnerService,
  );
  return { svc, update };
}

describe("BackupsService — destination is pinned while PITR is enabled", () => {
  const cfg = { enabled: true, intervalHours: 24 };

  it("refuses (409) a destination CHANGE while pitrEnabled — including clearing it back to LOCAL", async () => {
    const a = make({ pitrEnabled: true, backupDestinationId: "d1" });
    await expect(a.svc.setSchedule("u1", "db1", { ...cfg, destinationId: "d2" })).rejects.toBeInstanceOf(ConflictException);
    await expect(a.svc.setSchedule("u1", "db1", { ...cfg, destinationId: "" })).rejects.toBeInstanceOf(ConflictException);
    expect(a.update).not.toHaveBeenCalled();
  });

  it("allows the SAME destination (no-op) and config writes that leave destinationId untouched", async () => {
    const a = make({ pitrEnabled: true, backupDestinationId: "d1" });
    await a.svc.setSchedule("u1", "db1", { ...cfg, destinationId: "d1" });
    await a.svc.setSchedule("u1", "db1", cfg);
    expect(a.update).toHaveBeenCalledTimes(2);
  });

  it("a LOCAL-pinned PITR db keeps LOCAL: '' and omitted are fine, a real id is refused", async () => {
    const a = make({ pitrEnabled: true, backupDestinationId: null });
    await a.svc.setSchedule("u1", "db1", { ...cfg, destinationId: "" });
    await expect(a.svc.setSchedule("u1", "db1", { ...cfg, destinationId: "d9" })).rejects.toBeInstanceOf(ConflictException);
  });

  it("does not interfere when PITR is off", async () => {
    const a = make({ pitrEnabled: false, backupDestinationId: "d1" });
    await a.svc.setSchedule("u1", "db1", { ...cfg, destinationId: "d2" });
    expect(a.update).toHaveBeenCalledTimes(1);
  });
});
