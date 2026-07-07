import { Injectable, OnModuleDestroy } from "@nestjs/common";
import type { MetricsSample } from "@tugra/shared";
import { Observable, Subject, filter, map } from "rxjs";
import type Redis from "ioredis";
import { RedisService } from "../redis/redis.service";

const CHANNEL_PREFIX = "metrics:";

/**
 * Fans the metrics samples that the ingest path publishes to Redis (channel
 * `metrics:<serverId>`) out to live SSE subscribers. A single duplicated
 * connection psubscribes to every server's channel and a hot Subject routes each
 * message to the right per-server observable, so N viewers across N servers cost
 * exactly one Redis subscriber connection.
 */
@Injectable()
export class MetricsLiveService implements OnModuleDestroy {
  private sub?: Redis;
  private readonly stream = new Subject<{ serverId: string; sample: MetricsSample }>();

  constructor(private readonly redis: RedisService) {}

  /**
   * Open the shared subscriber connection on first use. Lazy (not onModuleInit)
   * so we never touch RedisService before it has built its client, and so no
   * Redis subscription is created until someone actually watches metrics. A
   * connection in subscriber mode can't run normal commands, so we duplicate the
   * shared client rather than borrowing it.
   */
  private ensureSubscriber(): void {
    if (this.sub) return;
    this.sub = this.redis.client.duplicate();
    // Swallow connection errors on the subscriber (Redis down/blip) so they don't
    // surface as unhandled events; live fan-out is best-effort and the UI still
    // has its slow-poll fallback.
    this.sub.on("error", () => undefined);
    this.sub.on("pmessage", (_pattern, channel, message) => this.handle(channel, message));
    // .catch: a rejected psubscribe (auth failure / connection closed while the
    // command is still queued) must not become an unhandled rejection.
    void this.sub.psubscribe(`${CHANNEL_PREFIX}*`).catch(() => undefined);
  }

  /** Route one raw Redis message to the per-server stream. Exposed for tests. */
  handle(channel: string, message: string): void {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const serverId = channel.slice(CHANNEL_PREFIX.length);
    let sample: MetricsSample;
    try {
      sample = JSON.parse(message) as MetricsSample;
    } catch {
      return; // drop malformed payloads
    }
    this.stream.next({ serverId, sample });
  }

  /** Live samples for one server (hot: future samples only, no replay). */
  subscribe(serverId: string): Observable<MetricsSample> {
    this.ensureSubscriber();
    return this.stream.pipe(
      filter((m) => m.serverId === serverId),
      map((m) => m.sample),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.sub?.quit();
    this.stream.complete();
  }
}
