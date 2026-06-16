import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Monitor, MonitorStatus, MonitorType, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { MonitorRunnerService } from "./runner.service";
import { MonitorSchedulerService } from "./scheduler.service";
import { uptimePercent } from "./transition";
import type { CreateMonitorInput } from "./dto";

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
  enabled: boolean;
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
    const roleByTeam = await this.access.roleByTeam(userId);
    const ids = [...roleByTeam.keys()];
    if (!ids.length) return [];
    const rows = await this.prisma.monitor.findMany({
      where: { teamId: { in: ids } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((m) => this.view(m, roleByTeam.get(m.teamId)!));
  }

  async get(userId: string, id: string): Promise<MonitorView> {
    const m = await this.require(userId, id);
    const role = (await this.access.teamRole(userId, m.teamId))!;
    return this.view(m, role);
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
    return m;
  }

  private view(m: Monitor, role: Role): MonitorView {
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
      enabled: m.enabled,
      teamId: m.teamId,
      role,
      canWrite: WRITE.includes(role),
      createdAt: m.createdAt,
    };
  }
}
