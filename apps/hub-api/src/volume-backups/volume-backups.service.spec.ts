import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { VolumeBackupsService } from "./volume-backups.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import type { VolumeBackupSchedulerService } from "./volume-backups.scheduler.service";
import type { BackupAlertsService } from "../backups/backup-alerts.service";

const fakeAlerts = { onScheduleChanged: jest.fn().mockResolvedValue(undefined) } as unknown as BackupAlertsService;

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

  const service = new VolumeBackupsService(prisma, access, audit, agentWs, runner, scheduler, fakeAlerts);
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

describe("VolumeBackupsService.restore", () => {
  type Send = { exitCode: number; output: string };
  function setup(
    opts: { send?: Send; sendImpl?: () => Promise<Send>; backup?: Record<string, unknown> | null; requirePermThrows?: boolean } = {},
  ) {
    const app = { id: "a1", teamId: "t1", serverId: "s1", environmentId: "e1", volumes: [{ name: "data", path: "/data" }] };
    const backup = opts.backup === undefined ? { id: "vb1", appId: "a1", volumeName: "data", filename: "20260101.tar.gz", destinationId: null } : opts.backup;
    const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      volumeBackup: { findFirst: jest.fn().mockResolvedValue(backup) },
    } as unknown as PrismaService;
    const access = {
      requirePermission: opts.requirePermThrows ? jest.fn().mockRejectedValue(new ForbiddenException("nope")) : jest.fn().mockResolvedValue(undefined),
      teamRole: jest.fn().mockResolvedValue("OWNER"),
      requireResourceAccess: jest.fn().mockResolvedValue(undefined),
    } as unknown as TeamAccessService;
    const sendCommand = opts.sendImpl ? jest.fn(opts.sendImpl) : jest.fn().mockResolvedValue(opts.send ?? { exitCode: 0, output: "TUGRA_RESTORE_OK" });
    const agentWs = { sendCommand } as unknown as AgentWsServer;
    const runner = { destinationSpecById: jest.fn().mockResolvedValue({ type: "LOCAL", encryption: { enabled: false, key: "" } }) } as unknown as VolumeBackupRunnerService;
    const service = new VolumeBackupsService(prisma, access, audit, agentWs, runner, {} as unknown as VolumeBackupSchedulerService, fakeAlerts);
    return { service, agentWs, audit };
  }

  it("requires the backups permission — nothing is dispatched", async () => {
    const t = setup({ requirePermThrows: true });
    await expect(t.service.restore("u1", "a1", "vb1")).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("404s when the backup does not exist", async () => {
    const t = setup({ backup: null });
    await expect(t.service.restore("u1", "a1", "vb1")).rejects.toBeInstanceOf(NotFoundException);
    expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("audits success on exit 0 (the script exits 0 only from its success branch)", async () => {
    const t = setup({ send: { exitCode: 0, output: "noise\nTUGRA_RESTORE_OK" } });
    await t.service.restore("u1", "a1", "vb1");
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_restore", meta: { backupId: "vb1" } }));
    expect(t.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_restore_failed" }));
  });

  it("still succeeds on exit 0 when the OK marker was truncated out of the output (keys off the exit code, not the marker)", async () => {
    const t = setup({ send: { exitCode: 0, output: "" } }); // the agent's 64KB output cap can drop the end-of-output marker
    await t.service.restore("u1", "a1", "vb1");
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_restore" }));
    expect(t.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_restore_failed" }));
  });

  it("throws (no false success) when the agent restore exits non-zero", async () => {
    const t = setup({ send: { exitCode: 2, output: "tar: Unrecognized archive format" } });
    await expect(t.service.restore("u1", "a1", "vb1")).rejects.toBeInstanceOf(BadGatewayException);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_restore_failed" }));
    expect(t.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_restore" }));
  });

  it("reports the old data as preserved on a pre-wipe abort (72) or a rollback (71)", async () => {
    for (const exitCode of [72, 71]) {
      const t = setup({ send: { exitCode, output: "" } });
      await expect(t.service.restore("u1", "a1", "vb1")).rejects.toThrow(/existing volume data was preserved/);
      expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_restore_failed" }));
      expect(t.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_restore" }));
    }
  });

  it("reports an uncertain outcome + the recovery volume on exit 70, and records it in the audit", async () => {
    const t = setup({ send: { exitCode: 70, output: "TUGRA_RESTORE_RECOVERY_REQUIRED" } });
    await expect(t.service.restore("u1", "a1", "vb1")).rejects.toThrow(/outcome is uncertain[\s\S]*tugra_restore_rb_/);
    expect(t.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "app.volume_restore_failed", meta: expect.objectContaining({ rbVolume: expect.stringContaining("tugra_restore_rb_") }) }),
    );
  });

  it("treats a SIGKILL exit (-1) as an uncertain outcome, never 'preserved'", async () => {
    const t = setup({ send: { exitCode: -1, output: "" } });
    await expect(t.service.restore("u1", "a1", "vb1")).rejects.toThrow(/outcome is uncertain/);
  });

  it("records the failure and rethrows when the agent is offline / times out (never a silent success)", async () => {
    const t = setup({ sendImpl: () => Promise.reject(new Error("command timed out")) });
    await expect(t.service.restore("u1", "a1", "vb1")).rejects.toThrow(/timed out/);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_restore_failed" }));
    expect(t.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_restore" }));
  });

  it("rejects a second concurrent restore for the same volume with 409 (no corrupting overlap)", async () => {
    let release!: (v: Send) => void;
    const gate = new Promise<Send>((res) => {
      release = res;
    });
    const t = setup({ sendImpl: () => gate });
    const first = t.service.restore("u1", "a1", "vb1"); // in flight (sendCommand pending on the gate)
    await new Promise((r) => setImmediate(r)); // let the first call take the per-volume lock
    await expect(t.service.restore("u1", "a1", "vb1")).rejects.toBeInstanceOf(ConflictException);
    release({ exitCode: 0, output: "TUGRA_RESTORE_OK" });
    await first;
    // lock released after the first completes → a later restore is allowed again
    await expect(t.service.restore("u1", "a1", "vb1")).resolves.toBeUndefined();
  });
});

describe("VolumeBackupsService.exportUrl", () => {
  const S3_DEST = { type: "S3", s3: { bucket: "b", region: "r", endpoint: "s3.example.com", accessKey: "AK", secretKey: "SK", prefix: "tugra" }, encryption: { enabled: false, key: "" } };
  const LOCAL_DEST = { type: "LOCAL", encryption: { enabled: false, key: "" } };
  const SHARE_JSON = '{"status":"success","url":"tdest/b/k","share":"https://s3.example.com/b/k?X-Amz-Signature=sig","expiry":86400}';

  function setup(dest: unknown, sendResult: { exitCode: number; output: string } = { exitCode: 0, output: SHARE_JSON }) {
    const app = { id: "a1", teamId: "t1", serverId: "s1", environmentId: "e1", volumes: [{ name: "data", path: "/data" }] };
    const audit = { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const prisma = {
      application: { findUnique: jest.fn().mockResolvedValue(app) },
      volumeBackup: {
        findFirst: jest.fn().mockResolvedValue({ id: "vb1", appId: "a1", volumeName: "data", filename: "20260101.tar.gz", destinationId: (dest as { type: string }).type === "S3" ? "d1" : null }),
      },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined), teamRole: jest.fn().mockResolvedValue("OWNER"), requireResourceAccess: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const agentWs = { sendCommand: jest.fn().mockResolvedValue(sendResult) } as unknown as AgentWsServer;
    const runner = { destinationSpecById: jest.fn().mockResolvedValue(dest) } as unknown as VolumeBackupRunnerService;
    const service = new VolumeBackupsService(prisma, access, audit, agentWs, runner, {} as unknown as VolumeBackupSchedulerService, fakeAlerts);
    return { service, agentWs, audit };
  }

  it("returns a presigned url + expiry for an S3 backup, under the 'backup' capability", async () => {
    const t = setup(S3_DEST);
    const res = await t.service.exportUrl("u1", "a1", "vb1", 24);
    const [serverId, cmd, cap] = (t.agentWs.sendCommand as jest.Mock).mock.calls[0];
    expect(serverId).toBe("s1");
    expect(cap).toBe("backup");
    expect(cmd).toContain("mc share download --expire '24h'");
    expect(res.url).toBe("https://s3.example.com/b/k?X-Amz-Signature=sig");
    expect(res.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a LOCAL backup (no presignable object) without dispatching", async () => {
    const t = setup(LOCAL_DEST);
    await expect(t.service.exportUrl("u1", "a1", "vb1", 24)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.agentWs.sendCommand).not.toHaveBeenCalled();
  });

  it("BadGateway when mc fails, and never logs the presigned url", async () => {
    const t = setup(S3_DEST, { exitCode: 1, output: "mc: <ERROR> share failed" });
    await expect(t.service.exportUrl("u1", "a1", "vb1", 24)).rejects.toBeInstanceOf(BadGatewayException);
    expect(JSON.stringify((t.audit.log as jest.Mock).mock.calls)).not.toContain("http");
  });

  it("never puts the presigned url in the audit log on success", async () => {
    const t = setup(S3_DEST);
    await t.service.exportUrl("u1", "a1", "vb1", 24);
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_export" }));
    expect(JSON.stringify((t.audit.log as jest.Mock).mock.calls)).not.toContain("X-Amz");
  });
});

describe("VolumeBackupsService.list — run outcome, errorTail is WRITER-ONLY", () => {
  const row = {
    id: "v1", volumeName: "data", status: "FAILED", filename: "f.tar", sizeBytes: null, destinationId: null,
    createdBy: "u1", createdAt: new Date(), completedAt: new Date(),
    exitCode: 2, durationMs: 900, errorTail: "tar: scrubbed reason",
  };
  const mk = (perms: string[] | null) => {
    const { service, prisma, access } = make();
    (prisma as unknown as { volumeBackup: unknown }).volumeBackup = { findMany: jest.fn().mockResolvedValue([row]) };
    (prisma as unknown as { backupDestination: unknown }).backupDestination = { findMany: jest.fn().mockResolvedValue([]) };
    (access as unknown as { membershipPermissions: jest.Mock }).membershipPermissions = jest.fn().mockResolvedValue(perms ? new Set(perms) : null);
    return service;
  };

  it("a writer sees errorTail + exitCode + durationMs", async () => {
    const [v] = await mk(["backups"]).list("u1", "a1");
    expect(v.errorTail).toBe("tar: scrubbed reason");
    expect(v.exitCode).toBe(2);
    expect(v.durationMs).toBe(900);
  });

  it("a read-only member (or unknown membership) gets errorTail=null", async () => {
    const [v] = await mk([]).list("u1", "a1");
    expect(v.errorTail).toBeNull();
    expect(v.exitCode).toBe(2);
    expect(JSON.stringify(v)).not.toContain("scrubbed reason");
    expect((await mk(null).list("u1", "a1"))[0].errorTail).toBeNull();
  });
});
