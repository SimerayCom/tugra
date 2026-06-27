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
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.stringContaining("shop"));
  });

  it("fires backup_failed when the agent command throws", async () => {
    const { svc, fireForEvent } = make(jest.fn().mockRejectedValue(new Error("agent offline")));
    await svc.runBackup("db1", "u1");
    expect(fireForEvent).toHaveBeenCalledWith("t1", "backup_failed", expect.any(String));
  });

  it("does NOT notify on a successful backup", async () => {
    const { svc, fireForEvent } = make(jest.fn().mockResolvedValue({ exitCode: 0, output: "" }));
    await svc.runBackup("db1", "u1");
    expect(fireForEvent).not.toHaveBeenCalled();
  });
});
