import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";

const BATCH = 5000;

/**
 * Deletes aged-out rows from the unbounded time-series tables (Metric, ContainerMetric, Heartbeat,
 * and the 1-minute rollups). Raw metrics are kept for METRICS_RAW_RETENTION_HOURS; rollups for
 * METRICS_ROLLUP_RETENTION_DAYS; non-important heartbeats for HEARTBEAT_RETENTION_DAYS — `important`
 * (status-change) beats are NEVER pruned. Deletes run in id-paged batches so a large backlog never
 * becomes one long, table-locking DELETE.
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
    deployment: number;
    notificationDelivery: number;
    auditLog: number;
    containerEvent: number;
    trafficMetric: number;
    trafficPath: number;
  }> {
    const rawHours = Number(this.config.get("METRICS_RAW_RETENTION_HOURS") ?? 48);
    const hbDays = Number(this.config.get("HEARTBEAT_RETENTION_DAYS") ?? 30);
    const rollupDays = Number(this.config.get("METRICS_ROLLUP_RETENTION_DAYS") ?? 30);
    const deployDays = Number(this.config.get("DEPLOYMENT_RETENTION_DAYS") ?? 90);
    const notifDays = Number(this.config.get("NOTIFICATION_RETENTION_DAYS") ?? 30);
    const auditDays = Number(this.config.get("AUDIT_RETENTION_DAYS") ?? 0);
    const containerEventDays = Number(this.config.get("CONTAINER_EVENT_RETENTION_DAYS") ?? 14);
    const trafficDays = Number(this.config.get("TRAFFIC_RETENTION_DAYS") ?? 30);
    const trafficCutoff = new Date(Date.now() - trafficDays * 86_400_000);
    const metricsCutoff = new Date(Date.now() - rawHours * 3600_000);
    const hbCutoff = new Date(Date.now() - hbDays * 86_400_000);
    const rollupCutoff = new Date(Date.now() - rollupDays * 86_400_000);
    const deployCutoff = new Date(Date.now() - deployDays * 86_400_000);
    const notifCutoff = new Date(Date.now() - notifDays * 86_400_000);
    const containerEventCutoff = new Date(Date.now() - containerEventDays * 86_400_000);

    const metric = await this.pruneOlderThan(
      (take) => this.prisma.metric.findMany({ where: { ts: { lt: metricsCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.metric.deleteMany({ where: { id: { in: ids } } }),
    );
    const containerMetric = await this.pruneOlderThan(
      (take) => this.prisma.containerMetric.findMany({ where: { ts: { lt: metricsCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.containerMetric.deleteMany({ where: { id: { in: ids } } }),
    );
    // Preserve `important` beats (monitor up/down transitions) regardless of age.
    const heartbeat = await this.pruneOlderThan(
      (take) => this.prisma.heartbeat.findMany({ where: { ts: { lt: hbCutoff }, important: false }, select: { id: true }, take }),
      (ids) => this.prisma.heartbeat.deleteMany({ where: { id: { in: ids } } }),
    );
    const metricRollup = await this.pruneOlderThan(
      (take) => this.prisma.metricRollup.findMany({ where: { bucket: { lt: rollupCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.metricRollup.deleteMany({ where: { id: { in: ids } } }),
    );
    const containerMetricRollup = await this.pruneOlderThan(
      (take) => this.prisma.containerMetricRollup.findMany({ where: { bucket: { lt: rollupCutoff } }, select: { id: true }, take }),
      (ids) => this.prisma.containerMetricRollup.deleteMany({ where: { id: { in: ids } } }),
    );
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
    // Audit log is compliance-sensitive → pruned ONLY when AUDIT_RETENTION_DAYS is explicitly set (> 0).
    const auditLog = auditDays > 0
      ? await this.pruneOlderThan(
          (take) => this.prisma.auditLog.findMany({ where: { createdAt: { lt: new Date(Date.now() - auditDays * 86_400_000) } }, select: { id: true }, take }),
          (ids) => this.prisma.auditLog.deleteMany({ where: { id: { in: ids } } }),
        )
      : 0;

    if (metric || containerMetric || heartbeat || metricRollup || containerMetricRollup || deployment || notificationDelivery || auditLog || containerEvent || trafficMetric || trafficPath) {
      this.logger.log(
        `retention prune: metric=${metric} containerMetric=${containerMetric} heartbeat=${heartbeat} metricRollup=${metricRollup} containerMetricRollup=${containerMetricRollup} deployment=${deployment} notificationDelivery=${notificationDelivery} auditLog=${auditLog} containerEvent=${containerEvent} trafficMetric=${trafficMetric} trafficPath=${trafficPath}`,
      );
    }
    return { metric, containerMetric, heartbeat, metricRollup, containerMetricRollup, deployment, notificationDelivery, auditLog, containerEvent, trafficMetric, trafficPath };
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
