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
  }> {
    const rawHours = Number(this.config.get("METRICS_RAW_RETENTION_HOURS") ?? 48);
    const hbDays = Number(this.config.get("HEARTBEAT_RETENTION_DAYS") ?? 30);
    const rollupDays = Number(this.config.get("METRICS_ROLLUP_RETENTION_DAYS") ?? 30);
    const metricsCutoff = new Date(Date.now() - rawHours * 3600_000);
    const hbCutoff = new Date(Date.now() - hbDays * 86_400_000);
    const rollupCutoff = new Date(Date.now() - rollupDays * 86_400_000);

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

    if (metric || containerMetric || heartbeat || metricRollup || containerMetricRollup) {
      this.logger.log(
        `retention prune: metric=${metric} containerMetric=${containerMetric} heartbeat=${heartbeat} metricRollup=${metricRollup} containerMetricRollup=${containerMetricRollup}`,
      );
    }
    return { metric, containerMetric, heartbeat, metricRollup, containerMetricRollup };
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
