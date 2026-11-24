import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private redis!: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    // commandTimeout makes a command REJECT (instead of hanging forever) when Redis is unreachable, so the
    // auth path (login rate-limit, refresh-token store) and every other caller fail fast rather than pile up
    // and exhaust the event loop. maxRetriesPerRequest stays unbounded so a short reconnect blip is still
    // retried within the timeout window, not failed outright.
    this.redis = new Redis(this.config.get<string>("REDIS_URL")!, {
      maxRetriesPerRequest: null,
      commandTimeout: this.config.get<number>("REDIS_COMMAND_TIMEOUT_MS") ?? 10_000,
    });
    // ioredis emits "error" on connection trouble; without a listener Node would throw on the unhandled
    // "error" event and crash the process. Log and let ioredis manage its own reconnect/backoff.
    this.redis.on("error", (err: Error) => this.logger.warn(`redis connection error: ${err.message}`));
  }

  get client(): Redis {
    return this.redis;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redis.set(key, value, "EX", ttlSeconds);
    } else {
      await this.redis.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.redis.del(...keys);
  }

  async sadd(key: string, member: string): Promise<void> {
    await this.redis.sadd(key, member);
  }

  async srem(key: string, ...members: string[]): Promise<void> {
    if (members.length) await this.redis.srem(key, ...members);
  }

  /**
   * Atomic counter with a fixed-window TTL applied on the FIRST increment (the count
   * expires as a whole once the window lapses). Used for per-email login rate limiting and
   * the failed-attempt lockout counter. Returns the post-increment value.
   */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (ttlSeconds && n === 1) await this.redis.expire(key, ttlSeconds);
    return n;
  }

  /** Like incr, but adds `amount` at once (fixed-window TTL set when this is the first write in the window).
   *  Used to charge a rate-limit budget by units of WORK (e.g. messages in a JSON-RPC batch), not just calls. */
  async incrBy(key: string, amount: number, ttlSeconds?: number): Promise<number> {
    const n = await this.redis.incrby(key, amount);
    if (ttlSeconds && n === amount) await this.redis.expire(key, ttlSeconds);
    return n;
  }

  async smembers(key: string): Promise<string[]> {
    return this.redis.smembers(key);
  }

  /**
   * Atomic fixed-window "first seen" gate: SET key NX EX ttl. Returns true only for the FIRST caller
   * within the window (the key was set), false for every repeat until the window lapses. Used to
   * dedupe/throttle notifications (one alert per (channel,event,entity) per window).
   */
  async firstInWindow(key: string, ttlSeconds: number): Promise<boolean> {
    const r = await this.redis.set(key, "1", "EX", ttlSeconds, "NX");
    return r === "OK";
  }

  /**
   * Append to a capped "held alerts" ledger: the list keeps the newest `cap` entries, a sibling counter keeps the
   * true total (so a flood bigger than the cap still reports its real size). Both expire together. Returns the total.
   */
  async ledgerAdd(key: string, entry: string, cap: number, ttlSeconds: number): Promise<number> {
    const res = await this.redis
      .multi()
      .incr(`${key}:n`)
      .rpush(key, entry)
      .ltrim(key, -cap, -1)
      .expire(key, ttlSeconds)
      .expire(`${key}:n`, ttlSeconds)
      .exec();
    return Number(res?.[0]?.[1] ?? 0);
  }

  /** Atomically read and clear a ledger: the total, and the (capped) entries oldest first. */
  async ledgerDrain(key: string): Promise<{ total: number; entries: string[] }> {
    const res = await this.redis.multi().get(`${key}:n`).lrange(key, 0, -1).del(key, `${key}:n`).exec();
    return { total: Number(res?.[0]?.[1] ?? 0), entries: ((res?.[1]?.[1] as string[] | undefined) ?? []) };
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }
}
