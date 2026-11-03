import { ForbiddenException } from "@nestjs/common";
import { CleanupService } from "./cleanup.service";
import { CleanupRunnerService } from "./cleanup-runner.service";
import { CleanupSchedulerService } from "./cleanup.scheduler.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService } from "../common/team-access.service";
import { AuditService } from "../audit/audit.service";

const audit = { log: jest.fn() } as unknown as AuditService;

const ALL_PERMS = [
  "apps:deploy",
  "apps:config",
  "databases",
  "backups",
  "servers:manage",
  "servers:ops",
  "terminal",
  "bulk",
  "monitors",
  "projects",
  "integrations",
  "variables",
];
const allPerms = () => new Set(ALL_PERMS);

function make(
  prisma: Partial<PrismaService>,
  access: Partial<TeamAccessService>,
  runner: Partial<CleanupRunnerService> = {},
  scheduler: Partial<CleanupSchedulerService> = {},
  agentWs: Partial<AgentWsServer> = {},
) {
  return new CleanupService(
    prisma as PrismaService,
    access as TeamAccessService,
    audit,
    runner as CleanupRunnerService,
    scheduler as CleanupSchedulerService,
    agentWs as AgentWsServer,
  );
}

const server = { id: "s1", teamId: "t1", cleanupVolumes: false };

describe("CleanupService", () => {
  it("forbids a viewer from cleaning up", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockRejectedValue(new ForbiddenException("insufficient role")),
    } as unknown as TeamAccessService;
    const svc = make(prisma, access);
    await expect(svc.cleanupNow("u1", "s1")).rejects.toThrow(/insufficient role/);
  });

  it("runs cleanup via the runner for a writer", async () => {
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
    } as unknown as TeamAccessService;
    const runner = { runCleanup: jest.fn().mockResolvedValue({ ok: true, reclaimed: "1GB", output: "reclaimed 1GB" }) } as unknown as CleanupRunnerService;
    const out = await make(prisma, access, runner).cleanupNow("u1", "s1");
    expect(runner.runCleanup).toHaveBeenCalledWith("s1", "u1");
    // cleanupNow forwards the runner's outcome so "Clean now" can show success vs failure + the reclaimed size.
    expect(out).toEqual({ ok: true, reclaimed: "1GB", output: "reclaimed 1GB" });
  });

  it("schedules when enabled, unschedules otherwise", async () => {
    const update = jest.fn().mockResolvedValue({ ...server, cleanupEnabled: true, cleanupIntervalHours: 12 });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(server), update },
    } as unknown as PrismaService;
    const access = {
      requirePermission: jest.fn().mockResolvedValue(undefined),
    } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as CleanupSchedulerService;
    await make(prisma, access, {}, scheduler).setConfig("u1", "s1", { enabled: true, intervalHours: 12, volumes: true });
    expect(scheduler.schedule).toHaveBeenCalledWith("s1", 12 * 3600);
  });

  it("a cron expression overrides the interval (scheduleCron, not schedule)", async () => {
    const update = jest.fn().mockResolvedValue({ ...server, cleanupEnabled: true, cleanupIntervalHours: 12, cleanupCron: "0 3 * * *" });
    const prisma = {
      server: { findUnique: jest.fn().mockResolvedValue(server), update },
    } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), scheduleCron: jest.fn(), unschedule: jest.fn() } as unknown as CleanupSchedulerService;
    await make(prisma, access, {}, scheduler).setConfig("u1", "s1", { enabled: true, intervalHours: 12, cron: "0 3 * * *" });
    expect(scheduler.scheduleCron).toHaveBeenCalledWith("s1", "0 3 * * *", undefined);
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it("omitting intervalHours keeps the stored value (no unconditional wipe)", async () => {
    const update = jest.fn().mockResolvedValue({ ...server, cleanupEnabled: true, cleanupCron: "0 4 * * *", cleanupIntervalHours: 6 });
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), scheduleCron: jest.fn(), unschedule: jest.fn() } as unknown as CleanupSchedulerService;
    await make(prisma, access, {}, scheduler).setConfig("u1", "s1", { enabled: true, cron: "0 4 * * *" });
    const data = update.mock.calls[0][0].data;
    expect("cleanupIntervalHours" in data).toBe(false); // omitted → left untouched, not cleared
    expect(data).toMatchObject({ cleanupEnabled: true, cleanupCron: "0 4 * * *" });
  });

  it("enabling with no cron or interval gets a default daily cron instead of silently never running", async () => {
    const update = jest
      .fn()
      .mockResolvedValueOnce({ ...server, cleanupEnabled: true, cleanupCron: null, cleanupIntervalHours: null })
      .mockResolvedValueOnce({ ...server, cleanupEnabled: true, cleanupCron: "0 3 * * *", cleanupIntervalHours: null });
    const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server), update } } as unknown as PrismaService;
    const access = { requirePermission: jest.fn().mockResolvedValue(undefined) } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), scheduleCron: jest.fn(), unschedule: jest.fn() } as unknown as CleanupSchedulerService;
    await make(prisma, access, {}, scheduler).setConfig("u1", "s1", { enabled: true });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith({ where: { id: "s1" }, data: { cleanupCron: "0 3 * * *" } });
    expect(scheduler.scheduleCron).toHaveBeenCalledWith("s1", "0 3 * * *", undefined);
    expect(scheduler.unschedule).not.toHaveBeenCalled();
  });

  it("setConfigBulk applies to writable servers and skips the rest (role-gated, cross-team)", async () => {
    const update = jest.fn().mockResolvedValue({ cleanupEnabled: true, cleanupIntervalHours: 24 });
    const prisma = {
      server: {
        // s3 is unknown (not returned); s1=t1 (OWNER, write), s2=t2 (VIEWER, skip)
        findMany: jest.fn().mockResolvedValue([
          { id: "s1", teamId: "t1" },
          { id: "s2", teamId: "t2" },
        ]),
        update,
      },
    } as unknown as PrismaService;
    const access = {
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t1", allPerms()], ["t2", new Set()]])),
    } as unknown as TeamAccessService;
    const scheduler = { schedule: jest.fn(), unschedule: jest.fn() } as unknown as CleanupSchedulerService;

    const res = await make(prisma, access, {}, scheduler).setConfigBulk(
      "u1",
      ["s1", "s2", "s3"],
      { enabled: true, intervalHours: 24 },
    );

    expect(res.applied).toEqual(["s1"]);
    expect(res.skipped.sort()).toEqual(["s2", "s3"]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s1" } }));
    expect(scheduler.schedule).toHaveBeenCalledWith("s1", 24 * 3600);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: "server.cleanup.config.bulk" }));
  });

  it("setConfigBulk applies nothing and skips audit when no server is writable", async () => {
    const update = jest.fn();
    const prisma = {
      server: { findMany: jest.fn().mockResolvedValue([{ id: "s2", teamId: "t2" }]), update },
    } as unknown as PrismaService;
    const access = {
      permissionsByTeam: jest.fn().mockResolvedValue(new Map([["t2", new Set()]])),
    } as unknown as TeamAccessService;
    const res = await make(prisma, access).setConfigBulk("u1", ["s2"], { enabled: false });
    expect(res.applied).toEqual([]);
    expect(res.skipped).toEqual(["s2"]);
    expect(update).not.toHaveBeenCalled();
  });

  describe("diskUsage", () => {
    const dfOut = '{"Type":"Images","TotalCount":"3","Active":"1","Size":"1GB","Reclaimable":"500MB (50%)"}';

    it("returns the parsed breakdown for a team member", async () => {
      const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
      const access = { teamRole: jest.fn().mockResolvedValue("VIEWER") } as unknown as TeamAccessService;
      const agentWs = { sendCommand: jest.fn().mockResolvedValue({ exitCode: 0, output: dfOut }) };
      const d = await make(prisma, access, {}, {}, agentWs).diskUsage("u1", "s1");
      expect(d.images).toEqual({ totalCount: 3, active: 1, size: "1GB", reclaimable: "500MB" });
      expect(agentWs.sendCommand).toHaveBeenCalledWith("s1", "docker system df --format '{{json .}}'", "cleanup", 60_000);
    });

    it("forbids a non-member", async () => {
      const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
      const access = { teamRole: jest.fn().mockResolvedValue(null) } as unknown as TeamAccessService;
      await expect(make(prisma, access, {}, {}, { sendCommand: jest.fn() }).diskUsage("u1", "s1")).rejects.toThrow(/not a member/);
    });

    it("maps an offline agent / non-zero exit to 503", async () => {
      const prisma = { server: { findUnique: jest.fn().mockResolvedValue(server) } } as unknown as PrismaService;
      const access = { teamRole: jest.fn().mockResolvedValue("OWNER") } as unknown as TeamAccessService;
      await expect(make(prisma, access, {}, {}, { sendCommand: jest.fn().mockRejectedValue(new Error("agent offline")) }).diskUsage("u1", "s1")).rejects.toThrow(/offline|unavailable|Service Unavailable/i);
      await expect(make(prisma, access, {}, {}, { sendCommand: jest.fn().mockResolvedValue({ exitCode: 1, output: "boom" }) }).diskUsage("u1", "s1")).rejects.toThrow();
    });
  });
});
