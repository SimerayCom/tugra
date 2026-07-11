import { Injectable } from "@nestjs/common";
import type { ContainerMetricsMsg } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ContainerMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  // Agent-initiated telemetry push: one batch = every container on a server at msg.ts. No redis
  // fan-out (unlike host metrics) — container stats are a 15s poll, the charts slice reads from the
  // DB rather than a live stream. containerName is the stable key; containerId tags the incarnation.
  async ingest(serverId: string, msg: ContainerMetricsMsg): Promise<void> {
    if (!msg.samples?.length) return;
    const ts = new Date(msg.ts);
    await this.prisma.containerMetric.createMany({
      data: msg.samples.map((s) => ({
        serverId,
        containerName: s.name,
        containerId: s.id,
        ts,
        cpu: num(s.cpu),
        memUsed: big(s.memUsed),
        memTotal: big(s.memTotal),
        memPct: num(s.memPct),
        netRx: big(s.netRx),
        netTx: big(s.netTx),
        blkRead: big(s.blkRead),
        blkWrite: big(s.blkWrite),
      })),
    });
  }
}

// A misbehaving/compromised agent can send a non-finite number (JSON.parse turns an out-of-range
// literal like 1e400 into Infinity). BigInt(Math.round(Infinity)) throws RangeError, which would
// abort the whole batch and close the socket — a reconnect loop that persists nothing. Clamp
// non-finite values to 0 so one bad sample can't take down the pipeline.
function num(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

function big(n: number): bigint {
  return Number.isFinite(n) ? BigInt(Math.round(n)) : 0n;
}
