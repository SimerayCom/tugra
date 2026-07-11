import { Injectable } from "@nestjs/common";
import type { MetricsSample } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

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
}
