import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { ReadCoalescer } from "../common/read-coalescer";
import { HubHealthSampler, processSources, type HealthSample } from "./sampler";
import { evaluateWarnings } from "./warnings";
import type { HubHealth } from "./dto";

const MB = 1024 * 1024;
const BOOTS_KEY = "hub:health:boots";
const BOOTS_KEEP = 50;
const DAY_MS = 86_400_000;
/** Postgres / Redis / queue figures change slowly and cost a few queries: refreshed at most this often, however many owners look. */
const DEEP_TTL_MS = 30_000;
const TOP_TABLES = 5;
const MAX_QUEUES = 60;

type Deep = Pick<HubHealth, "postgres" | "redis" | "queues">;

const mb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;
const ms1 = (n: number) => Math.round(n * 10) / 10;

/** Parse `key:value` lines of a Redis INFO section. */
export function parseInfo(info: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of info.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0 && !line.startsWith("#")) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

/** Restarts inside the last 24 h from the recorded boot times (newest first). When every recorded boot is inside the
 *  window, the oldest one is the install itself, not a restart. */
export function restartsLast24h(boots: number[], now: number): number {
  const inWindow = boots.filter((b) => now - b < DAY_MS).length;
  return Math.max(0, boots.length <= inWindow ? inWindow - 1 : inWindow);
}

/**
 * The hub's own vital signs for the owner: process memory, V8 heap vs its cap, event-loop delay, GC time, uptime,
 * restarts, Postgres connections + biggest tables, Redis memory, BullMQ queue depths.
 *
 * Cost: one in-memory sample every 20 s (no database or Redis write), and the Postgres / Redis / queue reads are
 * cached for 30 s however often the panel polls. The only write is ONE Redis list push at boot (the restart history).
 */
@Injectable()
export class HubHealthService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HubHealthService.name);
  private readonly sources = processSources();
  readonly sampler = new HubHealthSampler(this.sources);
  private readonly startedAt = Date.now();
  private readonly deepCache = new ReadCoalescer();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.sampler.start();
    if (process.env.NODE_ENV === "test") return;
    try {
      await this.redis.client.lpush(BOOTS_KEY, String(this.startedAt));
      await this.redis.client.ltrim(BOOTS_KEY, 0, BOOTS_KEEP - 1);
    } catch (e) {
      this.logger.warn(`could not record the boot: ${e instanceof Error ? e.message : e}`);
    }
  }

  onModuleDestroy(): void {
    this.sampler.stop();
    this.sources.stop();
  }

  async snapshot(): Promise<HubHealth> {
    const now = Date.now();
    const s: HealthSample = this.sampler.latest() ?? this.sampler.sample();
    const [deep, boots] = await Promise.all([this.deep(), this.boots()]);
    const heapPct = s.heapLimitBytes > 0 ? Math.round((s.heapUsedBytes / s.heapLimitBytes) * 1000) / 10 : 0;
    const base = {
      process: { rssMb: mb(s.rssBytes), heapUsedMb: mb(s.heapUsedBytes), heapLimitMb: mb(s.heapLimitBytes), heapPct, externalMb: mb(s.externalBytes), gcMs: ms1(s.gcMs) },
      eventLoop: { p50Ms: ms1(s.loopP50Ms), p99Ms: ms1(s.loopP99Ms), maxMs: ms1(s.loopMaxMs) },
      restarts: { last24h: restartsLast24h(boots, now), lastBootAt: boots.length ? new Date(boots[0]).toISOString() : null },
      ...deep,
    };
    const warnings = evaluateWarnings(base);
    return {
      sampledAt: new Date(s.t).toISOString(),
      healthy: warnings.length === 0,
      warnings,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      ...base,
      history: this.sampler.history().map((h) => ({ t: h.t, rssMb: mb(h.rssBytes), heapUsedMb: mb(h.heapUsedBytes), loopP99Ms: ms1(h.loopP99Ms) })),
    };
  }

  private async boots(): Promise<number[]> {
    try {
      return (await this.redis.client.lrange(BOOTS_KEY, 0, BOOTS_KEEP - 1)).map(Number).filter(Number.isFinite);
    } catch {
      return [];
    }
  }

  private deep(): Promise<Deep> {
    return this.deepCache.run("deep", async () => {
      const [postgres, redis, queues] = await Promise.all([this.postgres(), this.redisStats(), this.queues()]);
      return { postgres, redis, queues };
    }, DEEP_TTL_MS);
  }

  private async postgres(): Promise<Deep["postgres"]> {
    try {
      const [conn] = await this.prisma.$queryRaw<{ used: bigint; max: number; size: bigint }[]>`
        SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS used,
               (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max,
               pg_database_size(current_database()) AS size`;
      const tables = await this.prisma.$queryRaw<{ name: string; bytes: bigint }[]>`
        SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = 'public'
        ORDER BY pg_total_relation_size(c.oid) DESC LIMIT ${TOP_TABLES}`;
      return {
        connectionsUsed: Number(conn.used),
        connectionsMax: Number(conn.max),
        dbSizeBytes: Number(conn.size),
        tables: tables.map((t) => ({ name: t.name, bytes: Number(t.bytes) })),
      };
    } catch (e) {
      this.logger.warn(`postgres health read failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  private async redisStats(): Promise<Deep["redis"]> {
    try {
      const [mem, clients] = await Promise.all([this.redis.client.info("memory"), this.redis.client.info("clients")]);
      const m = parseInfo(mem);
      const c = parseInfo(clients);
      return { usedMemoryBytes: Number(m.used_memory ?? 0), maxMemoryBytes: Number(m.maxmemory ?? 0), connectedClients: Number(c.connected_clients ?? 0) };
    } catch (e) {
      this.logger.warn(`redis health read failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** BullMQ keeps each queue under `bull:<name>:*`: depths from the list / sorted-set sizes, last duration from the newest completed job. */
  private async queues(): Promise<Deep["queues"]> {
    try {
      const client = this.redis.client;
      const names = new Set<string>();
      let cursor = "0";
      do {
        const [next, keys] = await client.scan(cursor, "MATCH", "bull:*:meta", "COUNT", 200);
        cursor = next;
        for (const k of keys) names.add(k.slice("bull:".length, -":meta".length));
      } while (cursor !== "0" && names.size < MAX_QUEUES);
      const list = [...names].sort().slice(0, MAX_QUEUES);
      if (!list.length) return [];
      const depth = client.pipeline();
      for (const n of list) {
        depth.llen(`bull:${n}:wait`).llen(`bull:${n}:active`).zcard(`bull:${n}:delayed`).zcard(`bull:${n}:failed`).zrevrange(`bull:${n}:completed`, 0, 0);
      }
      const d = (await depth.exec()) ?? [];
      const lastIds = list.map((_, i) => ((d[i * 5 + 4]?.[1] as string[] | undefined) ?? [])[0] ?? null);
      const dur = client.pipeline();
      list.forEach((n, i) => {
        if (lastIds[i]) dur.hmget(`bull:${n}:${lastIds[i]}`, "processedOn", "finishedOn");
      });
      const dr = (await dur.exec()) ?? [];
      let k = 0;
      return list.map((name, i) => {
        let lastDurationMs: number | null = null;
        if (lastIds[i]) {
          const [p, f] = (dr[k++]?.[1] as (string | null)[] | undefined) ?? [];
          if (p && f && Number(f) >= Number(p)) lastDurationMs = Number(f) - Number(p);
        }
        const num = (j: number) => Number(d[i * 5 + j]?.[1] ?? 0);
        return { name, waiting: num(0), active: num(1), delayed: num(2), failed: num(3), lastDurationMs };
      });
    } catch (e) {
      this.logger.warn(`queue health read failed: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }
}
