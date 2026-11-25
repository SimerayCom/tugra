import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

/**
 * Applies the RAM profile's Postgres and Redis sizing (TUGRA_PG_* / TUGRA_REDIS_MAXMEMORY, written to .env by the
 * installer's profile) from inside the hub at boot. They used to be a `command:` on the postgres and redis services, but
 * the in-app updater never recreates the database or Redis, so any compose change there blocked every in-app update.
 *
 * Postgres: ALTER SYSTEM (postgresql.auto.conf) + pg_reload_conf(). Reloadable settings take effect at once;
 * shared_buffers and max_connections take effect at the next Postgres restart (a host reboot or the installer).
 * Redis: CONFIG SET maxmemory + `noeviction` (BullMQ requires it) on every boot (Redis keeps no config file here).
 * Only values that are SET are applied: an install without a profile is left exactly as it is. Never throws.
 */
export const PG_SETTINGS: ReadonlyArray<{ env: string; name: string; restart: boolean }> = [
  { env: "TUGRA_PG_SHARED_BUFFERS", name: "shared_buffers", restart: true },
  { env: "TUGRA_PG_MAX_CONNECTIONS", name: "max_connections", restart: true },
  { env: "TUGRA_PG_EFFECTIVE_CACHE_SIZE", name: "effective_cache_size", restart: false },
  { env: "TUGRA_PG_WORK_MEM", name: "work_mem", restart: false },
  { env: "TUGRA_PG_MAINTENANCE_WORK_MEM", name: "maintenance_work_mem", restart: false },
  { env: "TUGRA_PG_PARALLEL_WORKERS", name: "max_parallel_workers_per_gather", restart: false },
  { env: "TUGRA_PG_MAX_WAL_SIZE", name: "max_wal_size", restart: false },
  { env: "TUGRA_PG_CHECKPOINT_TIMEOUT", name: "checkpoint_timeout", restart: false },
];

/** A Postgres size/number/duration literal ("96MB", "4MB", "30", "5min", "on"): nothing else reaches ALTER SYSTEM. */
export function safePgValue(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  return /^(\d{1,9}(kB|MB|GB|TB|ms|s|min|h)?|on|off)$/.test(t) ? t : null;
}

/** A Redis memory size ("256mb", "1gb", "0"). */
export function safeRedisSize(v: string | undefined): string | null {
  const t = (v ?? "").trim().toLowerCase();
  return /^\d{1,9}(b|k|kb|m|mb|g|gb)?$/.test(t) ? t : null;
}

@Injectable()
export class DatastoreTuningService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatastoreTuningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    await this.apply(process.env);
  }

  async apply(env: NodeJS.ProcessEnv): Promise<{ pg: string[]; pending: string[]; redis: boolean }> {
    const pg: string[] = [];
    const pending: string[] = [];
    for (const s of PG_SETTINGS) {
      const want = safePgValue(env[s.env]);
      if (env[s.env] && !want) this.logger.warn(`${s.env} ignored: not a Postgres value`);
      if (!want) continue;
      try {
        // Compare with what ALTER SYSTEM would store, so a value already applied is not rewritten every boot.
        const rows = await this.prisma.$queryRawUnsafe<{ v: string | null }[]>(
          "SELECT setting || COALESCE(unit, '') AS v FROM pg_settings WHERE name = $1", s.name,
        );
        const auto = await this.prisma.$queryRawUnsafe<{ v: string }[]>(
          "SELECT setting AS v FROM pg_file_settings WHERE name = $1 AND sourcefile LIKE '%postgresql.auto.conf' ORDER BY seqno DESC LIMIT 1", s.name,
        );
        if (auto[0]?.v === want) continue;
        // `name` comes from the fixed list above and `want` matched a strict literal pattern: safe to inline.
        await this.prisma.$executeRawUnsafe(`ALTER SYSTEM SET ${s.name} = '${want}'`);
        pg.push(`${s.name}=${want}`);
        if (s.restart && rows[0]?.v !== want) pending.push(s.name);
      } catch (e) {
        this.logger.warn(`could not set ${s.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (pg.length) {
      try {
        await this.prisma.$executeRawUnsafe("SELECT pg_reload_conf()");
      } catch (e) {
        this.logger.warn(`pg_reload_conf failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.logger.log(`Postgres sizing applied: ${pg.join(", ")}${pending.length ? ` (${pending.join(", ")} after the next Postgres restart)` : ""}`);
    }

    let redis = false;
    const maxmemory = safeRedisSize(env.TUGRA_REDIS_MAXMEMORY);
    if (maxmemory) {
      try {
        await this.redis.client.config("SET", "maxmemory", maxmemory);
        await this.redis.client.config("SET", "maxmemory-policy", "noeviction");
        redis = true;
      } catch (e) {
        this.logger.warn(`could not size Redis: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { pg, pending, redis };
  }
}
