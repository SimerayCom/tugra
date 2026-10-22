import { Injectable } from "@nestjs/common";
import type { MetricsSample, GpuStat } from "@tugra/shared";
import { Prisma } from "@prisma/client";
import { downsampleLTTB } from "../common/lttb";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { rangeToMs } from "./container-metrics.service";

const MAX_POINTS = 1000; // LTTB density cap for the host range charts

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

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async ingest(serverId: string, sample: MetricsSample): Promise<void> {
    const sens = sanitizeSensors(sample);
    await this.prisma.metric.create({
      data: {
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
        // Optional sensors — all nullable; an older agent / sensorless host leaves them NULL.
        temp: sens.temp,
        gpuUtil: sens.gpuUtil,
        gpuMemUsed: sens.gpuMemUsed,
        gpuMemTotal: sens.gpuMemTotal,
        gpuTemp: sens.gpuTemp,
        batteryPct: sens.batteryPct,
        batteryState: sens.batteryState,
        detail: sens.detail ?? Prisma.DbNull,
      },
    });
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
  private toSample(r: {
    ts: Date; cpu: number; memUsed: bigint; memTotal: bigint; diskUsed: bigint; diskTotal: bigint;
    netRx: bigint; netTx: bigint; diskRead: bigint; diskWrite: bigint;
    temp?: number | null; gpuUtil?: number | null; gpuMemUsed?: bigint | null; gpuMemTotal?: bigint | null;
    gpuTemp?: number | null; batteryPct?: number | null; batteryState?: string | null; detail?: unknown;
  }): MetricsSample {
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
    // Optional sensors — NULL columns stay absent (undefined), so the UI renders "—" not 0.
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
   * A single DISTINCT ON (serverId) over the [serverId, ts] index, not N round-trips. Servers with
   * no sample yet are simply absent (the UI shows them as "—"). The caller MUST pass only ids the
   * requester may see (ServersService.listForUser); this method performs no authorization itself.
   */
  async latestForServers(serverIds: string[]): Promise<{ serverId: string; sample: MetricsSample }[]> {
    if (serverIds.length === 0) return [];
    const rows = await this.prisma.metric.findMany({
      where: { serverId: { in: serverIds } },
      orderBy: [{ serverId: "asc" }, { ts: "desc" }],
      distinct: ["serverId"],
    });
    return rows.map((r) => ({ serverId: r.serverId, sample: this.toSample(r) }));
  }

  /**
   * Host metrics over a `range` (asc by time). Ranges within raw retention (≤24h) read raw rows at
   * full fidelity; longer ranges (7d) read the 1-minute rollups so history survives past raw
   * retention (48h). The result is LTTB down-sampled to keep the visual shape under MAX_POINTS.
   * `recent()` stays the live/last-N reader; this is the range-aware reader for the monitoring tab.
   */
  async history(serverId: string, range?: string): Promise<MetricsSample[]> {
    const { sinceMs, useRollup } = rangeToMs(range);
    let samples: MetricsSample[];
    if (useRollup) {
      const rows = await this.prisma.metricRollup.findMany({
        where: { serverId, bucket: { gte: new Date(sinceMs) } },
        orderBy: { bucket: "asc" },
      });
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
      }));
    } else {
      const rows = await this.prisma.metric.findMany({
        where: { serverId, ts: { gte: new Date(sinceMs) } },
        orderBy: { ts: "asc" },
      });
      samples = rows.map((r) => this.toSample(r)); // carries the optional sensor fields too (≤24h raw)
    }
    return downsampleLTTB(samples, MAX_POINTS, (s) => s.cpu);
  }
}
