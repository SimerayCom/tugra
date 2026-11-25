import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { telemetryFlushMs } from "../common/batch-writer";
import { PrismaService } from "../prisma/prisma.service";
import { metricTiers } from "../metrics/metric-tiers";

const MINUTE_MS = 60_000;
export const FIVE_MIN_MS = 5 * MINUTE_MS;
const BACKFILL_MS = 6 * 3600_000; // first run (no rollups yet): roll the last 6h
// Raw rows are rolled in slices, never the whole window at once: after the hub was down for hours one statement over
// the whole catch-up window would be a long query holding a lot of work (and WAL) in a single transaction. A slice is
// 15 minutes; a run writes at most MAX_FILLED_SLICES non-empty slices (empty gaps are skipped for free) and the next run
// continues from the watermark. The aggregation itself runs INSIDE Postgres (INSERT ... SELECT ... GROUP BY), so the
// hub process holds no sample rows at all, whatever the window or fleet size.
// Samples sit in the ingest buffer for up to telemetryFlushMs() before they reach the DB; the rollup leaves a little
// extra so a flush that is merely slow still lands before its minute is closed (a bucket is final once written).
const FLUSH_MARGIN_MS = 10_000;
export const SLICE_MS = 15 * MINUTE_MS;
export const MAX_FILLED_SLICES = 8;
// The 5-minute tier is rolled from the 1-minute tier, a much smaller input (1 row/min/container), so its slices are wider:
// 6 h per slice, 4 filled slices (24 h of history) per run.
// After the upgrade the tier is empty and every reader of long ranges (costs, forecast, digest, rightsizing, the 7 d chart)
// looks at the RECENT past, so it is back-filled newest-first: the first run folds the last SEED_5M_MS (3 days), and each
// following run walks one step further back (MAX_FILLED_SLICES_5M slices) until the tier reaches its retention floor or
// the oldest 1-minute bucket. Whatever is already folded is therefore always one contiguous span ending at "now".
export const SLICE_5M_MS = 6 * 3600_000;
export const MAX_FILLED_SLICES_5M = 4;
export const SEED_5M_MS = 3 * 86_400_000;
export const SEED_FILLED_SLICES_5M = Math.ceil(SEED_5M_MS / SLICE_5M_MS);

/** The [start, end) slices of a window, oldest first. */
export function slices(start: Date, end: Date, sliceMs = SLICE_MS): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  for (let t = start.getTime(); t < end.getTime(); t += sliceMs) {
    out.push({ start: new Date(t), end: new Date(Math.min(t + sliceMs, end.getTime())) });
  }
  return out;
}

/** The [start, end) slices of a window walked newest-first: the first slice ends at `end`, the last one is clipped at `start`. */
export function slicesNewestFirst(start: Date, end: Date, sliceMs = SLICE_MS): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  for (let t = end.getTime(); t > start.getTime(); t -= sliceMs) {
    out.push({ start: new Date(Math.max(t - sliceMs, start.getTime())), end: new Date(t) });
  }
  return out;
}

function floorTo(ms: number, unit: number): Date {
  return new Date(Math.floor(ms / unit) * unit);
}
const floorMinute = (ms: number): Date => floorTo(ms, MINUTE_MS);
const floor5m = (ms: number): Date => floorTo(ms, FIVE_MIN_MS);

/** Unique row id for the 1-minute tables (their surrogate `id` has no database default). */
const NEW_ID = Prisma.raw(`'r' || replace(gen_random_uuid()::text, '-', '')`);
/** Start of the 5-minute bucket of "bucket" (timezone-independent: pure timestamp arithmetic from the epoch). */
const BUCKET_5M = Prisma.raw(`timestamp 'epoch' + floor(extract(epoch from "bucket") / 300) * 300 * interval '1 second'`);

export interface RollResult {
  metric: number;
  containerMetric: number;
  metric5m: number;
  containerMetric5m: number;
}

/**
 * Rolls raw Metric / ContainerMetric rows into 1-minute average/max buckets, and those into 5-minute buckets, so
 * long-range charts survive past the raw retention window. Only COMPLETE buckets are rolled (the current partial
 * minute / 5 minutes is excluded), and each bucket is final once written, so `ON CONFLICT DO NOTHING` makes a re-run
 * idempotent. The watermark of a tier = its newest existing bucket. Averages: avg of the samples (1-minute tier) or of
 * the 1-minute averages (5-minute tier; sample counts per minute are uniform, so this equals the plain mean to within
 * rounding); max columns take the max; the optional columns average over ONLY the rows that reported them (SQL avg()
 * skips NULL, and is NULL when none did).
 */
@Injectable()
export class MetricsRollupRunnerService {
  private readonly logger = new Logger(MetricsRollupRunnerService.name);

  constructor(private readonly prisma: PrismaService) {}

  async roll(): Promise<RollResult> {
    const metric = await this.rollHost();
    const containerMetric = await this.rollContainer();
    const metric5m = await this.roll5m("host");
    const containerMetric5m = await this.roll5m("container");
    if (metric || containerMetric || metric5m || containerMetric5m) {
      this.logger.log(`rollup: metric=${metric} containerMetric=${containerMetric} metric5m=${metric5m} containerMetric5m=${containerMetric5m} buckets`);
    }
    return { metric, containerMetric, metric5m, containerMetric5m };
  }

  /** Window [start, end): start = next bucket after the newest rollup (clamped to raw retention),
   *  or `now - BACKFILL_MS` on first run; end = the minute floor of `now - flush interval - margin`, so a minute
   *  is only closed once every sample of it has been flushed from the ingest buffer (partial minute excluded). */
  private window(maxBucket: Date | undefined, rawMs: number): { start: Date; end: Date } {
    const end = floorMinute(Date.now() - telemetryFlushMs() - FLUSH_MARGIN_MS);
    const startMs = maxBucket
      ? Math.max(maxBucket.getTime() + MINUTE_MS, Date.now() - rawMs) // never look further back than raw retention keeps
      : Date.now() - Math.min(BACKFILL_MS, rawMs);
    // Minute-aligned so no slice boundary ever splits one bucket's samples.
    return { start: floorMinute(startMs), end };
  }

  /** Roll a window slice by slice (oldest first, or newest first); stops after `maxFilled` slices that produced buckets. */
  private async bySlice(
    start: Date,
    end: Date,
    roll: (s: Date, e: Date) => Promise<number>,
    sliceMs = SLICE_MS,
    maxFilled = MAX_FILLED_SLICES,
    newestFirst = false,
  ): Promise<number> {
    let total = 0;
    let filled = 0;
    for (const sl of newestFirst ? slicesNewestFirst(start, end, sliceMs) : slices(start, end, sliceMs)) {
      const n = await roll(sl.start, sl.end);
      total += n;
      if (n > 0 && ++filled >= maxFilled) break;
    }
    return total;
  }

  private async rollHost(): Promise<number> {
    const latest = await this.prisma.metricRollup.findFirst({ orderBy: { bucket: "desc" }, select: { bucket: true } });
    const { start, end } = this.window(latest?.bucket, metricTiers().hostRawMs);
    if (start >= end) return 0;
    return this.bySlice(start, end, (s, e) => this.rollHostSlice(s, e));
  }

  private rollHostSlice(start: Date, end: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "MetricRollup" ("id", "serverId", "bucket", "avgCpu", "maxCpu", "avgMemUsed", "avgMemTotal", "avgDiskUsed", "avgDiskTotal",
                                  "avgNetRx", "avgNetTx", "avgDiskRead", "avgDiskWrite", "avgLoad1", "avgLoad5", "avgLoad15", "avgSwapUsed", "avgSwapTotal")
      SELECT ${NEW_ID}, "serverId", date_trunc('minute', "ts"), avg("cpu"), max("cpu"),
             round(avg("memUsed"))::bigint, round(avg("memTotal"))::bigint, round(avg("diskUsed"))::bigint, round(avg("diskTotal"))::bigint,
             round(avg("netRx"))::bigint, round(avg("netTx"))::bigint, round(avg("diskRead"))::bigint, round(avg("diskWrite"))::bigint,
             avg("load1"), avg("load5"), avg("load15"), round(avg("swapUsed"))::bigint, round(avg("swapTotal"))::bigint
      FROM "Metric"
      WHERE "ts" >= ${start} AND "ts" < ${end}
      GROUP BY "serverId", date_trunc('minute', "ts")
      ON CONFLICT ("serverId", "bucket") DO NOTHING`);
  }

  private async rollContainer(): Promise<number> {
    const latest = await this.prisma.containerMetricRollup.findFirst({ orderBy: { bucket: "desc" }, select: { bucket: true } });
    const { start, end } = this.window(latest?.bucket, metricTiers().containerRawMs);
    if (start >= end) return 0;
    return this.bySlice(start, end, (s, e) => this.rollContainerSlice(s, e));
  }

  private rollContainerSlice(start: Date, end: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ContainerMetricRollup" ("id", "serverId", "containerName", "bucket", "avgCpu", "maxCpu", "avgMemUsed", "avgMemTotal", "avgMemPct",
                                           "avgNetRx", "avgNetTx", "avgBlkRead", "avgBlkWrite")
      SELECT ${NEW_ID}, "serverId", "containerName", date_trunc('minute', "ts"), avg("cpu"), max("cpu"),
             round(avg("memUsed"))::bigint, round(avg("memTotal"))::bigint, avg("memPct"),
             round(avg("netRx"))::bigint, round(avg("netTx"))::bigint, round(avg("blkRead"))::bigint, round(avg("blkWrite"))::bigint
      FROM "ContainerMetric"
      WHERE "ts" >= ${start} AND "ts" < ${end}
      GROUP BY "serverId", "containerName", date_trunc('minute', "ts")
      ON CONFLICT ("serverId", "containerName", "bucket") DO NOTHING`);
  }

  /**
   * 1-minute rollup -> 5-minute rollup, in two directions around the already-folded span [oldest5, newest5]:
   *  - forward: from the 5-minute watermark (newest bucket + 5 min) up to the last 5-minute boundary the 1-minute
   *    watermark has passed (so a 5-minute bucket is only written once all its minutes are settled), oldest first;
   *  - backward (the upgrade, or a Beszel import into an empty tier): from the oldest folded bucket down to the oldest
   *    1-minute bucket inside the tier's retention, NEWEST first, so recent data is complete after one run and the
   *    deeper history follows. An empty tier starts with a 3-day seed ending at the 1-minute watermark.
   * The 1-minute prune never passes either edge of the span (see RetentionRunnerService).
   */
  private async roll5m(kind: "host" | "container"): Promise<number> {
    // The four models share the (bucket) column; only that one is read here.
    type Edge = { findFirst(args: { orderBy: { bucket: "asc" | "desc" }; select: { bucket: true } }): Promise<{ bucket: Date } | null> };
    const src = (kind === "host" ? this.prisma.metricRollup : this.prisma.containerMetricRollup) as unknown as Edge;
    const dst = (kind === "host" ? this.prisma.metricRollup5m : this.prisma.containerMetricRollup5m) as unknown as Edge;
    const edge = (m: Edge, order: "asc" | "desc") => m.findFirst({ orderBy: { bucket: order }, select: { bucket: true } });
    const [newest1, oldest1, newest5, oldest5] = await Promise.all([edge(src, "desc"), edge(src, "asc"), edge(dst, "desc"), edge(dst, "asc")]);
    if (!newest1 || !oldest1) return 0;
    const end = floor5m(newest1.bucket.getTime() + MINUTE_MS);
    const floorMs = Date.now() - metricTiers().rollup5mMs;
    const first = floor5m(Math.max(oldest1.bucket.getTime(), floorMs)); // the oldest minute worth folding
    const roll = (s: Date, e: Date) => (kind === "host" ? this.roll5mHostSlice(s, e) : this.roll5mContainerSlice(s, e));
    let total = 0;

    if (newest5) {
      const start = new Date(Math.max(newest5.bucket.getTime() + FIVE_MIN_MS, first.getTime()));
      if (start < end) total += await this.bySlice(start, end, roll, SLICE_5M_MS, MAX_FILLED_SLICES_5M);
    }

    // Backward: an empty tier is seeded from the newest end of the 1-minute data.
    const boundary = oldest5 ? oldest5.bucket : end;
    const stop = oldest5 ? first : new Date(Math.max(first.getTime(), end.getTime() - SEED_5M_MS));
    if (stop < boundary) {
      total += await this.bySlice(stop, boundary, roll, SLICE_5M_MS, oldest5 ? MAX_FILLED_SLICES_5M : SEED_FILLED_SLICES_5M, true);
      // An empty tier whose last 3 days hold no 1-minute data at all (sparse history): do not stay stuck on the seed window.
      if (!oldest5 && total === 0 && first < stop) total += await this.bySlice(first, stop, roll, SLICE_5M_MS, MAX_FILLED_SLICES_5M, true);
    }
    return total;
  }

  private roll5mHostSlice(start: Date, end: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "MetricRollup5m" ("serverId", "bucket", "avgCpu", "maxCpu", "avgMemUsed", "avgMemTotal", "avgDiskUsed", "avgDiskTotal",
                                    "avgNetRx", "avgNetTx", "avgDiskRead", "avgDiskWrite", "avgLoad1", "avgLoad5", "avgLoad15", "avgSwapUsed", "avgSwapTotal")
      SELECT "serverId", ${BUCKET_5M} AS "b5", avg("avgCpu"), max("maxCpu"),
             round(avg("avgMemUsed"))::bigint, round(avg("avgMemTotal"))::bigint, round(avg("avgDiskUsed"))::bigint, round(avg("avgDiskTotal"))::bigint,
             round(avg("avgNetRx"))::bigint, round(avg("avgNetTx"))::bigint, round(avg("avgDiskRead"))::bigint, round(avg("avgDiskWrite"))::bigint,
             avg("avgLoad1"), avg("avgLoad5"), avg("avgLoad15"), round(avg("avgSwapUsed"))::bigint, round(avg("avgSwapTotal"))::bigint
      FROM "MetricRollup"
      WHERE "bucket" >= ${start} AND "bucket" < ${end}
      GROUP BY "serverId", "b5"
      ON CONFLICT ("serverId", "bucket") DO NOTHING`);
  }

  private roll5mContainerSlice(start: Date, end: Date): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ContainerMetricRollup5m" ("serverId", "containerName", "bucket", "avgCpu", "maxCpu", "avgMemUsed", "avgMemTotal", "avgMemPct",
                                             "avgNetRx", "avgNetTx", "avgBlkRead", "avgBlkWrite")
      SELECT "serverId", "containerName", ${BUCKET_5M} AS "b5", avg("avgCpu"), max("maxCpu"),
             round(avg("avgMemUsed"))::bigint, round(avg("avgMemTotal"))::bigint, avg("avgMemPct"),
             round(avg("avgNetRx"))::bigint, round(avg("avgNetTx"))::bigint, round(avg("avgBlkRead"))::bigint, round(avg("avgBlkWrite"))::bigint
      FROM "ContainerMetricRollup"
      WHERE "bucket" >= ${start} AND "bucket" < ${end}
      GROUP BY "serverId", "containerName", "b5"
      ON CONFLICT ("serverId", "containerName", "bucket") DO NOTHING`);
  }
}
