import { Injectable } from "@nestjs/common";
import type { MetricsSample } from "@tugra/shared";
import { downsampleLTTB } from "../common/lttb";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { rangeToMs } from "./container-metrics.service";

const MAX_POINTS = 1000; // LTTB density cap for the host range charts

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async ingest(serverId: string, sample: MetricsSample): Promise<void> {
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
      },
    });
    // Live fan-out for the UI (best-effort).
    await this.redis
      .client.publish(`metrics:${serverId}`, JSON.stringify(sample))
      .catch(() => undefined);
  }

  async recent(serverId: string, limit = 60): Promise<MetricsSample[]> {
    const rows = await this.prisma.metric.findMany({
      where: { serverId },
      orderBy: { ts: "desc" },
      take: Math.min(Math.max(limit, 1), 1000),
    });
    return rows.reverse().map((r) => ({
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
    }));
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
      samples = rows.map((r) => ({
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
      }));
    }
    return downsampleLTTB(samples, MAX_POINTS, (s) => s.cpu);
  }
}
