import { Injectable } from "@nestjs/common";
import type { ContainerMetricsMsg } from "@tugra/shared";
import { downsampleLTTB } from "../common/lttb";
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

/** Latest sample for one container in the server-level inventory (adds name + docker short id). */
export interface ContainerInventoryRow extends ContainerMetricSample {
  name: string;
  containerId: string;
}

export interface ServerContainers {
  containers: ContainerInventoryRow[];
}

// A container counts as "live" if it reported within this window (the agent samples every 15s, so
// 6 intervals covers a missed tick while dropping containers that have been removed).
const LIVE_WINDOW_MS = 90_000;

const MAX_POINTS = 1000; // per-container chart density cap (LTTB keeps the shape while down-sampling)
// Ranges within this window are served from RAW rows at full fidelity (raw is retained 48h, so
// 1h/6h/24h all fit comfortably and keep sub-minute spikes). Only longer ranges (7d) read the
// 1-minute rollups, because they reach past the raw retention window where no raw rows survive.
const RAW_THRESHOLD_MS = 24 * 3600_000;
const RANGES: Record<string, number> = {
  "1h": 3600_000,
  "6h": 6 * 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 86_400_000,
};

/** Map a range token to a lookback window in ms + whether it reads rollups (>2h) rather than raw
 *  rows. Unknown/missing → 1h (the shortest, cheapest). Uses an OWN-property check, not `in`: `in`
 *  walks the prototype chain, so `?range=constructor` / `toString` / `__proto__` would otherwise pass
 *  the clamp, resolve to a function, and yield a NaN window → `new Date(NaN)` → a Prisma 500. */
export function rangeToMs(range?: string): { range: string; sinceMs: number; useRollup: boolean } {
  const key = range && Object.prototype.hasOwnProperty.call(RANGES, range) ? range : "1h";
  return { range: key, sinceMs: Date.now() - RANGES[key], useRollup: RANGES[key] > RAW_THRESHOLD_MS };
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
  // fan-out (unlike host metrics) — container stats are a 15s poll, the charts read from the
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
   * Per-container history for an app over `range`, grouped by container name. namePrefix is the
   * app's `tugra_<id>` — a row matches if its name IS the prefix (single-container app) OR starts
   * with `<prefix>-` (a compose service container). The `-` separator makes the prefix match airtight
   * against a sibling app whose id merely starts with this one's. Ranges within raw retention (≤24h)
   * read raw rows; longer ranges (7d) read the 1-minute rollups so history survives past it. Both paths are
   * LTTB down-sampled to keep the visual shape. Metrics carry no secrets, so this is a read-level
   * query (any team member); BigInt byte fields widen to Number for the JSON wire.
   */
  async forApp(serverId: string | string[], namePrefix: string, range?: string, swarm = false): Promise<AppContainerMetrics> {
    const { sinceMs, useRollup } = rangeToMs(range);
    // Swarm apps run as `docker service tugra_<id>`; their task containers are named
    // `tugra_<id>.<slot>.<taskid>` and scattered across the cluster's member nodes, so we match the `.`
    // task-suffix too and query ALL member serverIds. The delimiter (`.`/`-`) keeps the prefix airtight
    // against a sibling app whose id merely starts with this one's (a bare startsWith would over-match).
    const serverWhere = Array.isArray(serverId) ? { in: serverId } : serverId;
    const nameMatch = [
      { containerName: namePrefix },
      { containerName: { startsWith: `${namePrefix}-` } },
      ...(swarm ? [{ containerName: { startsWith: `${namePrefix}.` } }] : []),
    ];
    const byName = new Map<string, ContainerMetricSample[]>();
    const push = (name: string, s: ContainerMetricSample) => {
      let arr = byName.get(name);
      if (!arr) byName.set(name, (arr = []));
      arr.push(s);
    };

    if (useRollup) {
      const rows = await this.prisma.containerMetricRollup.findMany({
        where: { serverId: serverWhere, bucket: { gte: new Date(sinceMs) }, OR: nameMatch },
        orderBy: { bucket: "asc" },
      });
      for (const r of rows) {
        push(r.containerName, {
          ts: r.bucket.getTime(),
          cpu: r.avgCpu,
          memUsed: Number(r.avgMemUsed),
          memTotal: Number(r.avgMemTotal),
          memPct: r.avgMemPct,
          netRx: Number(r.avgNetRx),
          netTx: Number(r.avgNetTx),
          blkRead: Number(r.avgBlkRead),
          blkWrite: Number(r.avgBlkWrite),
        });
      }
    } else {
      const rows = await this.prisma.containerMetric.findMany({
        where: { serverId: serverWhere, ts: { gte: new Date(sinceMs) }, OR: nameMatch },
        orderBy: { ts: "asc" },
      });
      for (const r of rows) {
        push(r.containerName, {
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
    }

    const containers = [...byName.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, samples]) => ({ name, samples: downsampleLTTB(samples, MAX_POINTS, (s) => s.cpu) }));
    return { containers };
  }

  /**
   * Server-level inventory: the LATEST sample per container currently running on the host (any
   * container the agent's `docker stats` sees — Tugra apps AND anything else). Read-level (no
   * secrets). Only containers that reported within LIVE_WINDOW_MS appear, so removed containers drop
   * off. Rows are ordered by name; BigInt byte fields widen to Number.
   */
  async forServer(serverId: string): Promise<ServerContainers> {
    const rows = await this.prisma.containerMetric.findMany({
      where: { serverId, ts: { gte: new Date(Date.now() - LIVE_WINDOW_MS) } },
      orderBy: { ts: "asc" },
    });
    // ts asc → the last row seen per name is its most recent sample.
    const latest = new Map<string, ContainerInventoryRow>();
    for (const r of rows) {
      latest.set(r.containerName, {
        name: r.containerName,
        containerId: r.containerId,
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
    const containers = [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
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
