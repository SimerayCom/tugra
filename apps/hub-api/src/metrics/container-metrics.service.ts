import { Injectable } from "@nestjs/common";
import type { ContainerMetricsMsg } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";

/** One point of a container's history (hub → web read shape; BigInt fields widened to Number). */
export interface ContainerMetricSample {
  ts: number; // unix ms
  cpu: number; // %
  memUsed: number; // bytes
  memTotal: number; // bytes
  memPct: number; // %
  netRx: number; // B/s
  netTx: number; // B/s
  blkRead: number; // B/s
  blkWrite: number; // B/s
}

export interface AppContainerMetrics {
  containers: { name: string; samples: ContainerMetricSample[] }[];
}

const MAX_POINTS = 500; // per-container chart density cap (rollup/LTTB is a later slice)
const RANGES: Record<string, number> = {
  "1h": 3600_000,
  "6h": 6 * 3600_000,
  "24h": 24 * 3600_000,
};

/** Map a range token to a lookback window in ms. Unknown/missing → 1h (the shortest, cheapest).
 *  Uses an OWN-property check, not `in`: `in` walks the prototype chain, so `?range=constructor`
 *  / `toString` / `__proto__` would otherwise pass the clamp, resolve to a function, and yield a
 *  NaN window → `new Date(NaN)` → a Prisma 500. */
export function rangeToMs(range?: string): { range: string; sinceMs: number } {
  const key = range && Object.prototype.hasOwnProperty.call(RANGES, range) ? range : "1h";
  return { range: key, sinceMs: Date.now() - RANGES[key] };
}

/** Evenly down-sample a series to at most `max` points, always keeping the first and last. */
export function sampleEvenly<T>(rows: T[], max = MAX_POINTS): T[] {
  if (rows.length <= max) return rows;
  const stride = (rows.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * stride)]);
  return out;
}

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

  /**
   * Per-container history for an app since `sinceMs`, grouped by container name. namePrefix is the
   * app's `tugra_<id>` — a row matches if its name IS the prefix (single-container app) OR starts
   * with `<prefix>-` (a compose service container). The `-` separator makes the prefix match airtight
   * against a sibling app whose id merely starts with this one's. Metrics carry no secrets, so this
   * is a read-level query (any team member); BigInt byte fields widen to Number for the JSON wire.
   */
  async forApp(serverId: string, namePrefix: string, sinceMs: number): Promise<AppContainerMetrics> {
    const rows = await this.prisma.containerMetric.findMany({
      where: {
        serverId,
        ts: { gte: new Date(sinceMs) },
        OR: [{ containerName: namePrefix }, { containerName: { startsWith: `${namePrefix}-` } }],
      },
      orderBy: { ts: "asc" },
    });
    const byName = new Map<string, ContainerMetricSample[]>();
    for (const r of rows) {
      let arr = byName.get(r.containerName);
      if (!arr) byName.set(r.containerName, (arr = []));
      arr.push({
        ts: r.ts.getTime(),
        cpu: r.cpu,
        memUsed: Number(r.memUsed),
        memTotal: Number(r.memTotal),
        memPct: r.memPct,
        netRx: Number(r.netRx),
        netTx: Number(r.netTx),
        blkRead: Number(r.blkRead),
        blkWrite: Number(r.blkWrite),
      });
    }
    const containers = [...byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, samples]) => ({ name, samples: sampleEvenly(samples) }));
    return { containers };
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
