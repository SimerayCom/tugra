import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { ContainerMetricsMsg } from "@tugra/shared";
import { downsampleLTTB } from "../common/lttb";
import { strided } from "../common/series-sampling";
import { PrismaService } from "../prisma/prisma.service";
import { tierFor, type MetricKind, type MetricTier } from "./metric-tiers";
import { nameFromLabels, sameLabels, sanitizeContainerMeta, type ContainerLabelRow } from "./container-labels";

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
  /** Per-minute PEAK cpu % — only on rollup-backed (long-range) reads, where `cpu` is the bucket average. */
  cpuMax?: number;
}

export interface AppContainerMetrics {
  containers: { name: string; samples: ContainerMetricSample[] }[];
}

/** Latest sample for one container in the server-level inventory (adds name + docker short id).
 *  `label` is the friendly name shown in the UI ("WordPress · db", "my-pg", "hub-api") so the raw
 *  `tugra_<cuid>` project names never have to be read; `kind` says what it is and `resourceId` links
 *  back to the app/database when known. */
export interface ContainerInventoryRow extends ContainerMetricSample {
  name: string;
  containerId: string;
  label: string;
  kind: "app" | "db" | "system" | "other";
  resourceId?: string;
  service?: string;
  /** Project / environment the container belongs to when its labels say so (Coolify). */
  project?: string;
  environment?: string;
  // Last-known crash/health state from the container-health poll (ContainerState), joined in so the UI
  // can badge a crash-looping or unhealthy container. Absent when the poll hasn't recorded this one yet.
  restartCount?: number;
  exitCode?: number;
  oomKilled?: boolean;
  health?: string | null;
  finishedAt?: string | null;
}

/** Resolve a friendly label/kind for a raw container name, given this server's apps + databases.
 *  Patterns: `tugra_db_<id>` (database), `tugra_<appId>[-<service>-<n>]` (managed app / compose
 *  service), `tugra-<name>-<n>` (Tugra's own stack), anything else (other). */
export function resolveContainerLabel(
  name: string,
  apps: Map<string, string>,
  dbs: Map<string, string>,
  labels?: ContainerLabelRow,
): { label: string; kind: ContainerInventoryRow["kind"]; resourceId?: string; service?: string; project?: string; environment?: string } {
  let m = /^tugra_db_([a-z0-9]+)$/i.exec(name);
  if (m) {
    // Link only a database that exists in the queried set (an orphan / out-of-scope container has no page).
    const known = dbs.has(m[1]);
    return { label: dbs.get(m[1]) ?? name.replace(/^tugra_db_/, ""), kind: "db", ...(known && { resourceId: m[1] }) };
  }
  m = /^tugra_([a-z0-9]+)(?:-(.+)-(\d+))?$/i.exec(name);
  if (m && apps.has(m[1])) {
    const appName = apps.get(m[1])!;
    const service = m[2] || undefined;
    return { label: service ? `${appName} · ${service}` : appName, kind: "app", resourceId: m[1], service };
  }
  // Tugra's own stack containers are named with a dash project ("tugra-hub-api-1"); strip the noise.
  if (/^tugra[-_]/i.test(name)) {
    return { label: name.replace(/^tugra[-_]/i, "").replace(/-\d+$/, "") || name, kind: "system" };
  }
  // A foreign container (Coolify-managed, compose): name it from its labels when they are readable.
  const named = labels ? nameFromLabels(labels) : null;
  if (named) return { ...named, kind: "other" };
  return { label: name, kind: "other" };
}

export interface ServerContainers {
  containers: ContainerInventoryRow[];
}

/** One row of the cross-fleet "hottest containers" ranking (BigInt byte fields widened to Number). */
export interface HottestContainerRow {
  serverId: string;
  serverName: string;
  containerName: string;
  label: string;
  kind: ContainerInventoryRow["kind"];
  resourceId?: string;
  service?: string;
  project?: string;
  environment?: string;
  cpu: number; // %
  memUsed: number; // bytes
  memTotal: number; // bytes
  memPct: number; // %
  netRx: number; // B/s
  netTx: number; // B/s
  blkRead: number; // B/s
  blkWrite: number; // B/s
}

export const HOTTEST_DEFAULT_LIMIT = 10;
export const HOTTEST_MAX_LIMIT = 50;

/** Clamp a caller-supplied `limit` to 1..HOTTEST_MAX_LIMIT; missing / non-numeric → the default. */
export function clampHottestLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return HOTTEST_DEFAULT_LIMIT;
  return Math.min(HOTTEST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

// A container counts as "live" if it reported within this window (the agent samples every 15s, so
// 6 intervals covers a missed tick while dropping containers that have been removed).
const LIVE_WINDOW_MS = 90_000;

const MAX_POINTS = 1000; // per-container chart density cap (LTTB keeps the shape while down-sampling)
// Which table serves a chart depends on the range and the retention tiers (metric-tiers.ts): within a kind's raw
// retention (host 26 h, container 6 h by default) the RAW rows are served at full fidelity, up to the 1-minute rollup
// retention (48 h) the 1-minute rollups, beyond that (7d / 30d) the 5-minute rollups, which cover the whole 28 days.
const RANGES: Record<string, number> = {
  "1h": 3600_000,
  "6h": 6 * 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/** Map a range token to a lookback window in ms + the tier that serves it (`useRollup` = anything but raw). Unknown /
 *  missing → 1h (the shortest, cheapest). Uses an OWN-property check, not `in`: `in` walks the prototype chain, so
 *  `?range=constructor` / `toString` / `__proto__` would otherwise pass the clamp, resolve to a function, and yield a
 *  NaN window → `new Date(NaN)` → a Prisma 500. `kind` picks the raw retention: host samples are kept longer (26 h)
 *  than container samples (6 h). */
export function rangeToMs(range?: string, kind: MetricKind = "host"): { range: string; sinceMs: number; useRollup: boolean; tier: MetricTier } {
  const key = range && Object.prototype.hasOwnProperty.call(RANGES, range) ? range : "1h";
  const tier = tierFor(kind, RANGES[key]);
  return { range: key, sinceMs: Date.now() - RANGES[key], useRollup: tier !== "raw", tier };
}

/** Evenly down-sample a series to at most `max` points, always keeping the first and last. */
export function sampleEvenly<T>(rows: T[], max = MAX_POINTS): T[] {
  if (rows.length <= max) return rows;
  const stride = (rows.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.round(i * stride)]);
  return out;
}

/** Re-write an unchanged label row at most this often (keeps `updatedAt` honest so stale rows can be pruned). */
const LABEL_REFRESH_MS = 12 * 3600_000;
/** Label rows not refreshed for this long belong to containers that no longer exist. */
const LABEL_STALE_MS = 7 * 86_400_000;
const LABEL_PRUNE_EVERY_MS = 3600_000;

/** The columns of a raw `ContainerMetric` row the read paths below need (never `id` / `serverId` they already know). */
interface LiveRow {
  serverId: string;
  containerName: string;
  containerId: string;
  ts: Date;
  cpu: number;
  memUsed: bigint;
  memTotal: bigint;
  memPct: number;
  netRx: bigint;
  netTx: bigint;
  blkRead: bigint;
  blkWrite: bigint;
}

/** The columns of a `ContainerMetricRollup` row the long-range chart reads. */
interface ContainerRollupRow {
  containerName: string; bucket: Date; avgCpu: number; maxCpu: number; avgMemUsed: bigint; avgMemTotal: bigint; avgMemPct: number;
  avgNetRx: bigint; avgNetTx: bigint; avgBlkRead: bigint; avgBlkWrite: bigint;
}

@Injectable()
export class ContainerMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  // What this hub process last wrote per `${serverId}\0${containerName}`, so an unchanged label set costs no DB write.
  private readonly labelCache = new Map<string, { row: ContainerLabelRow; at: number }>();
  private lastLabelPrune = 0;

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
    // Labels are decoration: a failure here must never fail (and close the socket of) the metrics batch.
    await this.recordLabels(serverId, msg).catch(() => undefined);
  }

  /** Persist the labels an agent reported, writing only what changed (or went stale), and prune dead rows. */
  private async recordLabels(serverId: string, msg: ContainerMetricsMsg): Promise<void> {
    const now = Date.now();
    for (const s of msg.samples) {
      const row = sanitizeContainerMeta(s.meta);
      if (!row || typeof s.name !== "string" || !s.name) continue;
      const key = `${serverId}\u0000${s.name}`;
      const prev = this.labelCache.get(key);
      if (prev && sameLabels(prev.row, row) && now - prev.at < LABEL_REFRESH_MS) continue;
      await this.prisma.containerLabel.upsert({
        where: { serverId_containerName: { serverId, containerName: s.name } },
        create: { serverId, containerName: s.name, ...row, updatedAt: new Date(now) },
        update: { ...row, updatedAt: new Date(now) },
      });
      if (this.labelCache.size > 5000) this.labelCache.clear(); // bound it; a cleared cache only costs re-checks
      this.labelCache.set(key, { row, at: now });
    }
    if (now - this.lastLabelPrune > LABEL_PRUNE_EVERY_MS) {
      this.lastLabelPrune = now;
      await this.prisma.containerLabel.deleteMany({ where: { updatedAt: { lt: new Date(now - LABEL_STALE_MS) } } });
    }
  }

  private async labelsFor(serverIds: string[], containerNames?: string[]): Promise<Map<string, ContainerLabelRow>> {
    const rows = await this.prisma.containerLabel.findMany({
      where: { serverId: { in: serverIds }, ...(containerNames ? { containerName: { in: containerNames } } : {}) },
    });
    return new Map(rows.map((r) => [`${r.serverId}\u0000${r.containerName}`, { name: r.name, resource: r.resource, project: r.project, environment: r.environment, service: r.service }]));
  }

  /**
   * Per-container history for an app over `range`, grouped by container name. namePrefix is the
   * app's `tugra_<id>` — a row matches if its name IS the prefix (single-container app) OR starts
   * with `<prefix>-` (a compose service container). The `-` separator makes the prefix match airtight
   * against a sibling app whose id merely starts with this one's. Ranges within the container raw
   * retention (≤6h by default) read raw rows; 24h reads the 1-minute rollups, 7d/30d the 5-minute rollups. All paths are
   * LTTB down-sampled to keep the visual shape. Metrics carry no secrets, so this is a read-level
   * query (any team member); BigInt byte fields widen to Number for the JSON wire.
   */
  async forApp(serverId: string | string[], namePrefix: string, range?: string, swarm = false): Promise<AppContainerMetrics> {
    const { sinceMs, tier } = rangeToMs(range, "container");
    // Swarm apps run as `docker service tugra_<id>`; their task containers are named
    // `tugra_<id>.<slot>.<taskid>` and scattered across the cluster's member nodes, so we match the `.`
    // task-suffix too and query ALL member serverIds. The delimiter (`.`/`-`) keeps the prefix airtight
    // against a sibling app whose id merely starts with this one's (a bare startsWith would over-match).
    const serverIds = Array.isArray(serverId) ? serverId : [serverId];
    // starts_with, not LIKE: an app id may contain `_`, which LIKE treats as a wildcard.
    const nameMatch = Prisma.sql`("containerName" = ${namePrefix} OR starts_with("containerName", ${`${namePrefix}-`})${swarm ? Prisma.sql` OR starts_with("containerName", ${`${namePrefix}.`})` : Prisma.empty})`;
    const byName = new Map<string, ContainerMetricSample[]>();
    const push = (name: string, s: ContainerMetricSample) => {
      let arr = byName.get(name);
      if (!arr) byName.set(name, (arr = []));
      arr.push(s);
    };

    // Each container is its own series, strided in SQL to ≤ ~3000 stored rows before LTTB (see series-sampling): a 24 h raw
    // series is 5 760 rows and a 7-day rollup series 10 080, per container, per request.
    if (tier !== "raw") {
      const table = tier === "5m" ? Prisma.raw(`"ContainerMetricRollup5m"`) : Prisma.raw(`"ContainerMetricRollup"`);
      const rows = await this.prisma.$queryRaw<ContainerRollupRow[]>(
        strided(
          Prisma.sql`SELECT * FROM ${table} WHERE "serverId" = ANY(${serverIds}::text[]) AND "bucket" >= ${new Date(sinceMs)} AND ${nameMatch}`,
          ["containerName", "bucket", "avgCpu", "maxCpu", "avgMemUsed", "avgMemTotal", "avgMemPct", "avgNetRx", "avgNetTx", "avgBlkRead", "avgBlkWrite"],
          "bucket",
          "containerName",
        ),
      );
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
          ...(Number.isFinite(r.maxCpu) && { cpuMax: r.maxCpu }),
        });
      }
    } else {
      const rows = await this.prisma.$queryRaw<LiveRow[]>(
        strided(
          Prisma.sql`SELECT * FROM "ContainerMetric" WHERE "serverId" = ANY(${serverIds}::text[]) AND "ts" >= ${new Date(sinceMs)} AND ${nameMatch}`,
          ["containerName", "ts", "cpu", "memUsed", "memTotal", "memPct", "netRx", "netTx", "blkRead", "blkWrite"],
          "ts",
          "containerName",
        ),
      );
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
    const [rows, apps, dbs, states, labels] = await Promise.all([
      this.latestPerContainer([serverId]),
      this.prisma.application.findMany({ where: { serverId }, select: { id: true, name: true } }),
      this.prisma.database.findMany({ where: { serverId }, select: { id: true, name: true } }),
      // Last-known crash/health state so a crash-looping or unhealthy container can be badged. DB-only.
      this.prisma.containerState.findMany({
        where: { serverId },
        select: { containerName: true, exitCode: true, oomKilled: true, restartCount: true, health: true, finishedAt: true },
      }),
      this.labelsFor([serverId]),
    ]);
    const appsById = new Map(apps.map((a) => [a.id, a.name]));
    const dbsById = new Map(dbs.map((d) => [d.id, d.name]));
    const stateByName = new Map(states.map((s) => [s.containerName, s]));
    // One (already newest) row per container name — see latestPerContainer.
    const latest = new Map<string, ContainerInventoryRow>();
    for (const r of rows) {
      const friendly = resolveContainerLabel(r.containerName, appsById, dbsById, labels.get(`${serverId}\u0000${r.containerName}`));
      const st = stateByName.get(r.containerName);
      latest.set(r.containerName, {
        name: r.containerName,
        containerId: r.containerId,
        ...friendly,
        ts: r.ts.getTime(),
        cpu: r.cpu,
        memUsed: Number(r.memUsed),
        memTotal: Number(r.memTotal),
        memPct: r.memPct,
        netRx: Number(r.netRx),
        netTx: Number(r.netTx),
        blkRead: Number(r.blkRead),
        blkWrite: Number(r.blkWrite),
        ...(st && {
          restartCount: st.restartCount,
          exitCode: st.exitCode,
          oomKilled: st.oomKilled,
          health: st.health,
          finishedAt: st.finishedAt ? st.finishedAt.toISOString() : null,
        }),
      });
    }
    const containers = [...latest.values()].sort((a, b) => a.label.localeCompare(b.label));
    return { containers };
  }

  /**
   * Cross-fleet "hottest containers": the live containers across `servers`, ranked by CPU desc, top
   * `limit`. The caller MUST pass only servers the requester may see (ServersService.listForUser) —
   * this method performs no authorization itself and never reads outside that set. ONE query over the
   * live window (no per-server round trips); each (server, container) keeps only its newest sample, so
   * stale/removed containers (no report within LIVE_WINDOW_MS) are excluded.
   */
  async hottest(servers: { id: string; name: string }[], limit?: number): Promise<HottestContainerRow[]> {
    if (servers.length === 0) return [];
    const serverIds = servers.map((s) => s.id);
    // Ranked in SQL: only the top `limit` rows ever reach JS (was: every live sample of every container, sorted here).
    const rows = await this.latestPerContainer(serverIds, clampHottestLimit(limit));
    if (rows.length === 0) return [];
    const topServerIds = [...new Set(rows.map((r) => r.serverId))];
    const [apps, dbs, labels] = await Promise.all([
      this.prisma.application.findMany({ where: { serverId: { in: topServerIds } }, select: { id: true, name: true } }),
      this.prisma.database.findMany({ where: { serverId: { in: topServerIds } }, select: { id: true, name: true } }),
      this.labelsFor(topServerIds, [...new Set(rows.map((r) => r.containerName))]),
    ]);
    const nameById = new Map(servers.map((s) => [s.id, s.name]));
    const appsById = new Map(apps.map((a) => [a.id, a.name]));
    const dbsById = new Map(dbs.map((d) => [d.id, d.name]));
    return rows.map((r) => ({
      serverId: r.serverId,
      serverName: nameById.get(r.serverId) ?? r.serverId,
      containerName: r.containerName,
      ...resolveContainerLabel(r.containerName, appsById, dbsById, labels.get(`${r.serverId}\u0000${r.containerName}`)),
      cpu: r.cpu,
      memUsed: Number(r.memUsed),
      memTotal: Number(r.memTotal),
      memPct: r.memPct,
      netRx: Number(r.netRx),
      netTx: Number(r.netTx),
      blkRead: Number(r.blkRead),
      blkWrite: Number(r.blkWrite),
    }));
  }

  /**
   * The newest sample of every container that reported within LIVE_WINDOW_MS on `serverIds`, computed in the
   * database (DISTINCT ON) — one row per (server, container), not every sample of the window. With `limit`, the rows are
   * additionally ranked CPU desc (name asc on a tie) and cut to `limit` in SQL, so a fleet-wide ranking never
   * materialises the whole fleet's live set in the hub.
   */
  private async latestPerContainer(serverIds: string[], limit?: number): Promise<LiveRow[]> {
    if (serverIds.length === 0) return [];
    const since = new Date(Date.now() - LIVE_WINDOW_MS);
    return this.prisma.$queryRaw<LiveRow[]>(Prisma.sql`
      SELECT * FROM (
        SELECT DISTINCT ON ("serverId", "containerName")
               "serverId", "containerName", "containerId", "ts", "cpu", "memUsed", "memTotal", "memPct", "netRx", "netTx", "blkRead", "blkWrite"
        FROM "ContainerMetric"
        WHERE "serverId" = ANY(${serverIds}::text[]) AND "ts" >= ${since}
        ORDER BY "serverId", "containerName", "ts" DESC
      ) latest
      ORDER BY "cpu" DESC, "containerName" ASC
      ${limit ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}`);
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
