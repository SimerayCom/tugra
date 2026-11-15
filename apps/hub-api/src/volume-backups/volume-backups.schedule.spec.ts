import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { VolumeBackupsService } from "./volume-backups.service";
import { VolumeBackupConfigSchema, VolumePolicySchema } from "./dto";
import { GIB } from "../backups/retention";
import type { PrismaService } from "../prisma/prisma.service";
import type { TeamAccessService } from "../common/team-access.service";
import type { AuditService } from "../audit/audit.service";
import type { AgentWsServer } from "../agent-gateway/agent-ws.server";
import type { BackupAlertsService } from "../backups/backup-alerts.service";

const app0 = {
  id: "a1", teamId: "t1", serverId: "s1", environmentId: "e1",
  volumes: [{ name: "data", path: "/data" }, { name: "media", path: "/m" }],
  volumeBackupEnabled: false, volumeBackupIntervalHours: null as number | null, volumeBackupCron: null as string | null,
  volumeBackupRetention: 7, volumeBackupRetentionDays: null as number | null, volumeBackupMaxSizeGb: null as number | null,
  volumeBackupDestinationId: null as string | null,
};

function make(opts: { app?: Partial<typeof app0>; dest?: unknown; policies?: unknown[]; rows?: unknown[]; permThrows?: boolean } = {}) {
  const cur = { ...app0, ...opts.app };
  const update = jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...cur, ...data }));
  const upsert = jest.fn().mockImplementation(({ create }) => Promise.resolve({ id: "p1", ...create }));
  const prisma = {
    application: { findUnique: jest.fn().mockResolvedValue(cur), update },
    backupDestination: {
      findFirst: jest.fn().mockResolvedValue(opts.dest ?? null),
      findUnique: jest.fn().mockResolvedValue(opts.dest ?? null),
    },
    volumeBackupPolicy: {
      findMany: jest.fn().mockResolvedValue(opts.policies ?? []),
      findUnique: jest.fn().mockResolvedValue((opts.policies ?? [])[0] ?? null),
      upsert,
      delete: jest.fn().mockResolvedValue({}),
    },
    volumeBackup: { findMany: jest.fn().mockResolvedValue(opts.rows ?? []) },
  } as unknown as PrismaService;
  const access = {
    requirePermission: opts.permThrows ? jest.fn().mockRejectedValue(new ForbiddenException("nope")) : jest.fn().mockResolvedValue(undefined),
    teamRole: jest.fn().mockResolvedValue("OWNER"),
    requireResourceAccess: jest.fn().mockResolvedValue(undefined),
  } as unknown as TeamAccessService;
  const scheduler = {
    schedule: jest.fn().mockResolvedValue(undefined),
    scheduleCron: jest.fn().mockResolvedValue(undefined),
    unschedule: jest.fn().mockResolvedValue(undefined),
    syncPolicyJobs: jest.fn().mockResolvedValue(undefined),
    unschedulePolicy: jest.fn().mockResolvedValue(undefined),
  };
  const alerts = { onScheduleChanged: jest.fn().mockResolvedValue(undefined) };
  const runner = { volumesOf: (a: { volumes: unknown }) => a.volumes };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new VolumeBackupsService(
    prisma, access, audit as unknown as AuditService, {} as AgentWsServer, runner as never, scheduler as never, alerts as unknown as BackupAlertsService,
  );
  return { service, prisma, access, scheduler, alerts, update, upsert, audit };
}

describe("VolumeBackupsService.setSchedule — cron + retention", () => {
  it("cron wins over the interval and re-syncs per-volume jobs", async () => {
    const t = make();
    await t.service.setSchedule("u1", "a1", { enabled: true, intervalHours: 6, cron: "0 3 * * *" });
    expect(t.scheduler.scheduleCron).toHaveBeenCalledWith("a1", "0 3 * * *");
    expect(t.scheduler.schedule).not.toHaveBeenCalled();
    expect(t.scheduler.syncPolicyJobs).toHaveBeenCalledWith("a1");
    expect(t.alerts.onScheduleChanged).toHaveBeenCalledWith("volume", "a1");
  });

  it("falls back to the interval when there is no cron, and unschedules when disabled", async () => {
    const t = make();
    await t.service.setSchedule("u1", "a1", { enabled: true, intervalHours: 6 });
    expect(t.scheduler.schedule).toHaveBeenCalledWith("a1", 6 * 3600);
    const d = make();
    await d.service.setSchedule("u1", "a1", { enabled: false });
    expect(d.scheduler.unschedule).toHaveBeenCalledWith("a1");
  });

  it("an enabled schedule with neither interval nor cron is a 400 (was a silent never-run state)", async () => {
    const t = make();
    await expect(t.service.setSchedule("u1", "a1", { enabled: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.update).not.toHaveBeenCalled();
    // a STORED cron satisfies the rule when the request omits cron
    const s = make({ app: { volumeBackupCron: "0 3 * * *" } });
    await expect(s.service.setSchedule("u1", "a1", { enabled: true })).resolves.toBeDefined();
  });

  it("null clears and undefined leaves cron / retentionDays / maxSizeGb", async () => {
    const t = make();
    await t.service.setSchedule("u1", "a1", { enabled: true, intervalHours: 24 });
    let data = t.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("volumeBackupCron");
    expect(data).not.toHaveProperty("volumeBackupRetentionDays");
    expect(data).not.toHaveProperty("volumeBackupMaxSizeGb");
    const c = make();
    await c.service.setSchedule("u1", "a1", { enabled: true, intervalHours: 24, cron: null, retentionDays: null, maxSizeGb: null });
    data = c.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ volumeBackupCron: null, volumeBackupRetentionDays: null, volumeBackupMaxSizeGb: null });
    const v = make();
    await v.service.setSchedule("u1", "a1", { enabled: true, intervalHours: 24, retentionDays: 30, maxSizeGb: 50 });
    expect(v.update.mock.calls[0][0].data).toMatchObject({ volumeBackupRetentionDays: 30, volumeBackupMaxSizeGb: 50 });
  });

  it("rejects a destination that is not in the app's team", async () => {
    const t = make({ dest: null });
    await expect(t.service.setSchedule("u1", "a1", { enabled: false, destinationId: "foreign" })).rejects.toBeInstanceOf(BadRequestException);
    expect((t.prisma.backupDestination.findFirst as jest.Mock).mock.calls[0][0].where).toEqual({ id: "foreign", teamId: "t1" });
    const ok = make({ dest: { id: "d1" } });
    await ok.service.setSchedule("u1", "a1", { enabled: false, destinationId: "d1" });
    expect(ok.update.mock.calls[0][0].data.volumeBackupDestinationId).toBe("d1");
  });

  it("requires the backups permission", async () => {
    const t = make({ permThrows: true });
    await expect(t.service.setSchedule("u1", "a1", { enabled: false })).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("volume schedule DTOs", () => {
  it("rejects a cron that can fire more than hourly, and an invalid one", () => {
    expect(VolumeBackupConfigSchema.safeParse({ enabled: true, cron: "*/30 * * * *" }).success).toBe(false);
    expect(VolumeBackupConfigSchema.safeParse({ enabled: true, cron: "* * * * *" }).success).toBe(false);
    expect(VolumeBackupConfigSchema.safeParse({ enabled: true, cron: "0 25 * * *" }).success).toBe(false);
    expect(VolumeBackupConfigSchema.safeParse({ enabled: true, cron: "0 */2 * * *" }).success).toBe(true);
    expect(VolumeBackupConfigSchema.safeParse({ enabled: true, cron: null, maxSizeGb: null }).success).toBe(true);
  });
  it("the policy schema is strict and defaults enabled", () => {
    expect(VolumePolicySchema.parse({}).enabled).toBe(true);
    expect(VolumePolicySchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(VolumePolicySchema.safeParse({ cron: "*/10 * * * *" }).success).toBe(false);
  });
});

describe("VolumeBackupsService per-volume policies", () => {
  it("upserts by (appId, volumeName), maps absent fields to null (inherit) and syncs jobs + alerts + audit", async () => {
    const t = make();
    const v = await t.service.putPolicy("u1", "a1", "media", { enabled: true, cron: "0 4 * * *", retention: 3 });
    expect(t.upsert.mock.calls[0][0].where).toEqual({ appId_volumeName: { appId: "a1", volumeName: "media" } });
    expect(t.upsert.mock.calls[0][0].create).toMatchObject({ cron: "0 4 * * *", retention: 3, retentionDays: null, maxSizeGb: null, intervalHours: null });
    expect(v).toMatchObject({ volumeName: "media", cron: "0 4 * * *" });
    expect(t.scheduler.syncPolicyJobs).toHaveBeenCalledWith("a1");
    expect(t.alerts.onScheduleChanged).toHaveBeenCalledWith("volume", "a1:media");
    expect(t.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "app.volume_backup.policy" }));
  });

  it("404s for a volume the app does not declare, and enforces requireWrite", async () => {
    await expect(make().service.putPolicy("u1", "a1", "ghost", { enabled: true })).rejects.toBeInstanceOf(NotFoundException);
    await expect(make({ permThrows: true }).service.putPolicy("u1", "a1", "media", { enabled: true })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make({ permThrows: true }).service.deletePolicy("u1", "a1", "media")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("delete removes the row, its job, and re-syncs; unknown policy is 404", async () => {
    const t = make({ policies: [{ id: "p1", volumeName: "media" }] });
    await t.service.deletePolicy("u1", "a1", "media");
    expect(t.prisma.volumeBackupPolicy.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(t.scheduler.unschedulePolicy).toHaveBeenCalledWith("p1");
    expect(t.scheduler.syncPolicyJobs).toHaveBeenCalledWith("a1");
    await expect(make().service.deletePolicy("u1", "a1", "media")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("VolumeBackupsService.getConfig", () => {
  const row = (id: string, vol: string, ageH: number, gb: number | null) => ({
    id, volumeName: vol, status: "SUCCESS", createdAt: new Date(Date.now() - ageH * 3_600_000), sizeBytes: gb == null ? null : BigInt(gb) * GIB,
  });

  it("returns schedule, retention, policies, encryption flag, next cron run and per-pool usage; no secrets", async () => {
    const t = make({
      app: { volumeBackupEnabled: true, volumeBackupCron: "0 3 * * *", volumeBackupMaxSizeGb: 5, volumeBackupDestinationId: "d1" },
      dest: { id: "d1", encryptionEnabled: true },
      policies: [{ volumeName: "media", enabled: true, intervalHours: null, cron: null, retention: 2, retentionDays: null, maxSizeGb: 4 }],
      rows: [row("a", "data", 1, 3), row("b", "data", 2, 4), row("c", "media", 1, 5), row("d", "media", 2, null)],
    });
    const cfg = await t.service.getConfig("u1", "a1");
    expect(cfg).toMatchObject({ enabled: true, cron: "0 3 * * *", intervalHours: null, retention: 7, destinationId: "d1", destinationEncrypted: true });
    expect(cfg.nextRun).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(cfg.policies).toEqual([expect.objectContaining({ volumeName: "media", retention: 2, maxSizeGb: 4 })]);
    const app = cfg.usage.find((u) => u.pool === "app")!;
    expect(app).toMatchObject({ usedBytes: (7n * GIB).toString(), backupCount: 2, unknownSizeCount: 0, budgetGb: 5, overBudget: false });
    const media = cfg.usage.find((u) => u.pool === "media")!;
    expect(media).toMatchObject({ usedBytes: (5n * GIB).toString(), backupCount: 2, unknownSizeCount: 1, budgetGb: 4, overBudget: true });
    expect(JSON.stringify(cfg)).not.toMatch(/secret|credential|key/i);
  });

  it("reports destinationEncrypted=null for the implicit server-disk path and nextRun=null for an interval", async () => {
    const t = make({ app: { volumeBackupEnabled: true, volumeBackupIntervalHours: 12 } });
    const cfg = await t.service.getConfig("u1", "a1");
    expect(cfg.destinationEncrypted).toBeNull();
    expect(cfg.nextRun).toBeNull();
    expect(cfg.usage).toEqual([expect.objectContaining({ pool: "app", backupCount: 0, budgetGb: null, overBudget: false })]);
  });
});
