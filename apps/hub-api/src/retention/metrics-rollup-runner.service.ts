import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const MINUTE_MS = 60_000;
const BACKFILL_MS = 6 * 3600_000; // first run (no rollups yet): roll the last 6h
const MAX_CATCHUP_MS = 48 * 3600_000; // never look further back than raw retention keeps
// Raw rows are read and rolled in slices, never the whole window at once: after the hub was down for hours, one
// read of the catch-up window (up to 48 h of every container's samples) is millions of rows and can OOM-kill the
// hub on a small host - which makes the next window bigger still. A slice is 15 minutes; a run writes at most
// MAX_FILLED_SLICES non-empty slices (empty gaps are skipped for free) and the next run continues from the watermark.
export const SLICE_MS = 15 * MINUTE_MS;
export const MAX_FILLED_SLICES = 8;

/** The [start, end) slices of a window, oldest first. */
export function slices(start: Date, end: Date, sliceMs = SLICE_MS): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  for (let t = start.getTime(); t < end.getTime(); t += sliceMs) {
    out.push({ start: new Date(t), end: new Date(Math.min(t + sliceMs, end.getTime())) });
  }
  return out;
}

function floorMinute(ms: number): Date {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS);
}

function big(n: number): bigint {
  return Number.isFinite(n) ? BigInt(Math.round(n)) : 0n;
}

/** Running sum + count of an optional (nullable) column. */
type Opt = { sum: number; n: number };
function addOpt(o: Opt, v: number | bigint | null | undefined): void {
  if (v == null) return;
  const x = Number(v);
  if (!Number.isFinite(x)) return;
  o.sum += x;
  o.n++;
}
const avgOpt = (o: Opt): number | null => (o.n > 0 ? o.sum / o.n : null);
const avgOptBig = (o: Opt): bigint | null => (o.n > 0 ? big(o.sum / o.n) : null);

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
    // Minute-aligned so no slice boundary ever splits one bucket's samples.
    return { start: floorMinute(startMs), end };
  }

  /** Roll a window slice by slice; stops after MAX_FILLED_SLICES slices that produced buckets. */
  private async bySlice(start: Date, end: Date, roll: (s: Date, e: Date) => Promise<number>): Promise<number> {
    let total = 0;
    let filled = 0;
    for (const sl of slices(start, end)) {
      const n = await roll(sl.start, sl.end);
      total += n;
      if (n > 0 && ++filled >= MAX_FILLED_SLICES) break;
    }
    return total;
  }

  private async rollHost(): Promise<number> {
    const latest = await this.prisma.metricRollup.findFirst({ orderBy: { bucket: "desc" }, select: { bucket: true } });
    const { start, end } = await this.window(latest?.bucket);
    if (start >= end) return 0;
    return this.bySlice(start, end, (s, e) => this.rollHostSlice(s, e));
  }

  private async rollHostSlice(start: Date, end: Date): Promise<number> {
    const rows = await this.prisma.metric.findMany({ where: { ts: { gte: start, lt: end } }, orderBy: { ts: "asc" } });
    const acc = new Map<string, {
      serverId: string; bucket: Date; n: number; cpu: number; maxCpu: number;
      memUsed: number; memTotal: number; diskUsed: number; diskTotal: number;
      netRx: number; netTx: number; diskRead: number; diskWrite: number;
      // Optional load/swap: summed + counted over ONLY the samples that reported them (NULL otherwise).
      load1: Opt; load5: Opt; load15: Opt; swapUsed: Opt; swapTotal: Opt;
    }>();
    for (const r of rows) {
      const bucket = floorMinute(r.ts.getTime());
      const key = `${r.serverId}|${bucket.getTime()}`;
      let a = acc.get(key);
      if (!a) acc.set(key, (a = { serverId: r.serverId, bucket, n: 0, cpu: 0, maxCpu: 0, memUsed: 0, memTotal: 0, diskUsed: 0, diskTotal: 0, netRx: 0, netTx: 0, diskRead: 0, diskWrite: 0, load1: { sum: 0, n: 0 }, load5: { sum: 0, n: 0 }, load15: { sum: 0, n: 0 }, swapUsed: { sum: 0, n: 0 }, swapTotal: { sum: 0, n: 0 } }));
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
      addOpt(a.load1, r.load1);
      addOpt(a.load5, r.load5);
      addOpt(a.load15, r.load15);
      addOpt(a.swapUsed, r.swapUsed);
      addOpt(a.swapTotal, r.swapTotal);
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
      avgLoad1: avgOpt(a.load1),
      avgLoad5: avgOpt(a.load5),
      avgLoad15: avgOpt(a.load15),
      avgSwapUsed: avgOptBig(a.swapUsed),
      avgSwapTotal: avgOptBig(a.swapTotal),
    }));
    if (data.length === 0) return 0;
    await this.prisma.metricRollup.createMany({ data, skipDuplicates: true });
    return data.length;
  }

  private async rollContainer(): Promise<number> {
    const latest = await this.prisma.containerMetricRollup.findFirst({ orderBy: { bucket: "desc" }, select: { bucket: true } });
    const { start, end } = await this.window(latest?.bucket);
    if (start >= end) return 0;
    return this.bySlice(start, end, (s, e) => this.rollContainerSlice(s, e));
  }

  private async rollContainerSlice(start: Date, end: Date): Promise<number> {
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
