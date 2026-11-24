import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TeamAccessService, canAccessResource } from "../common/team-access.service";
import { loadProjectCtxMany } from "../common/resource-project";
import { ServersService } from "../servers/servers.service";
import { MetricsService } from "../metrics/metrics.service";
import { forecastDisk, rankBackups, type BackupDigestRow, type DiskPoint } from "./insights";
import type { DashboardInsights } from "./dto";

const BACKUP_WINDOW_DAYS = 7;
const BACKUP_RECENT = 6;
const DEPLOY_RECENT = 8;
const FORECAST_DAYS = 7;
const FORECAST_MAX_SERVERS = 200;
const DEPLOY_STATUSES = ["QUEUED", "RUNNING", "SUCCESS", "FAILED", "CANCELLED"] as const;

/** Read-only digests for the Command Center cards. Every query is limited to the teams the caller belongs to
 *  (optionally narrowed to one `teamId`), and a project-restricted member only sees the apps and databases they
 *  were granted — the same rules as the app / database / server lists. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly servers: ServersService,
    private readonly metrics: MetricsService,
  ) {}

  async insights(userId: string, teamId?: string): Promise<DashboardInsights> {
    const accessByTeam = await this.access.accessByTeam(userId);
    const teamIds = [...accessByTeam.keys()].filter((id) => !teamId || id === teamId);
    if (teamIds.length === 0) {
      return { diskForecast: [], backups: { windowDays: BACKUP_WINDOW_DAYS, ok: 0, failed: 0, running: 0, recent: [] }, deploys: [] };
    }
    const [diskForecast, resources] = await Promise.all([
      this.diskForecast(userId, teamId),
      this.visibleResources(accessByTeam, teamIds),
    ]);
    const [backups, deploys] = await Promise.all([this.backupDigest(resources), this.deployDigest(resources)]);
    return { diskForecast, backups, deploys };
  }

  /** Apps and databases the caller may see, with names (so no second lookup is needed). */
  private async visibleResources(accessByTeam: Awaited<ReturnType<TeamAccessService["accessByTeam"]>>, teamIds: string[]) {
    const [apps, dbs] = await Promise.all([
      this.prisma.application.findMany({ where: { teamId: { in: teamIds }, isPreview: false }, select: { id: true, name: true, teamId: true, environmentId: true } }),
      this.prisma.database.findMany({ where: { teamId: { in: teamIds } }, select: { id: true, name: true, teamId: true, environmentId: true } }),
    ]);
    const ctx = await loadProjectCtxMany(this.prisma, [...apps, ...dbs].map((r) => r.environmentId));
    const ok = <T extends { id: string; teamId: string; environmentId: string }>(r: T) =>
      canAccessResource(accessByTeam.get(r.teamId), r.id, ctx.get(r.environmentId)?.projectId ?? null);
    return { apps: apps.filter(ok), dbs: dbs.filter(ok) };
  }

  private async diskForecast(userId: string, teamId?: string): Promise<DashboardInsights["diskForecast"]> {
    const servers = (await this.servers.listForUser(userId, { teamId })).slice(0, FORECAST_MAX_SERVERS);
    if (servers.length === 0) return [];
    const ids = servers.map((s) => s.id);
    const since = new Date(Date.now() - FORECAST_DAYS * 86_400_000);
    const [latest, hourly] = await Promise.all([
      this.metrics.latestForServers(ids),
      this.prisma.$queryRaw<{ serverId: string; h: Date; used: number }[]>(Prisma.sql`
        SELECT "serverId", date_trunc('hour', "bucket") AS h, AVG("avgDiskUsed")::float8 AS used
        FROM "MetricRollup"
        WHERE "serverId" IN (${Prisma.join(ids)}) AND "bucket" >= ${since}
        GROUP BY "serverId", date_trunc('hour', "bucket")
        ORDER BY "serverId", h ASC`),
    ]);
    const pointsBy = new Map<string, DiskPoint[]>();
    for (const r of hourly) {
      const arr = pointsBy.get(r.serverId) ?? [];
      arr.push({ ts: new Date(r.h).getTime(), used: Number(r.used) });
      pointsBy.set(r.serverId, arr);
    }
    const sampleBy = new Map(latest.map((l) => [l.serverId, l.sample]));
    const out: DashboardInsights["diskForecast"] = [];
    for (const s of servers) {
      const sample = sampleBy.get(s.id);
      const total = Number(sample?.diskTotal);
      const used = Number(sample?.diskUsed);
      if (!(total > 0) || !Number.isFinite(used)) continue; // never reported a disk → nothing to forecast
      const f = forecastDisk(pointsBy.get(s.id) ?? [], total);
      out.push({
        serverId: s.id,
        serverName: s.name,
        usedPct: Math.round((used / total) * 1000) / 10,
        freeBytes: Math.max(0, total - used),
        growthBytesPerDay: f ? Math.round(f.growthBytesPerDay) : null,
        daysToFull: f ? f.daysToFull : null,
      });
    }
    // Soonest-full first; servers with no forecast sort after, fullest disk first.
    return out.sort((a, b) => (a.daysToFull ?? Infinity) - (b.daysToFull ?? Infinity) || b.usedPct - a.usedPct);
  }

  private async backupDigest(res: { apps: { id: string; name: string }[]; dbs: { id: string; name: string }[] }): Promise<DashboardInsights["backups"]> {
    const since = new Date(Date.now() - BACKUP_WINDOW_DAYS * 86_400_000);
    const dbIds = res.dbs.map((d) => d.id);
    const appIds = res.apps.map((a) => a.id);
    const dbName = new Map(res.dbs.map((d) => [d.id, d.name]));
    const appName = new Map(res.apps.map((a) => [a.id, a.name]));
    const dbWhere = { databaseId: { in: dbIds }, createdAt: { gte: since } };
    const volWhere = { appId: { in: appIds }, createdAt: { gte: since } };
    const dbSel = { id: true, databaseId: true, status: true, createdAt: true, sizeBytes: true } as const;
    const volSel = { id: true, appId: true, status: true, createdAt: true, sizeBytes: true } as const;
    const [dbCounts, volCounts, dbRecent, volRecent, dbFailed, volFailed] = await Promise.all([
      dbIds.length ? this.prisma.backup.groupBy({ by: ["status"], where: dbWhere, _count: { _all: true } }) : [],
      appIds.length ? this.prisma.volumeBackup.groupBy({ by: ["status"], where: volWhere, _count: { _all: true } }) : [],
      dbIds.length ? this.prisma.backup.findMany({ where: dbWhere, orderBy: { createdAt: "desc" }, take: BACKUP_RECENT, select: dbSel }) : [],
      appIds.length ? this.prisma.volumeBackup.findMany({ where: volWhere, orderBy: { createdAt: "desc" }, take: BACKUP_RECENT, select: volSel }) : [],
      // Asked for separately so a long run of successes can never push a failure out of the short list.
      dbIds.length ? this.prisma.backup.findMany({ where: { ...dbWhere, status: "FAILED" }, orderBy: { createdAt: "desc" }, take: BACKUP_RECENT, select: dbSel }) : [],
      appIds.length ? this.prisma.volumeBackup.findMany({ where: { ...volWhere, status: "FAILED" }, orderBy: { createdAt: "desc" }, take: BACKUP_RECENT, select: volSel }) : [],
    ]);
    const dbRows = [...new Map([...dbFailed, ...dbRecent].map((r) => [r.id, r])).values()];
    const volRows = [...new Map([...volFailed, ...volRecent].map((r) => [r.id, r])).values()];
    const count = (status: string) => [...dbCounts, ...volCounts].filter((c) => c.status === status).reduce((n, c) => n + c._count._all, 0);
    const rows: BackupDigestRow[] = [
      ...dbRows.map((r) => ({ id: r.id, kind: "database" as const, resourceId: r.databaseId, resourceName: dbName.get(r.databaseId) ?? r.databaseId, status: r.status, createdAt: r.createdAt.toISOString(), sizeBytes: r.sizeBytes == null ? null : Number(r.sizeBytes) })),
      ...volRows.map((r) => ({ id: r.id, kind: "volume" as const, resourceId: r.appId, resourceName: appName.get(r.appId) ?? r.appId, status: r.status, createdAt: r.createdAt.toISOString(), sizeBytes: r.sizeBytes == null ? null : Number(r.sizeBytes) })),
    ];
    return {
      windowDays: BACKUP_WINDOW_DAYS,
      ok: count("SUCCESS"),
      failed: count("FAILED"),
      running: count("PENDING") + count("RUNNING"),
      recent: rankBackups(rows, BACKUP_RECENT),
    };
  }

  private async deployDigest(res: { apps: { id: string; name: string }[] }): Promise<DashboardInsights["deploys"]> {
    if (res.apps.length === 0) return [];
    const appName = new Map(res.apps.map((a) => [a.id, a.name]));
    const rows = await this.prisma.deployment.findMany({
      where: { appId: { in: [...appName.keys()] } },
      orderBy: { createdAt: "desc" },
      take: DEPLOY_RECENT,
      select: { id: true, appId: true, status: true, trigger: true, createdAt: true, durationMs: true },
    });
    return rows
      .filter((r) => (DEPLOY_STATUSES as readonly string[]).includes(r.status))
      .map((r) => ({
        id: r.id,
        appId: r.appId,
        appName: appName.get(r.appId) ?? r.appId,
        status: r.status,
        trigger: r.trigger,
        createdAt: r.createdAt.toISOString(),
        durationMs: r.durationMs,
      }));
  }
}
