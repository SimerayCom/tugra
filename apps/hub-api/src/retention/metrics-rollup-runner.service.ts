import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const MINUTE_MS = 60_000;
const BACKFILL_MS = 6 * 3600_000; // first run (no rollups yet): roll the last 6h
const MAX_CATCHUP_MS = 48 * 3600_000; // never look further back than raw retention keeps

function floorMinute(ms: number): Date {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS);
}

function big(n: number): bigint {
  return Number.isFinite(n) ? BigInt(Math.round(n)) : 0n;
}

/**
 * Rolls raw Metric / ContainerMetric rows into 1-minute average/max buckets so long-range charts
 * survive past the raw retention window. Only COMPLETE minutes are rolled (the current partial minute
 * is excluded), and each bucket is final once written — so `createMany({ skipDuplicates })` makes a
 * re-run idempotent (no upsert needed). The watermark = the newest existing rollup bucket.
 */
@Injectable()
export class MetricsRollupRunnerService {
  private readonly logger = new Logger(MetricsRollupRunnerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async roll(): Promise<{ metric: number; containerMetric: number }> {
    const metric = await this.rollHost();
    const containerMetric = await this.rollContainer();
    if (metric || containerMetric) {
      this.logger.log(`rollup: metric=${metric} containerMetric=${containerMetric} buckets`);
    }
    return { metric, containerMetric };
  }

  /** Window [start, end): start = next bucket after the newest rollup (clamped to raw retention),
   *  or `now - BACKFILL_MS` on first run; end = the current minute floor (partial minute excluded). */
  private async window(maxBucket: Date | undefined): Promise<{ start: Date; end: Date }> {
    const end = floorMinute(Date.now());
    const startMs = maxBucket
      ? Math.max(maxBucket.getTime() + MINUTE_MS, Date.now() - MAX_CATCHUP_MS)
      : Date.now() - BACKFILL_MS;
    return { start: new Date(startMs), end };
  }

  private async rollHost(): Promise<number> {
    const latest = await this.prisma.metricRollup.findFirst({ orderBy: { bucket: "desc" }, select: { bucket: true } });
    const { start, end } = await this.window(latest?.bucket);
    if (start >= end) return 0;

    const rows = await this.prisma.metric.findMany({ where: { ts: { gte: start, lt: end } }, orderBy: { ts: "asc" } });
    const acc = new Map<string, {
      serverId: string; bucket: Date; n: number; cpu: number; maxCpu: number;
      memUsed: number; memTotal: number; diskUsed: number; diskTotal: number;
      netRx: number; netTx: number; diskRead: number; diskWrite: number;
    }>();
    for (const r of rows) {
      const bucket = floorMinute(r.ts.getTime());
      const key = `${r.serverId}|${bucket.getTime()}`;
      let a = acc.get(key);
      if (!a) acc.set(key, (a = { serverId: r.serverId, bucket, n: 0, cpu: 0, maxCpu: 0, memUsed: 0, memTotal: 0, diskUsed: 0, diskTotal: 0, netRx: 0, netTx: 0, diskRead: 0, diskWrite: 0 }));
      a.n++;
      a.cpu += r.cpu;
      a.maxCpu = Math.max(a.maxCpu, r.cpu);
      a.memUsed += Number(r.memUsed);
      a.memTotal += Number(r.memTotal);
      a.diskUsed += Number(r.diskUsed);
      a.diskTotal += Number(r.diskTotal);
      a.netRx += Number(r.netRx);
      a.netTx += Number(r.netTx);
      a.diskRead += Number(r.diskRead);
      a.diskWrite += Number(r.diskWrite);
    }
    const data = [...acc.values()].map((a) => ({
      serverId: a.serverId,
      bucket: a.bucket,
      avgCpu: a.cpu / a.n,
      maxCpu: a.maxCpu,
      avgMemUsed: big(a.memUsed / a.n),
      avgMemTotal: big(a.memTotal / a.n),
      avgDiskUsed: big(a.diskUsed / a.n),
      avgDiskTotal: big(a.diskTotal / a.n),
      avgNetRx: big(a.netRx / a.n),
      avgNetTx: big(a.netTx / a.n),
      avgDiskRead: big(a.diskRead / a.n),
      avgDiskWrite: big(a.diskWrite / a.n),
    }));
    if (data.length === 0) return 0;
    await this.prisma.metricRollup.createMany({ data, skipDuplicates: true });
    return data.length;
  }

  private async rollContainer(): Promise<number> {
    const latest = await this.prisma.containerMetricRollup.findFirst({ orderBy: { bucket: "desc" }, select: { bucket: true } });
    const { start, end } = await this.window(latest?.bucket);
    if (start >= end) return 0;

    const rows = await this.prisma.containerMetric.findMany({ where: { ts: { gte: start, lt: end } }, orderBy: { ts: "asc" } });
    const acc = new Map<string, {
      serverId: string; containerName: string; bucket: Date; n: number; cpu: number; maxCpu: number;
      memUsed: number; memTotal: number; memPct: number; netRx: number; netTx: number; blkRead: number; blkWrite: number;
    }>();
    for (const r of rows) {
      const bucket = floorMinute(r.ts.getTime());
      const key = `${r.serverId}|${r.containerName}|${bucket.getTime()}`;
      let a = acc.get(key);
      if (!a) acc.set(key, (a = { serverId: r.serverId, containerName: r.containerName, bucket, n: 0, cpu: 0, maxCpu: 0, memUsed: 0, memTotal: 0, memPct: 0, netRx: 0, netTx: 0, blkRead: 0, blkWrite: 0 }));
      a.n++;
      a.cpu += r.cpu;
      a.maxCpu = Math.max(a.maxCpu, r.cpu);
      a.memUsed += Number(r.memUsed);
      a.memTotal += Number(r.memTotal);
      a.memPct += r.memPct;
      a.netRx += Number(r.netRx);
      a.netTx += Number(r.netTx);
      a.blkRead += Number(r.blkRead);
      a.blkWrite += Number(r.blkWrite);
    }
    const data = [...acc.values()].map((a) => ({
      serverId: a.serverId,
      containerName: a.containerName,
      bucket: a.bucket,
      avgCpu: a.cpu / a.n,
      maxCpu: a.maxCpu,
      avgMemUsed: big(a.memUsed / a.n),
      avgMemTotal: big(a.memTotal / a.n),
      avgMemPct: a.memPct / a.n,
      avgNetRx: big(a.netRx / a.n),
      avgNetTx: big(a.netTx / a.n),
      avgBlkRead: big(a.blkRead / a.n),
      avgBlkWrite: big(a.blkWrite / a.n),
    }));
    if (data.length === 0) return 0;
    await this.prisma.containerMetricRollup.createMany({ data, skipDuplicates: true });
    return data.length;
  }
}
