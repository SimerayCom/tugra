import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Monitor, MonitorStatus, MonitorType, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService, canAccessResource } from "../common/team-access.service";
import { loadProjectCtx, loadProjectCtxMany } from "../common/resource-project";
import { MonitorRunnerService } from "./runner.service";
import { MonitorSchedulerService } from "./scheduler.service";
import { uptimePercent } from "./transition";
import { planTargets } from "../bulk/bulk.service";
import type { CreateMonitorInput, UpdateMonitorInput } from "./dto";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];

export interface MonitorView {
  id: string;
  name: string;
  type: MonitorType;
  target: string;
  serverId: string | null;
  metric: string | null;
  thresholdPct: number | null;
  status: MonitorStatus;
  intervalSec: number;
  retries: number;
  timeoutMs: number;
  resendEvery: number;
  enabled: boolean;
  auto: boolean;
  appId: string | null;
  channelIds: string[];
  teamId: string;
  role: Role;
  canWrite: boolean;
  createdAt: Date;
}

@Injectable()
export class MonitorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly runner: MonitorRunnerService,
    private readonly scheduler: MonitorSchedulerService,
  ) {}

  async create(userId: string, dto: CreateMonitorInput): Promise<MonitorView> {
    await this.access.requireRole(userId, dto.teamId, WRITE);
    const m = await this.prisma.monitor.create({
      data: {
        name: dto.name,
        type: dto.type as MonitorType,
        target: dto.target ?? dto.metric ?? "",
        serverId: dto.serverId ?? null,
        metric: dto.metric ?? null,
        thresholdPct: dto.thresholdPct ?? null,
        teamId: dto.teamId,
        intervalSec: dto.intervalSec ?? 30,
        retries: dto.retries ?? 1,
        timeoutMs: dto.timeoutMs ?? 10000,
        resendEvery: dto.resendEvery ?? 0,
      },
    });
    if (dto.channelIds?.length) {
      await this.prisma.monitorChannel.createMany({
        data: dto.channelIds.map((channelId) => ({ monitorId: m.id, channelId })),
        skipDuplicates: true,
      });
    }
    await this.audit.log({ actor: userId, action: "monitor.create", target: m.id });
    await this.scheduler.schedule(m.id, m.intervalSec);
    return this.view(m, Role.OWNER);
  }

  async list(userId: string): Promise<MonitorView[]> {
    const access = await this.access.accessByTeam(userId);
    const ids = [...access.keys()];
    if (!ids.length) return [];
    const rows = await this.prisma.monitor.findMany({
      where: { teamId: { in: ids } },
      orderBy: { createdAt: "desc" },
    });
    // Per-resource scoping: a monitor's project is its app's project. A restricted member only sees
    // monitors for apps in their granted projects; standalone monitors (no app) are hidden from them.
    const projectByApp = await this.projectIdsForApps(rows.map((m) => m.appId));
    return rows
      .filter((m) => canAccessResource(access.get(m.teamId), m.appId ?? m.id, m.appId ? projectByApp.get(m.appId) ?? null : null))
      .map((m) => this.view(m, access.get(m.teamId)!.role));
  }

  /** Owning project id per app id, for monitor scoping (batched, no N+1). */
  private async projectIdsForApps(appIds: (string | null)[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(appIds.filter(Boolean))] as string[];
    if (!ids.length) return new Map();
    const apps = await this.prisma.application.findMany({ where: { id: { in: ids } }, select: { id: true, environmentId: true } });
    const ctxByEnv = await loadProjectCtxMany(this.prisma, apps.map((a) => a.environmentId));
    return new Map(apps.map((a) => [a.id, ctxByEnv.get(a.environmentId)?.projectId ?? null]));
  }

  private async monitorProjectId(appId: string | null): Promise<string | null> {
    if (!appId) return null;
    const app = await this.prisma.application.findUnique({ where: { id: appId }, select: { environmentId: true } });
    return app ? (await loadProjectCtx(this.prisma, app.environmentId)).projectId : null;
  }

  async get(userId: string, id: string): Promise<MonitorView> {
    const m = await this.require(userId, id);
    const role = (await this.access.teamRole(userId, m.teamId))!;
    const channels = await this.prisma.monitorChannel.findMany({
      where: { monitorId: id },
      select: { channelId: true },
    });
    return this.view(m, role, channels.map((c) => c.channelId));
  }

  /** Edit an existing monitor; re-schedules when the cadence/enabled changes. */
  async update(userId: string, id: string, dto: UpdateMonitorInput): Promise<MonitorView> {
    const m = await this.prisma.monitor.findUnique({ where: { id } });
    if (!m) throw new NotFoundException("monitor not found");
    await this.access.requireRole(userId, m.teamId, WRITE);

    const updated = await this.prisma.monitor.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        intervalSec: dto.intervalSec ?? undefined,
        retries: dto.retries ?? undefined,
        timeoutMs: dto.timeoutMs ?? undefined,
        resendEvery: dto.resendEvery ?? undefined,
        enabled: dto.enabled ?? undefined,
      },
    });
    if (dto.channelIds !== undefined) {
      await this.prisma.monitorChannel.deleteMany({ where: { monitorId: id } });
      if (dto.channelIds.length) {
        await this.prisma.monitorChannel.createMany({
          data: dto.channelIds.map((channelId) => ({ monitorId: id, channelId })),
          skipDuplicates: true,
        });
      }
    }
    // Cadence/enabled affect the BullMQ repeatable job → re-schedule.
    if (dto.intervalSec !== undefined || dto.enabled !== undefined) {
      await this.scheduler.unschedule(id);
      if (updated.enabled) await this.scheduler.schedule(id, updated.intervalSec);
    }
    await this.audit.log({ actor: userId, action: "monitor.update", target: id });
    const role = (await this.access.teamRole(userId, m.teamId))!;
    return this.view(updated, role, dto.channelIds);
  }

  /**
   * Set the same notification channels on many monitors (fleet alert op). Each
   * monitor is role-gated; channels are team-scoped, so a monitor only receives
   * the picked channels that belong to ITS team. A writable monitor with no
   * matching-team channel is SKIPPED (its existing channels are left intact).
   */
  async setChannelsBulk(
    userId: string,
    monitorIds: string[],
    channelIds: string[],
  ): Promise<{ applied: string[]; skipped: string[] }> {
    const monitors = await this.prisma.monitor.findMany({
      where: { id: { in: monitorIds } },
      select: { id: true, teamId: true },
    });
    const channels = await this.prisma.notificationChannel.findMany({
      where: { id: { in: channelIds } },
      select: { id: true, teamId: true },
    });
    const roleByTeam = await this.access.roleByTeam(userId);
    const plan = planTargets(monitorIds, monitors, roleByTeam);

    const applied: string[] = [];
    const skipped: string[] = [];
    for (const target of plan) {
      const mon = monitors.find((x) => x.id === target.serverId);
      const matching = mon ? channels.filter((c) => c.teamId === mon.teamId).map((c) => c.id) : [];
      if (!target.run || matching.length === 0) {
        skipped.push(target.serverId);
        continue;
      }
      await this.prisma.$transaction([
        this.prisma.monitorChannel.deleteMany({ where: { monitorId: target.serverId } }),
        this.prisma.monitorChannel.createMany({
          data: matching.map((channelId) => ({ monitorId: target.serverId, channelId })),
          skipDuplicates: true,
        }),
      ]);
      applied.push(target.serverId);
    }
    if (applied.length > 0) {
      await this.audit.log({
        actor: userId,
        action: "monitor.channels.bulk",
        target: applied.join(","),
        meta: { count: applied.length },
      });
    }
    return { applied, skipped };
  }

  /** Auto-create an uptime monitor for an app's domain (system; no RBAC). */
  async createForApp(app: {
    id: string;
    name: string;
    teamId: string;
    domain: string | null;
    https: boolean;
    isPreview: boolean;
  }): Promise<void> {
    if (!app.domain || app.isPreview) return;
    const m = await this.prisma.monitor.create({
      data: {
        name: app.name,
        type: MonitorType.HTTP,
        target: `${app.https ? "https" : "http"}://${app.domain}`,
        teamId: app.teamId,
        appId: app.id,
        auto: true,
      },
    });
    await this.audit.log({ actor: "system", action: "monitor.auto.create", target: m.id });
    await this.scheduler.schedule(m.id, m.intervalSec);
  }

  /** Remove the auto monitor(s) for an app (system; called on app delete). */
  async removeForApp(appId: string): Promise<void> {
    const autos = await this.prisma.monitor.findMany({
      where: { appId, auto: true },
      select: { id: true },
    });
    for (const a of autos) await this.scheduler.unschedule(a.id);
    if (autos.length) {
      await this.prisma.monitor.deleteMany({ where: { appId, auto: true } });
      await this.audit.log({ actor: "system", action: "monitor.auto.remove", target: appId });
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const m = await this.prisma.monitor.findUnique({ where: { id } });
    if (!m) throw new NotFoundException("monitor not found");
    await this.access.requireRole(userId, m.teamId, WRITE);
    await this.scheduler.unschedule(id);
    await this.prisma.monitor.delete({ where: { id } });
  }

  async heartbeats(userId: string, id: string, limit: number) {
    await this.require(userId, id);
    const rows = await this.prisma.heartbeat.findMany({
      where: { monitorId: id },
      orderBy: { ts: "desc" },
      take: Math.min(Math.max(limit, 1), 500),
    });
    return rows.reverse().map((h) => ({
      ts: h.ts.getTime(),
      status: h.status,
      ms: h.ms,
      msg: h.msg,
      important: h.important,
    }));
  }

  async uptime(userId: string, id: string) {
    await this.require(userId, id);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const total = await this.prisma.heartbeat.count({
      where: { monitorId: id, ts: { gte: since } },
    });
    const up = await this.prisma.heartbeat.count({
      where: { monitorId: id, ts: { gte: since }, status: MonitorStatus.UP },
    });
    return { percent: uptimePercent(up, total), total };
  }

  check(userId: string, id: string) {
    return this.require(userId, id).then(() => this.runner.runCheck(id));
  }

  private async require(userId: string, id: string): Promise<Monitor> {
    const m = await this.prisma.monitor.findUnique({ where: { id } });
    if (!m) throw new NotFoundException("monitor not found");
    if (!(await this.access.teamRole(userId, m.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    // Per-resource scoping: a restricted member only reaches monitors for apps they can access.
    await this.access.requireResourceAccess(userId, m.teamId, {
      resourceId: m.appId ?? m.id,
      resolveProjectId: () => this.monitorProjectId(m.appId),
    });
    return m;
  }

  private view(m: Monitor, role: Role, channelIds: string[] = []): MonitorView {
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      target: m.target,
      serverId: m.serverId,
      metric: m.metric,
      thresholdPct: m.thresholdPct,
      status: m.status,
      intervalSec: m.intervalSec,
      retries: m.retries,
      timeoutMs: m.timeoutMs,
      resendEvery: m.resendEvery,
      enabled: m.enabled,
      auto: m.auto,
      appId: m.appId,
      channelIds,
      teamId: m.teamId,
      role,
      canWrite: WRITE.includes(role),
      createdAt: m.createdAt,
    };
  }
}
