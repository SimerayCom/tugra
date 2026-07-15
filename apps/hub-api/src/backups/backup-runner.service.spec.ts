import { BackupRunnerService } from "./backup-runner.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { NotificationsService } from "../notifications/notifications.service";

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
  return { svc: new BackupRunnerService(prisma, audit, crypto, agentWs, notifications), fireForEvent };
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

  it("does NOT notify on a successful backup", async () => {
    const { svc, fireForEvent } = make(jest.fn().mockResolvedValue({ exitCode: 0, output: "" }));
    await svc.runBackup("db1", "u1");
    expect(fireForEvent).not.toHaveBeenCalled();
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
    );
    const spy = jest.spyOn(svc, "destinationSpecById");
    // retention 1 → keep the newest, delete the two older ones from their own dests
    await svc.prune({ id: "db1", serverId: "s1", backupRetention: 1 } as never);
    expect(spy).toHaveBeenCalledWith("dA");
    expect(spy).toHaveBeenCalledWith("dB");
    expect(spy).not.toHaveBeenCalledWith("d0");
    expect(del).toHaveBeenCalledTimes(2);
  });
});
