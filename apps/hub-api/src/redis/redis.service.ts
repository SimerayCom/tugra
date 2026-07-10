import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private redis!: Redis;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.redis = new Redis(this.config.get<string>("REDIS_URL")!, {
      maxRetriesPerRequest: null,
    });
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

  async smembers(key: string): Promise<string[]> {
    return this.redis.smembers(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }
}
