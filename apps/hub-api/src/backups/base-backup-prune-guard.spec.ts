import { BaseBackupRunnerService } from "./base-backup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupRunnerService } from "./backup-runner.service";
import { BackupAlertsService } from "./backup-alerts.service";

const db = { id: "db1", name: "shop", teamId: "t1", serverId: "s1", engine: "POSTGRES", version: "16", backupDestinationId: null };

/** pruneBase must never delete a base object that a RUNNING point-in-time replay may be streaming. */
function make(replaying: boolean) {
  const stale = [1, 2, 3, 4, 5].map((i) => ({ id: `bb${i}`, filename: `t${i}.tar.gz`, destinationId: null, status: "SUCCESS" }));
  const baseBackup = {
    findMany: jest.fn((args: { where: { status: string } }) => Promise.resolve(args.where.status === "SUCCESS" ? stale : [])),
    delete: jest.fn().mockResolvedValue({}),
    deleteMany: jest.fn().mockResolvedValue({}),
  };
  const prisma = {
    baseBackup,
    restore: { findFirst: jest.fn().mockResolvedValue(replaying ? { id: "r1" } : null) },
  } as unknown as PrismaService;
  const sendCommand = jest.fn().mockResolvedValue({ exitCode: 0, output: "" });
  const svc = new BaseBackupRunnerService(
    prisma,
    { log: jest.fn() } as unknown as AuditService,
    { sendCommand } as unknown as AgentWsServer,
    { fireForEvent: jest.fn() } as unknown as NotificationsService,
    { destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }) } as unknown as BackupRunnerService,
    {} as BackupAlertsService,
  );
  return { svc, baseBackup, sendCommand };
}

describe("BaseBackupRunnerService.pruneBase — PITR replay guard", () => {
  it("skips pruning entirely while a PITR replay of this database is RUNNING", async () => {
    const { svc, baseBackup, sendCommand } = make(true);
    await svc.pruneBase(db as never);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(baseBackup.delete).not.toHaveBeenCalled();
    expect(baseBackup.findMany).not.toHaveBeenCalled();
  });

  it("prunes normally (keep the newest 3) when no replay is in flight", async () => {
    const { svc, baseBackup } = make(false);
    await svc.pruneBase(db as never);
    expect(baseBackup.delete).toHaveBeenCalledTimes(2);
  });
});
