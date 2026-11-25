import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { MetricsSample, GpuStat } from "@tugra/shared";
import { Prisma } from "@prisma/client";
import { downsampleLTTB } from "../common/lttb";
import { strided } from "../common/series-sampling";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { rangeToMs } from "./container-metrics.service";
import { BatchWriter, telemetryFlushMs, type BatchWriterStats } from "../common/batch-writer";

const MAX_POINTS = 1000; // LTTB density cap for the host range charts

const METRIC_COLS = [
  "ts", "cpu", "memUsed", "memTotal", "diskUsed", "diskTotal", "netRx", "netTx", "diskRead", "diskWrite",
  "load1", "load5", "load15", "swapUsed", "swapTotal", "temp", "gpuUtil", "gpuMemUsed", "gpuMemTotal", "gpuTemp", "batteryPct", "batteryState", "detail",
] as const;
const ROLLUP_COLS = [
  "bucket", "avgCpu", "maxCpu", "avgMemUsed", "avgMemTotal", "avgDiskUsed", "avgDiskTotal", "avgNetRx", "avgNetTx", "avgDiskRead", "avgDiskWrite",
  "avgLoad1", "avgLoad5", "avgLoad15", "avgSwapUsed", "avgSwapTotal",
] as const;

/** One host history point: the wire MetricsSample plus, on rollup-backed (7d/30d) reads, the bucket's
 *  PEAK cpu % (`cpu` is then the bucket average) so the long-range chart can draw a peak band. */
export type HostMetricPoint = MetricsSample & { cpuMax?: number };

/** Recent-trend bounds for the batch sparkline read (one query, bounded rows = servers × minutes). */
export const TREND_MIN_MINUTES = 5;
export const TREND_MAX_MINUTES = 120;
export const TREND_DEFAULT_MINUTES = 30;
const TREND_MAX_SERVERS = 500;

/** One server's recent per-minute CPU / memory % trend (sparkline source for the server + fleet tables). */
export interface ServerTrend {
  serverId: string;
  points: { ts: number; cpu: number; mem: number | null }[];
}

const BATTERY_STATES = new Set(["Charging", "Discharging", "Full", "Not charging", "Unknown", "Idle", "Empty"]);

function finiteIn(n: unknown, lo: number, hi: number): number | null {
  const v = typeof n === "number" ? n : NaN;
  if (!Number.isFinite(v)) return null;
  return v < lo ? lo : v > hi ? hi : v;
}
function bigOrNull(n: number | null): bigint | null {
  return n == null ? null : BigInt(Math.round(n));
}

/**
 * Clean the OPTIONAL load-average + swap fields of an untrusted sample. An older agent (or a host that
 * can't report them) omits them → NULL columns / absent wire fields, never a fake 0. Never throws.
 */
export function sanitizeLoadSwap(sample: MetricsSample): {
  load1: number | null; load5: number | null; load15: number | null;
  swapUsed: bigint | null; swapTotal: bigint | null;
  wire: Partial<MetricsSample>;
} {
  const load1 = finiteIn(sample.load1, 0, 1e6);
  const load5 = finiteIn(sample.load5, 0, 1e6);
  const load15 = finiteIn(sample.load15, 0, 1e6);
  const swapUsed = finiteIn(sample.swapUsed, 0, Number.MAX_SAFE_INTEGER);
  const swapTotal = finiteIn(sample.swapTotal, 0, Number.MAX_SAFE_INTEGER);
  const wire: Partial<MetricsSample> = {};
  if (load1 != null) wire.load1 = load1;
  if (load5 != null) wire.load5 = load5;
  if (load15 != null) wire.load15 = load15;
  if (swapUsed != null) wire.swapUsed = swapUsed;
  if (swapTotal != null) wire.swapTotal = swapTotal;
  return { load1, load5, load15, swapUsed: bigOrNull(swapUsed), swapTotal: bigOrNull(swapTotal), wire };
}

/**
 * Clean + bound the OPTIONAL sensor fields of an untrusted agent sample. The agent JSON is not schema-
 * validated upstream and the live sample is relayed verbatim to browsers, so every string is sliced and
 * every number clamped here. Returns the scalar DB columns (gpu* are aggregates over all GPUs), a capped
 * `detail` blob (per-sensor map + per-GPU list) and the sanitized wire fields safe to publish. Never throws.
 */
export function sanitizeSensors(sample: MetricsSample): {
  temp: number | null;
  gpuUtil: number | null;
  gpuMemUsed: bigint | null;
  gpuMemTotal: bigint | null;
  gpuTemp: number | null;
  batteryPct: number | null;
  batteryState: string | null;
  detail: Prisma.InputJsonValue | null;
  wire: Partial<MetricsSample>;
} {
  const temp = finiteIn(sample.temp, -50, 250);

  let sensors: Record<string, number> | undefined;
  if (sample.sensors && typeof sample.sensors === "object") {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(sample.sensors)) {
      if (Object.keys(out).length >= 16) break;
      const fv = finiteIn(v, -50, 250);
      if (fv != null) out[String(k).slice(0, 32)] = fv;
    }
    if (Object.keys(out).length) sensors = out;
  }

  let gpus: GpuStat[] | undefined;
  if (Array.isArray(sample.gpus)) {
    const out = sample.gpus.slice(0, 8).map((g): GpuStat => ({
      name: String(g?.name ?? "GPU").slice(0, 64),
      util: finiteIn(g?.util, 0, 100) ?? 0,
      memUsed: finiteIn(g?.memUsed, 0, Number.MAX_SAFE_INTEGER) ?? 0,
      memTotal: finiteIn(g?.memTotal, 0, Number.MAX_SAFE_INTEGER) ?? 0,
      temp: finiteIn(g?.temp, -50, 250) ?? undefined,
      power: finiteIn(g?.power, 0, 100000) ?? undefined,
    }));
    if (out.length) gpus = out;
  }
  const gpuUtil = gpus ? Math.max(...gpus.map((g) => g.util)) : null;
  const gpuMemUsed = gpus ? gpus.reduce((s, g) => s + g.memUsed, 0) : null;
  const gpuMemTotal = gpus ? gpus.reduce((s, g) => s + g.memTotal, 0) : null;
  const gpuTemps = gpus ? gpus.map((g) => g.temp).filter((t): t is number => typeof t === "number") : [];
  const gpuTemp = gpuTemps.length ? Math.max(...gpuTemps) : null;

  let battery: { percent: number; state: string } | undefined;
  const batteryPct = sample.battery ? finiteIn(sample.battery.percent, 0, 100) : null;
  let batteryState: string | null = null;
  if (batteryPct != null) {
    const st = String(sample.battery?.state ?? "Unknown").slice(0, 16);
    batteryState = BATTERY_STATES.has(st) ? st : "Unknown";
    battery = { percent: batteryPct, state: batteryState };
  }

  const detailObj: Record<string, unknown> = {};
  if (sensors) detailObj.sensors = sensors;
  if (gpus) detailObj.gpus = gpus;
  const detail = Object.keys(detailObj).length ? (detailObj as Prisma.InputJsonValue) : null;

  const wire: Partial<MetricsSample> = {};
  if (temp != null) wire.temp = temp;
  if (sensors) wire.sensors = sensors;
  if (gpus) wire.gpus = gpus;
  if (battery) wire.battery = battery;

  return { temp, gpuUtil, gpuMemUsed: bigOrNull(gpuMemUsed), gpuMemTotal: bigOrNull(gpuMemTotal), gpuTemp, batteryPct, batteryState, detail, wire };
}

/** The columns of a persisted host `Metric` row that the wire sample is built from. */
interface MetricRow {
  ts: Date; cpu: number; memUsed: bigint; memTotal: bigint; diskUsed: bigint; diskTotal: bigint;
  netRx: bigint; netTx: bigint; diskRead: bigint; diskWrite: bigint;
  load1?: number | null; load5?: number | null; load15?: number | null; swapUsed?: bigint | null; swapTotal?: bigint | null;
  temp?: number | null; gpuUtil?: number | null; gpuMemUsed?: bigint | null; gpuMemTotal?: bigint | null;
  gpuTemp?: number | null; batteryPct?: number | null; batteryState?: string | null; detail?: unknown;
}

/** The columns of a persisted `MetricRollup` row the long-range chart reads. */
interface RollupRow {
  bucket: Date; avgCpu: number; maxCpu: number; avgMemUsed: bigint; avgMemTotal: bigint; avgDiskUsed: bigint; avgDiskTotal: bigint;
  avgNetRx: bigint; avgNetTx: bigint; avgDiskRead: bigint; avgDiskWrite: bigint;
  avgLoad1: number | null; avgLoad5: number | null; avgLoad15: number | null; avgSwapUsed: bigint | null; avgSwapTotal: bigint | null;
}

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  /**
   * Host samples are buffered and written as ONE multi-row INSERT every TELEMETRY_FLUSH_MS (5 s) instead of one
   * INSERT per message (27-50 servers x 12 samples/min). Max loss window on a hub crash: the last flush interval
   * of samples. The live Redis fan-out below is NOT buffered, and DB reads of the newest sample lag by at most
   * one flush interval.
   */
  private readonly writer = new BatchWriter<Prisma.MetricCreateManyInput>({
    name: "metric",
    write: async (rows) => {
      await this.prisma.metric.createMany({ data: rows });
    },
    flushMs: telemetryFlushMs(),
    flushRows: 500,
    maxBuffered: 5000, // ~10 min of a 50-server fleet at 5 s; oldest dropped beyond it
    chunk: 500,
  });
  private closed = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    this.writer.start();
    // Nest destroys the Prisma module before this one: flush through its pre-disconnect hook instead.
    this.prisma.registerBeforeDisconnect?.(() => this.shutdown());
  }

  async onModuleDestroy(): Promise<void> {
    await this.shutdown();
  }

  /** Write everything buffered now (shutdown / tests). Never throws. */
  flush(): Promise<void> {
    return this.writer.flush();
  }

  ingestStats(): BatchWriterStats {
    return this.writer.stats();
  }

  private async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writer.stop();
  }

  async ingest(serverId: string, sample: MetricsSample): Promise<void> {
    const sens = sanitizeSensors(sample);
    const ls = sanitizeLoadSwap(sample);
    const row: Prisma.MetricCreateManyInput = {
      serverId,
      ts: new Date(sample.ts),
      cpu: sample.cpu,
      memUsed: BigInt(Math.round(sample.memUsed)),
      memTotal: BigInt(Math.round(sample.memTotal)),
      diskUsed: BigInt(Math.round(sample.diskUsed)),
      diskTotal: BigInt(Math.round(sample.diskTotal)),
      netRx: BigInt(Math.round(sample.netRx)),
      netTx: BigInt(Math.round(sample.netTx)),
      // Finite-guard: an OLDER agent doesn't send these → sample.diskRead is undefined →
      // BigInt(Math.round(undefined)) = BigInt(NaN) would THROW and drop the whole metrics message
      // (disconnecting the agent every tick). Coerce undefined/NaN/Infinity → 0.
      diskRead: BigInt(Math.round(Number.isFinite(sample.diskRead) ? sample.diskRead : 0)),
      diskWrite: BigInt(Math.round(Number.isFinite(sample.diskWrite) ? sample.diskWrite : 0)),
      // Load average + swap — nullable; an older agent leaves them NULL.
      load1: ls.load1,
      load5: ls.load5,
      load15: ls.load15,
      swapUsed: ls.swapUsed,
      swapTotal: ls.swapTotal,
      // Optional sensors — all nullable; an older agent / sensorless host leaves them NULL.
      temp: sens.temp,
      gpuUtil: sens.gpuUtil,
      gpuMemUsed: sens.gpuMemUsed,
      gpuMemTotal: sens.gpuMemTotal,
      gpuTemp: sens.gpuTemp,
      batteryPct: sens.batteryPct,
      batteryState: sens.batteryState,
      // createMany takes a plain null for a nullable Json column (DbNull is the single-row create API).
      ...(sens.detail != null ? { detail: sens.detail } : {}),
    };
    if (this.closed) {
      // Shutting down: the buffer is already flushed and its timer stopped, so write this straggler directly.
      await this.prisma.metric.createMany({ data: [row] }).catch(() => undefined);
    } else {
      this.writer.push(row);
    }
    // Live fan-out for the UI (best-effort). Publish the SANITIZED sample — the raw agent JSON carries
    // untrusted strings (GPU name, battery state, sensor keys) and is relayed verbatim to browsers.
    const clean: MetricsSample = {
      ts: sample.ts,
      cpu: sample.cpu,
      memUsed: sample.memUsed,
      memTotal: sample.memTotal,
      diskUsed: sample.diskUsed,
      diskTotal: sample.diskTotal,
      netRx: sample.netRx,
      netTx: sample.netTx,
      diskRead: Number.isFinite(sample.diskRead) ? sample.diskRead : 0,
      diskWrite: Number.isFinite(sample.diskWrite) ? sample.diskWrite : 0,
      ...ls.wire,
      ...sens.wire,
    };
    await this.redis.client.publish(`metrics:${serverId}`, JSON.stringify(clean)).catch(() => undefined);
  }

  async recent(serverId: string, limit = 60): Promise<MetricsSample[]> {
    const rows = await this.prisma.metric.findMany({
      where: { serverId },
      orderBy: { ts: "desc" },
      take: Math.min(Math.max(limit, 1), 1000),
    });
    return rows.reverse().map((r) => this.toSample(r));
  }

  /** Map a persisted Metric row to the wire MetricsSample (BigInt bytes → Number). */
  private toSample(r: MetricRow): MetricsSample {
    const s: MetricsSample = {
      ts: r.ts.getTime(),
      cpu: r.cpu,
      memUsed: Number(r.memUsed),
      memTotal: Number(r.memTotal),
      diskUsed: Number(r.diskUsed),
      diskTotal: Number(r.diskTotal),
      netRx: Number(r.netRx),
      netTx: Number(r.netTx),
      diskRead: Number(r.diskRead),
      diskWrite: Number(r.diskWrite),
    };
    // Optional load/swap + sensors — NULL columns stay absent (undefined), so the UI renders "—" not 0.
    if (r.load1 != null) s.load1 = r.load1;
    if (r.load5 != null) s.load5 = r.load5;
    if (r.load15 != null) s.load15 = r.load15;
    if (r.swapUsed != null) s.swapUsed = Number(r.swapUsed);
    if (r.swapTotal != null) s.swapTotal = Number(r.swapTotal);
    if (r.temp != null) s.temp = r.temp;
    if (r.batteryPct != null) s.battery = { percent: r.batteryPct, state: r.batteryState ?? "Unknown" };
    const d = (r.detail ?? null) as { sensors?: Record<string, number>; gpus?: GpuStat[] } | null;
    if (d?.sensors) s.sensors = d.sensors;
    if (d?.gpus?.length) s.gpus = d.gpus;
    else if (r.gpuUtil != null) {
      s.gpus = [{ name: "GPU", util: r.gpuUtil, memUsed: Number(r.gpuMemUsed ?? 0), memTotal: Number(r.gpuMemTotal ?? 0), temp: r.gpuTemp ?? undefined }];
    }
    return s;
  }

  /**
   * Newest sample for each of `serverIds` — the one call behind the fleet overview's live table.
   * One lateral index probe per server over [serverId, ts], in a single round-trip. Servers with
   * no sample yet are simply absent (the UI shows them as "—"). The caller MUST pass only ids the
   * requester may see (ServersService.listForUser); this method performs no authorization itself.
   */
  async latestForServers(serverIds: string[]): Promise<{ serverId: string; sample: MetricsSample }[]> {
    if (serverIds.length === 0) return [];
    // One index probe per server ([serverId, ts] backwards, LIMIT 1) instead of `findMany({ distinct })`: Prisma
    // de-duplicates `distinct` IN MEMORY, so that form pulled EVERY raw row of every server (48 h at 5 s ≈ 35 k
    // rows × servers, ~1 M rows on a 27-server fleet — gigabytes of query-engine memory per call, and the fleet,
    // dashboard and server-list pages poll it every 5-10 s). This reads exactly one row per server.
    const rows = await this.prisma.$queryRaw<(MetricRow & { serverId: string })[]>(Prisma.sql`
      SELECT s.id AS "serverId", m."ts", m."cpu", m."memUsed", m."memTotal", m."diskUsed", m."diskTotal", m."netRx", m."netTx",
             m."diskRead", m."diskWrite", m."load1", m."load5", m."load15", m."swapUsed", m."swapTotal", m."temp", m."gpuUtil",
             m."gpuMemUsed", m."gpuMemTotal", m."gpuTemp", m."batteryPct", m."batteryState", m."detail"
      FROM unnest(${serverIds}::text[]) AS s(id)
      CROSS JOIN LATERAL (
        SELECT * FROM "Metric" WHERE "serverId" = s.id ORDER BY "ts" DESC LIMIT 1
      ) m`);
    return rows.map((r) => ({ serverId: r.serverId, sample: this.toSample(r) }));
  }

  /**
   * Host metrics over a `range` (asc by time). Ranges within raw retention (≤24h; host raw is kept 26 h) read raw
   * rows at full fidelity; longer ranges (7d/30d) read the 5-minute rollups so history survives past raw
   * retention (the 1-minute tier serves a range only when raw retention is configured shorter than it). The result is LTTB down-sampled to keep the visual shape under MAX_POINTS.
   * `recent()` stays the live/last-N reader; this is the range-aware reader for the monitoring tab.
   */
  async history(serverId: string, range?: string): Promise<HostMetricPoint[]> {
    const { sinceMs, tier } = rangeToMs(range, "host");
    let samples: HostMetricPoint[];
    if (tier !== "raw") {
      // Strided in SQL (see series-sampling): a 7d series is 2 016 5-minute rows, a 1-minute 48 h one 2 880; the chart draws 1000 points.
      const table = tier === "5m" ? Prisma.raw(`"MetricRollup5m"`) : Prisma.raw(`"MetricRollup"`);
      const rows = await this.prisma.$queryRaw<RollupRow[]>(
        strided(Prisma.sql`SELECT * FROM ${table} WHERE "serverId" = ${serverId} AND "bucket" >= ${new Date(sinceMs)}`, ROLLUP_COLS, "bucket"),
      );
      samples = rows.map((r) => ({
        ts: r.bucket.getTime(),
        cpu: r.avgCpu,
        memUsed: Number(r.avgMemUsed),
        memTotal: Number(r.avgMemTotal),
        diskUsed: Number(r.avgDiskUsed),
        diskTotal: Number(r.avgDiskTotal),
        netRx: Number(r.avgNetRx),
        netTx: Number(r.avgNetTx),
        diskRead: Number(r.avgDiskRead),
        diskWrite: Number(r.avgDiskWrite),
        ...(r.avgLoad1 != null && { load1: r.avgLoad1 }),
        ...(r.avgLoad5 != null && { load5: r.avgLoad5 }),
        ...(r.avgLoad15 != null && { load15: r.avgLoad15 }),
        ...(r.avgSwapUsed != null && { swapUsed: Number(r.avgSwapUsed) }),
        ...(r.avgSwapTotal != null && { swapTotal: Number(r.avgSwapTotal) }),
        ...(Number.isFinite(r.maxCpu) && { cpuMax: r.maxCpu }),
      }));
    } else {
      // A 24 h raw series is 17 280 rows × ~25 columns: strided in SQL, every returned row is a real stored sample.
      const rows = await this.prisma.$queryRaw<MetricRow[]>(
        strided(Prisma.sql`SELECT * FROM "Metric" WHERE "serverId" = ${serverId} AND "ts" >= ${new Date(sinceMs)}`, METRIC_COLS, "ts"),
      );
      samples = rows.map((r) => this.toSample(r)); // carries the optional sensor fields too (≤24h raw)
    }
    return downsampleLTTB(samples, MAX_POINTS, (s) => s.cpu);
  }

  /**
   * Recent per-minute CPU + memory % for each of `serverIds` over the last `minutes` — ONE aggregate
   * query (date_trunc minute, grouped per server), so the sparkline columns never cost N round-trips.
   * Bounded: `minutes` is clamped to [5,120] and the id set to 500, so rows <= servers x minutes. Servers
   * with no samples in the window are absent. The caller MUST pass only ids the requester may see
   * (ServersService.listForUser); this method performs no authorization itself.
   */
  async trendForServers(serverIds: string[], minutes?: number): Promise<ServerTrend[]> {
    const ids = serverIds.slice(0, TREND_MAX_SERVERS);
    if (ids.length === 0) return [];
    const n = Math.trunc(Number(minutes));
    const mins = Number.isFinite(n) ? Math.min(TREND_MAX_MINUTES, Math.max(TREND_MIN_MINUTES, n)) : TREND_DEFAULT_MINUTES;
    const since = new Date(Date.now() - mins * 60_000);
    const rows = await this.prisma.$queryRaw<{ serverId: string; bucket: Date; cpu: number; mem: number | null }[]>(Prisma.sql`
      SELECT "serverId",
             date_trunc('minute', "ts") AS bucket,
             AVG("cpu")::float8 AS cpu,
             AVG(CASE WHEN "memTotal" > 0 THEN "memUsed"::float8 / "memTotal"::float8 * 100 END)::float8 AS mem
      FROM "Metric"
      WHERE "serverId" IN (${Prisma.join(ids)}) AND "ts" >= ${since}
      GROUP BY "serverId", date_trunc('minute', "ts")
      ORDER BY "serverId", bucket ASC`);
    const byServer = new Map<string, ServerTrend>();
    for (const r of rows) {
      let t = byServer.get(r.serverId);
      if (!t) byServer.set(r.serverId, (t = { serverId: r.serverId, points: [] }));
      t.points.push({
        ts: new Date(r.bucket).getTime(),
        cpu: Number.isFinite(Number(r.cpu)) ? Number(r.cpu) : 0,
        mem: r.mem != null && Number.isFinite(Number(r.mem)) ? Number(r.mem) : null,
      });
    }
    return [...byServer.values()];
  }
}
