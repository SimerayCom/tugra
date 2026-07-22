import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { VolumeBackupsService } from "./volume-backups.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import type { VolumeBackupSchedulerService } from "./volume-backups.scheduler.service";

function make(opts: { app?: Record<string, unknown> | null; requirePermThrows?: boolean } = {}) {
  const app =
    opts.app === undefined
      ? { id: "a1", teamId: "t1", serverId: "s1", environmentId: "e1", volumes: [{ name: "data", path: "/data" }] }
      : opts.app;

  const prisma = {
    application: { findUnique: jest.fn().mockResolvedValue(app) },
  } as unknown as PrismaService;

  const access = {
    requirePermission: opts.requirePermThrows
      ? jest.fn().mockRejectedValue(new ForbiddenException("nope"))
      : jest.fn().mockResolvedValue(undefined),
    teamRole: jest.fn().mockResolvedValue("OWNER"),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
  } as unknown as TeamAccessService;

  const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: "" }) } as unknown as AgentWsServer;
  const runner = {} as unknown as VolumeBackupRunnerService;
  const scheduler = {} as unknown as VolumeBackupSchedulerService;

  const service = new VolumeBackupsService(prisma, access, audit, agentWs, runner, scheduler);
  return { service, prisma, access, audit, agentWs };
}

const input = { volumeName: "data", url: "https://x.example/dump.tar.gz", gzip: true, encrypted: false } as const;

describe("VolumeBackupsService.importFromUrl", () => {
  it("requires the backups permission — nothing is dispatched otherwise", async () => {
    const t = make({ requirePermThrows: true });
    await expect(t.service.importFromUrl("u1", "a1", { ...input })).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("404s when the app does not exist", async () => {
    const t = make({ app: null });
    await expect(t.service.importFromUrl("u1", "a1", { ...input })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects a volume the app does not declare (no arbitrary-volume write)", async () => {
    const t = make();
    await expect(
      t.service.importFromUrl("u1", "a1", { ...input, volumeName: "secrets" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("dispatches the import for the app's docker volume under the 'backup' capability + audits", async () => {
    const t = make();
    await t.service.importFromUrl("u1", "a1", { ...input });
    const [serverId, cmd, cap] = (t.agentWs.sendCommand as jest.Mock).mock.calls[0];
    expect(serverId).toBe("s1");
    expect(cap).toBe("backup");
    expect(cmd).toContain("tugra_appv_a1_data"); // appVolumeName(app, "data")
    expect(cmd).toContain("curl -fsSL 'https://x.example/dump.tar.gz'");
    expect(t.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "app.volume_import", meta: { volumeName: "data" } }),
    );
  });

  it("passes the encryption key through for an encrypted import", async () => {
    const t = make();
    await t.service.importFromUrl("u1", "a1", { ...input, encrypted: true, encryptionKey: "pass", url: "https://x/e.gpg" });
    const cmd = (t.agentWs.sendCommand as jest.Mock).mock.calls[0][1];
    expect(cmd).toContain("gpg --batch --yes --passphrase 'pass' --decrypt");
  });

  it("throws (no false success) when the agent import command exits non-zero", async () => {
    const t = make();
    (t.agentWs.sendCommand as jest.Mock).mockResolvedValue({ exitCode: 1, output: "curl: (22) 404" });
    await expect(t.service.importFromUrl("u1", "a1", { ...input })).rejects.toBeInstanceOf(BadGatewayException);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_import_failed" }));
    expect(t.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_import" }));
  });
});
