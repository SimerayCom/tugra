import { ConflictException } from "@nestjs/common";
import { HubBackupRunnerService } from "./hub-backup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";
import { BackupRunnerService } from "../backups/backup-runner.service";
import { LOCAL_DEST } from "../backups/destination";
import { ConfigService } from "@nestjs/config";

const LOCAL = { id: "s-local", teamId: "t1", isLocal: true, capabilities: ["backup"] };

function make(sendCommand: jest.Mock, over: { local?: unknown; cfg?: unknown } = {}) {
  const created = { id: "hb1", status: "RUNNING", filename: "f", createdAt: new Date() };
  const hubBackup = {
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    findFirst: jest.fn().mockResolvedValue(null), // no in-flight
    create: jest.fn().mockResolvedValue(created),
    update: jest.fn().mockResolvedValue({}),
    findUnique: jest.fn().mockResolvedValue({ ...created, status: "SUCCESS" }),
    findMany: jest.fn().mockResolvedValue([]),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
  const prisma = {
    hubBackup,
    hubBackupConfig: { findUnique: jest.fn().mockResolvedValue(over.cfg ?? { id: "singleton", retention: 7, destinationId: null }) },
    server: { findFirst: jest.fn().mockResolvedValue("local" in over ? over.local : LOCAL) },
  } as unknown as PrismaService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const agentWs = { sendCommand } as unknown as AgentWsServer;
  const fireForEvent = jest.fn().mockResolvedValue(undefined);
  const notifications = { fireForEvent } as unknown as NotificationsService;
  const backups = { destinationSpecById: jest.fn().mockResolvedValue(LOCAL_DEST) } as unknown as BackupRunnerService;
  const config = { get: (k: string) => (k === "DATABASE_URL" ? "postgresql://tugra:p@postgres:5432/tugra" : "SECRET_KEY_1234567890") } as unknown as ConfigService;
  return { svc: new HubBackupRunnerService(prisma, audit, agentWs, notifications, backups, config), fireForEvent, hubBackup };
}

describe("HubBackupRunnerService.runBackup", () => {
  it("records SUCCESS + fires backup_success (stringified size) on exit 0", async () => {
    const { svc, fireForEvent, hubBackup } = make(jest.fn().mockResolvedValue({ exitCode: 0, output: "1048576" }));
    await svc.runBackup("u1");
    expect(hubBackup.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUCCESS", sizeBytes: 1048576n }) }));
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_success", expect.objectContaining({ dbId: "hub", sizeBytes: "1048576" }));
  });

  it("records FAILED (scrubbed) + fires backup_failed on a non-zero exit", async () => {
    const { svc, fireForEvent, hubBackup } = make(jest.fn().mockResolvedValue({ exitCode: 1, output: "boom" }));
    await svc.runBackup("u1");
    expect(hubBackup.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED" }) }));
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.objectContaining({ dbId: "hub" }));
  });

  it("records FAILED without crashing when the agent throws", async () => {
    const { svc, fireForEvent } = make(jest.fn().mockRejectedValue(new Error("agent offline")));
    await svc.runBackup("u1");
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.objectContaining({ errorTail: expect.stringContaining("agent offline") }));
  });

  it("409s when there is no local server", async () => {
    const { svc } = make(jest.fn(), { local: null });
    await expect(svc.runBackup("u1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("409s when the local agent lacks the backup capability", async () => {
    const { svc } = make(jest.fn(), { local: { ...LOCAL, capabilities: ["deploy"] } });
    await expect(svc.runBackup("u1")).rejects.toBeInstanceOf(ConflictException);
  });

  it("skips and returns the in-flight row when a RUNNING backup already exists", async () => {
    const { svc, hubBackup } = make(jest.fn());
    (hubBackup.findFirst as jest.Mock).mockResolvedValue({ id: "running", status: "RUNNING" });
    const r = await svc.runBackup("u1");
    expect((r as { id: string }).id).toBe("running");
    expect(hubBackup.create).not.toHaveBeenCalled();
  });
});
