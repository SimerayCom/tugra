import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { NotificationQueueService } from "./queue.service";
import { buildSuggestions, DIGEST_HOUR, hubTimeZone, isDigestDue, type WeekStats } from "./digest-stats";
import type { NotificationEvent } from "./event";

const WEEK_MS = 7 * 86_400_000;

export interface DigestView {
  teamId: string;
  enabled: boolean;
  channelId: string | null;
  channelName: string | null;
  lastSentAt: string | null;
  /** When it goes out: Monday, this hour, in this time zone (the hub's). */
  hour: number;
  timezone: string;
}

/**
 * The opt-in weekly team digest: deploys, failures, backups, downtime, the busiest server and a few
 * suggestions, sent Monday morning (hub time) to the team's chosen channel. Settings live in TeamDigest;
 * `lastSentAt` is the atomic claim that keeps a restart or a second hub from sending twice in one week.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly queue: NotificationQueueService,
  ) {}

  private view(teamId: string, row: { enabled: boolean; channelId: string | null; lastSentAt: Date | null; channel?: { name: string } | null } | null): DigestView {
    return {
      teamId,
      enabled: row?.enabled ?? false,
      channelId: row?.channelId ?? null,
      channelName: row?.channel?.name ?? null,
      lastSentAt: row?.lastSentAt?.toISOString() ?? null,
      hour: DIGEST_HOUR,
      timezone: hubTimeZone(),
    };
  }

  /** Any team member may read the setting (mirrors channel list / deliveries). */
  async get(userId: string, teamId: string): Promise<DigestView> {
    if (!(await this.access.teamRole(userId, teamId))) throw new NotFoundException("team not found");
    const row = await this.prisma.teamDigest.findUnique({ where: { teamId }, include: { channel: { select: { name: true } } } });
    return this.view(teamId, row);
  }

  async update(userId: string, teamId: string, dto: { enabled: boolean; channelId?: string | null }): Promise<DigestView> {
    await this.access.requirePermission(userId, teamId, "integrations");
    const existing = await this.prisma.teamDigest.findUnique({ where: { teamId } });
    const channelId = dto.channelId === undefined ? (existing?.channelId ?? null) : dto.channelId;
    if (channelId) {
      const ch = await this.prisma.notificationChannel.findUnique({ where: { id: channelId }, select: { teamId: true } });
      if (!ch || ch.teamId !== teamId) throw new BadRequestException("choose one of this team's channels");
    }
    if (dto.enabled && !channelId) throw new BadRequestException("choose a channel for the digest");
    // Turning it on mid-week must not fire at once: claim this week up front, the next Monday is the first send.
    const turningOn = dto.enabled && !existing?.enabled;
    const row = await this.prisma.teamDigest.upsert({
      where: { teamId },
      create: { teamId, enabled: dto.enabled, channelId, lastSentAt: turningOn ? new Date() : null },
      update: { enabled: dto.enabled, channelId, ...(turningOn ? { lastSentAt: new Date() } : {}) },
      include: { channel: { select: { name: true } } },
    });
    await this.audit.log({ actor: userId, action: "digest.update", target: teamId });
    return this.view(teamId, row);
  }

  /** "Send it now": a real digest to the chosen channel, one synchronous attempt so a bad channel shows up. */
  async sendNow(userId: string, teamId: string): Promise<void> {
    await this.access.requirePermission(userId, teamId, "integrations");
    const row = await this.prisma.teamDigest.findUnique({ where: { teamId } });
    if (!row?.channelId) throw new BadRequestException("choose a channel for the digest");
    const channel = await this.prisma.notificationChannel.findUnique({ where: { id: row.channelId }, select: { locale: true } });
    if (!channel) throw new BadRequestException("choose a channel for the digest");
    const event = await this.buildEvent(teamId, channel.locale, new Date());
    await this.queue.deliverNow(row.channelId, event);
  }

  /** The sweep: send every digest that is due. One team failing never stops the others. */
  async runDue(now: Date = new Date()): Promise<number> {
    const tz = hubTimeZone();
    const rows = await this.prisma.teamDigest.findMany({
      where: { enabled: true, channelId: { not: null } },
      include: { channel: { select: { locale: true, enabled: true } } },
    });
    let sent = 0;
    for (const row of rows) {
      // A disabled channel gets nothing (the digest waits until the channel is turned back on).
      if (!row.channelId || !row.channel || row.channel.enabled === false || !isDigestDue(now, row.lastSentAt, tz)) continue;
      let claimed = false;
      try {
        // Claim first (compare-and-set on lastSentAt): only one hub / one sweep wins a given week.
        const claim = await this.prisma.teamDigest.updateMany({
          where: { teamId: row.teamId, enabled: true, lastSentAt: row.lastSentAt },
          data: { lastSentAt: now },
        });
        if (claim.count !== 1) continue;
        claimed = true;
        const event = await this.buildEvent(row.teamId, row.channel.locale, now);
        await this.queue.enqueue(row.channelId, event, { bypassPolicy: true });
        sent++;
      } catch (err) {
        this.logger.warn(`digest for team ${row.teamId} failed: ${err instanceof Error ? err.message : String(err)}`);
        // Give the claim back so the next sweep (within the grace window) tries again instead of losing the week.
        if (claimed) {
          await this.prisma.teamDigest
            .updateMany({ where: { teamId: row.teamId, lastSentAt: now }, data: { lastSentAt: row.lastSentAt } })
            .catch(() => undefined);
        }
      }
    }
    return sent;
  }

  async buildEvent(teamId: string, locale: string, now: Date): Promise<NotificationEvent> {
    const team = await this.prisma.team.findUnique({ where: { id: teamId }, select: { name: true } });
    const stats = await this.collect(teamId, now);
    return {
      type: "weekly_digest",
      teamId,
      locale,
      ctx: {
        teamName: team?.name ?? "",
        periodStart: new Date(now.getTime() - WEEK_MS).toISOString(),
        periodEnd: now.toISOString(),
        deploys: stats.deploys,
        backups: stats.backups,
        incidents: stats.incidents,
        busiestServer: stats.busiestServer,
        suggestions: buildSuggestions(stats),
      },
    };
  }

  /** The week's numbers for a team (read-only aggregate queries, no per-row loops). */
  async collect(teamId: string, now: Date): Promise<WeekStats> {
    const since = new Date(now.getTime() - WEEK_MS);
    const counts = (rows: Array<{ status: string; _count: { _all: number } }>) => {
      const by = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
      return { ok: by("SUCCESS"), failed: by("FAILED") };
    };
    const [deployRows, failedByApp, dbBackupRows, volBackupRows, withoutBackup, incidents, servers] = await Promise.all([
      this.prisma.deployment.groupBy({
        by: ["status"],
        where: { application: { teamId }, kind: "DEPLOY", createdAt: { gte: since }, status: { in: ["SUCCESS", "FAILED"] } },
        _count: { _all: true },
      }),
      this.prisma.deployment.groupBy({
        by: ["appId"],
        where: { application: { teamId }, kind: "DEPLOY", createdAt: { gte: since }, status: "FAILED" },
        _count: { _all: true },
        orderBy: { _count: { appId: "desc" } },
        take: 1,
      }),
      this.prisma.backup.groupBy({
        by: ["status"],
        where: { database: { teamId }, createdAt: { gte: since }, status: { in: ["SUCCESS", "FAILED"] } },
        _count: { _all: true },
      }),
      this.prisma.volumeBackup.groupBy({
        by: ["status"],
        where: { app: { teamId }, createdAt: { gte: since }, status: { in: ["SUCCESS", "FAILED"] } },
        _count: { _all: true },
      }),
      this.prisma.database.count({ where: { teamId, status: "RUNNING", backups: { none: { status: "SUCCESS", createdAt: { gte: since } } } } }),
      this.prisma.heartbeat.count({ where: { monitor: { teamId }, status: "DOWN", important: true, ts: { gte: since } } }),
      this.prisma.server.findMany({ where: { teamId }, select: { id: true, name: true } }),
    ]);

    const d = counts(deployRows);
    const db = counts(dbBackupRows);
    const vol = counts(volBackupRows);

    let worstApp: WeekStats["worstApp"] = null;
    if (failedByApp[0]) {
      const app = await this.prisma.application.findUnique({ where: { id: failedByApp[0].appId }, select: { name: true } });
      if (app) worstApp = { name: app.name, failed: failedByApp[0]._count._all };
    }

    // Busiest server by average CPU over the week, and the fullest disk, from the 1-minute rollups (raw
    // samples as a fallback while a young hub has no rollups yet).
    const ids = servers.map((s) => s.id);
    const name = new Map(servers.map((s) => [s.id, s.name]));
    let busiestServer: WeekStats["busiestServer"] = null;
    let fullestDisk: WeekStats["fullestDisk"] = null;
    if (ids.length) {
      let rows: Array<{ serverId: string; cpu: number; disk: number }> = [];
      const rolled = await this.prisma.metricRollup.groupBy({
        by: ["serverId"],
        where: { serverId: { in: ids }, bucket: { gte: since } },
        _avg: { avgCpu: true, avgDiskUsed: true, avgDiskTotal: true },
      });
      rows = rolled.map((r) => ({
        serverId: r.serverId,
        cpu: Number(r._avg.avgCpu ?? 0),
        disk: Number(r._avg.avgDiskTotal ?? 0) > 0 ? (Number(r._avg.avgDiskUsed ?? 0) / Number(r._avg.avgDiskTotal)) * 100 : 0,
      }));
      if (rows.length === 0) {
        const raw = await this.prisma.metric.groupBy({
          by: ["serverId"],
          where: { serverId: { in: ids }, ts: { gte: since } },
          _avg: { cpu: true, diskUsed: true, diskTotal: true },
        });
        rows = raw.map((r) => ({
          serverId: r.serverId,
          cpu: Number(r._avg.cpu ?? 0),
          disk: Number(r._avg.diskTotal ?? 0) > 0 ? (Number(r._avg.diskUsed ?? 0) / Number(r._avg.diskTotal)) * 100 : 0,
        }));
      }
      const topCpu = [...rows].sort((a, b) => b.cpu - a.cpu)[0];
      if (topCpu && name.get(topCpu.serverId)) busiestServer = { name: name.get(topCpu.serverId)!, cpuPct: topCpu.cpu };
      const topDisk = [...rows].sort((a, b) => b.disk - a.disk)[0];
      if (topDisk && name.get(topDisk.serverId)) fullestDisk = { name: name.get(topDisk.serverId)!, pct: topDisk.disk };
    }

    return {
      deploys: { total: d.ok + d.failed, failed: d.failed },
      worstApp,
      backups: { total: db.ok + db.failed + vol.ok + vol.failed, failed: db.failed + vol.failed },
      databasesWithoutBackup: withoutBackup,
      incidents,
      busiestServer,
      fullestDisk,
    };
  }
}
