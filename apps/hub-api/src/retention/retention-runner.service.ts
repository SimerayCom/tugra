import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { metricTiers } from "../metrics/metric-tiers";

const BATCH = 5000;
// The metric tables are the big ones (millions of rows): their prune is a ctid-batched DELETE, larger batches and a short
// breather between them so a first prune after an upgrade (hours of now-expired raw rows) never holds a long lock or starves ingest.
const METRIC_BATCH = 20_000;
const METRIC_PAUSE_MS = 25;

/** The time-series tables the batched prune may touch, with the indexed column its cutoff applies to (never user input). */
const METRIC_TABLES = {
  Metric: "ts",
  ContainerMetric: "ts",
  MetricRollup: "bucket",
  ContainerMetricRollup: "bucket",
  MetricRollup5m: "bucket",
  ContainerMetricRollup5m: "bucket",
} as const;
type MetricTable = keyof typeof METRIC_TABLES;

/**
 * Deletes aged-out rows from the unbounded time-series tables (Metric, ContainerMetric, Heartbeat,
 * and the 1-minute / 5-minute rollups). Tiers (metrics/metric-tiers.ts): raw host samples
 * METRICS_RAW_RETENTION_HOURS, raw container samples METRICS_CONTAINER_RAW_RETENTION_HOURS, 1-minute rollups
 * METRICS_ROLLUP_1M_RETENTION_HOURS, 5-minute rollups METRICS_ROLLUP_RETENTION_DAYS; non-important heartbeats
 * for HEARTBEAT_RETENTION_DAYS — `important` (status-change) beats are NEVER pruned. Deletes run in small
 * batches so a large backlog never becomes one long, table-locking DELETE.
 */
@Injectable()
export class RetentionRunnerService {
  private readonly logger = new Logger(RetentionRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async prune(): Promise<{
    metric: number;
    containerMetric: number;
    heartbeat: number;
    metricRollup: number;
    containerMetricRollup: number;
    metricRollup5m: number;
    containerMetricRollup5m: number;
    deployment: number;
    notificationDelivery: number;
    auditLog: number;
    containerEvent: number;
    trafficMetric: number;
    trafficPath: number;
    trafficCountry: number;
    trafficBreakdown: number;
    trafficLatency: number;
    trafficUnique: number;
    trafficUniqueHour: number;
  }> {
    const tiers = metricTiers({
      METRICS_RAW_RETENTION_HOURS: this.config.get("METRICS_RAW_RETENTION_HOURS"),
      METRICS_CONTAINER_RAW_RETENTION_HOURS: this.config.get("METRICS_CONTAINER_RAW_RETENTION_HOURS"),
      METRICS_ROLLUP_1M_RETENTION_HOURS: this.config.get("METRICS_ROLLUP_1M_RETENTION_HOURS"),
      METRICS_ROLLUP_RETENTION_DAYS: this.config.get("METRICS_ROLLUP_RETENTION_DAYS"),
    });
    const hbDays = Number(this.config.get("HEARTBEAT_RETENTION_DAYS") ?? 30);
    const deployDays = Number(this.config.get("DEPLOYMENT_RETENTION_DAYS") ?? 90);
    const notifDays = Number(this.config.get("NOTIFICATION_RETENTION_DAYS") ?? 30);
    const auditDays = Number(this.config.get("AUDIT_RETENTION_DAYS") ?? 0);
    const containerEventDays = Number(this.config.get("CONTAINER_EVENT_RETENTION_DAYS") ?? 14);
    const trafficDays = Number(this.config.get("TRAFFIC_RETENTION_DAYS") ?? 30);
    const trafficCutoff = new Date(Date.now() - trafficDays * 86_400_000);
    const hostRawCutoff = new Date(Date.now() - tiers.hostRawMs);
    const containerRawCutoff = new Date(Date.now() - tiers.containerRawMs);
    const hbCutoff = new Date(Date.now() - hbDays * 86_400_000);
    const rollup1mCutoff = new Date(Date.now() - tiers.rollup1mMs);
    const rollup5mCutoff = new Date(Date.now() - tiers.rollup5mMs);
    const deployCutoff = new Date(Date.now() - deployDays * 86_400_000);
    const notifCutoff = new Date(Date.now() - notifDays * 86_400_000);
    const containerEventCutoff = new Date(Date.now() - containerEventDays * 86_400_000);

    const metric = await this.pruneBatched("Metric", hostRawCutoff);
    const containerMetric = await this.pruneBatched("ContainerMetric", containerRawCutoff);
    // Preserve `important` beats (monitor up/down transitions) regardless of age.
    const heartbeat = await this.pruneOlderThan(
      (take) => this.prisma.heartbeat.findMany({ where: { ts: { lt: hbCutoff }, important: false }, select: { id: true }, take }),
      (ids) => this.prisma.heartbeat.deleteMany({ where: { id: { in: ids } } }),
    );
    // The 1-minute rollups are only the input of the 5-minute tier: never drop a minute the 5-minute roll has not
    // folded yet. The 5-minute tier is filled newest-first after an upgrade (the recent days first, then backwards), so
    // "folded" is the span [oldest 5-minute bucket, newest 5-minute bucket]:
    //   - minutes newer than the newest 5-minute bucket are still waiting for the forward roll  -> cutoff <= newest;
    //   - minutes older than the oldest 5-minute bucket but inside the tier window are still waiting for the back-fill
    //     (protected range [5-minute floor, oldest)); once it has caught up, `oldest` sits at the floor and nothing is protected;
    //   - minutes older than the whole 5-minute window will never be folded and go with the normal cutoff.
    // While the 5-minute tier is empty (first run after an upgrade) the whole tier window is protected.
    const [newest5mHost, newest5mContainer, oldest5mHost, oldest5mContainer] = await Promise.all([
      this.prisma.metricRollup5m.findFirst({ orderBy: { bucket: "desc" }, select: { bucket: true } }),
      this.prisma.containerMetricRollup5m.findFirst({ orderBy: { bucket: "desc" }, select: { bucket: true } }),
      this.prisma.metricRollup5m.findFirst({ orderBy: { bucket: "asc" }, select: { bucket: true } }),
      this.prisma.containerMetricRollup5m.findFirst({ orderBy: { bucket: "asc" }, select: { bucket: true } }),
    ]);
    const guard = (newest: { bucket: Date } | null, oldest: { bucket: Date } | null) => ({
      cutoff: newest ? new Date(Math.min(rollup1mCutoff.getTime(), newest.bucket.getTime())) : rollup1mCutoff,
      protect: { from: rollup5mCutoff, to: oldest ? oldest.bucket : rollup1mCutoff },
    });
    const hostGuard = guard(newest5mHost, oldest5mHost);
    const containerGuard = guard(newest5mContainer, oldest5mContainer);
    const metricRollup = await this.pruneBatched("MetricRollup", hostGuard.cutoff, hostGuard.protect);
    const containerMetricRollup = await this.pruneBatched("ContainerMetricRollup", containerGuard.cutoff, containerGuard.protect);
    const metricRollup5m = await this.pruneBatched("MetricRollup5m", rollup5mCutoff);
    const containerMetricRollup5m = await this.pruneBatched("ContainerMetricRollup5m", rollup5mCutoff);
    // Terminal deployments past the cutoff that are NO LONGER rollback targets (no local tag, registry ref or
    // digest). A QUEUED/RUNNING row or any still-rollbackable row — including the live version, whose image is
    // never pruned — is kept, so rollback() and the auto-rollback prev-finder keep working. Each row holds up
    // to 64KB of logs, so this is the main unbounded-growth bound.
    const deployment = await this.pruneOlderThan(
      (take) => this.prisma.deployment.findMany({
        where: { createdAt: { lt: deployCutoff }, status: { in: ["SUCCESS", "FAILED", "CANCELLED"] }, imageTag: null, registryImage: null, imageDigest: null },
        select: { id: true },
        take,
      }),
      (ids) => this.prisma.deployment.deleteMany({ where: { id: { in: ids } } }),
    );
    // Delivered/failed notification rows past the cutoff; a still-PENDING delivery is never touched.
    const notificationDelivery = await this.pruneOlderThan(
      (take) => this.prisma.notificationDelivery.findMany({ where: { createdAt: { lt: notifCutoff }, status: { not: "PENDING" } }, select: { id: true }, take }),
      (ids) => this.prisma.notificationDelivery.deleteMany({ where: { id: { in: ids } } }),
    );
    // Crash/OOM episode history — bounded to CONTAINER_EVENT_RETENTION_DAYS (default 14).
    const containerEvent = await this.pruneOlderThan(
      (take) => this.prisma.containerEvent.findMany({ where: { createdAt: { lt: containerEventCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.containerEvent.deleteMany({ where: { id: { in: ids } } }),
    );
    // Minute-granular visitor-traffic aggregates — bounded to TRAFFIC_RETENTION_DAYS (default 30).
    const trafficMetric = await this.pruneOlderThan(
      (take) => this.prisma.trafficMetric.findMany({ where: { bucket: { lt: trafficCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.trafficMetric.deleteMany({ where: { id: { in: ids } } }),
    );
    const trafficPath = await this.pruneOlderThan(
      (take) => this.prisma.trafficPath.findMany({ where: { bucket: { lt: trafficCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.trafficPath.deleteMany({ where: { id: { in: ids } } }),
    );
    const trafficCountry = await this.pruneOlderThan(
      (take) => this.prisma.trafficCountry.findMany({ where: { bucket: { lt: trafficCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.trafficCountry.deleteMany({ where: { id: { in: ids } } }),
    );
    const trafficBreakdown = await this.pruneOlderThan(
      (take) => this.prisma.trafficBreakdown.findMany({ where: { bucket: { lt: trafficCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.trafficBreakdown.deleteMany({ where: { id: { in: ids } } }),
    );
    const trafficLatency = await this.pruneOlderThan(
      (take) => this.prisma.trafficLatency.findMany({ where: { bucket: { lt: trafficCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.trafficLatency.deleteMany({ where: { id: { in: ids } } }),
    );
    // Minute sketches are only read for ranges <= 24h, so they are kept ~48h (or the traffic retention if shorter);
    // the hourly rollup (TrafficUniqueHour) carries the long ranges for the full TRAFFIC_RETENTION_DAYS.
    const uniqueMinuteCutoff = new Date(Math.max(trafficCutoff.getTime(), Date.now() - 48 * 3600_000));
    const trafficUnique = await this.pruneOlderThan(
      (take) => this.prisma.trafficUnique.findMany({ where: { bucket: { lt: uniqueMinuteCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.trafficUnique.deleteMany({ where: { id: { in: ids } } }),
    );
    const trafficUniqueHour = await this.pruneOlderThan(
      (take) => this.prisma.trafficUniqueHour.findMany({ where: { bucket: { lt: trafficCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.trafficUniqueHour.deleteMany({ where: { id: { in: ids } } }),
    );
    // Audit log is compliance-sensitive → pruned ONLY when AUDIT_RETENTION_DAYS is explicitly set (> 0).
    const auditLog = auditDays > 0
      ? await this.pruneOlderThan(
          (take) => this.prisma.auditLog.findMany({ where: { createdAt: { lt: new Date(Date.now() - auditDays * 86_400_000) } }, select: { id: true }, take }),
          (ids) => this.prisma.auditLog.deleteMany({ where: { id: { in: ids } } }),
        )
      : 0;

    if (metric || containerMetric || heartbeat || metricRollup || containerMetricRollup || metricRollup5m || containerMetricRollup5m || deployment || notificationDelivery || auditLog || containerEvent || trafficMetric || trafficPath || trafficCountry || trafficBreakdown || trafficLatency || trafficUnique || trafficUniqueHour) {
      this.logger.log(
        `retention prune: metric=${metric} containerMetric=${containerMetric} heartbeat=${heartbeat} metricRollup=${metricRollup} containerMetricRollup=${containerMetricRollup} metricRollup5m=${metricRollup5m} containerMetricRollup5m=${containerMetricRollup5m} deployment=${deployment} notificationDelivery=${notificationDelivery} auditLog=${auditLog} containerEvent=${containerEvent} trafficMetric=${trafficMetric} trafficPath=${trafficPath} trafficCountry=${trafficCountry} trafficBreakdown=${trafficBreakdown} trafficLatency=${trafficLatency} trafficUnique=${trafficUnique} trafficUniqueHour=${trafficUniqueHour}`,
      );
    }
    return { metric, containerMetric, heartbeat, metricRollup, containerMetricRollup, metricRollup5m, containerMetricRollup5m, deployment, notificationDelivery, auditLog, containerEvent, trafficMetric, trafficPath, trafficCountry, trafficBreakdown, trafficLatency, trafficUnique, trafficUniqueHour };
  }

  /**
   * Delete every row of a time-series table older than `cutoff`, METRIC_BATCH rows per statement
   * (`DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT n)`: one short transaction per batch, no id round-trip through the hub).
   */
  private async pruneBatched(table: MetricTable, cutoff: Date, protect?: { from: Date; to: Date }): Promise<number> {
    const t = Prisma.raw(`"${table}"`);
    const col = Prisma.raw(`"${METRIC_TABLES[table]}"`);
    // `protect` [from, to): rows that are old but must stay (not folded into the next tier yet). Only added to the
    // statement while the range is non-empty, so the steady-state DELETE is the plain indexed `col < cutoff`.
    const keep = protect && protect.from < protect.to && protect.from < cutoff
      ? Prisma.sql` AND NOT (${col} >= ${protect.from} AND ${col} < ${protect.to})`
      : Prisma.empty;
    let total = 0;
    for (;;) {
      const n = await this.prisma.$executeRaw(Prisma.sql`DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM ${t} WHERE ${col} < ${cutoff}${keep} LIMIT ${METRIC_BATCH})`);
      total += n;
      if (n < METRIC_BATCH) break; // short batch — nothing older left
      await new Promise((r) => setTimeout(r, METRIC_PAUSE_MS));
    }
    return total;
  }

  /** Page through matching ids and delete them in batches until a short/empty page ends the run. */
  private async pruneOlderThan(
    page: (take: number) => Promise<{ id: string }[]>,
    del: (ids: string[]) => Promise<unknown>,
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const rows = await page(BATCH);
      if (rows.length === 0) break;
      await del(rows.map((r) => r.id));
      total += rows.length;
      if (rows.length < BATCH) break; // last page — no more to delete
    }
    return total;
  }
}
