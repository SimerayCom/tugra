import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { Queue, Worker, type ConnectionOptions, type Processor, type WorkerOptions } from "bullmq";
import { redisConnectionOptions } from "../common/redis-connection";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";

/** Don't repeat the same connection error more than once per this many ms per queue (a Redis outage would otherwise
 *  log once per socket per second). */
const ERROR_LOG_EVERY_MS = 30_000;

/**
 * The ONE place the hub creates BullMQ queues and workers. Every Queue shares a single ioredis connection (BullMQ only
 * needs a private connection for the blocking read, which each Worker duplicates from the shared one), so the hub holds
 * 1 + (number of workers) Redis sockets instead of 3 per queue/worker pair. Also owns the shutdown order (workers, then
 * queues, then the connection) and the `NODE_ENV=test` switch: under test nothing here ever touches Redis.
 */
@Injectable()
export class QueueHubService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueHubService.name);
  private conn?: Redis;
  private readonly queues = new Set<Queue>();
  private readonly workers = new Set<Worker>();
  private readonly lastErrorAt = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  /** False under NODE_ENV=test (house convention: schedulers and queues are off, specs drive the runners directly). */
  get enabled(): boolean {
    return process.env.NODE_ENV !== "test";
  }

  /** The shared ioredis connection, created on first use. */
  connection(): Redis {
    if (!this.conn) {
      this.conn = new Redis({ ...redisConnectionOptions(this.config.get<string>("REDIS_URL")!), connectionName: "tugra:bullmq" });
      // ioredis emits "error" on connection trouble and manages its own reconnects; without a listener Node would
      // treat it as unhandled and crash the process.
      this.conn.on("error", (err: Error) => this.logError("shared", err));
    }
    return this.conn;
  }

  /** BullMQ bundles its own ioredis copy, so its types reject our (structurally identical) instance; at runtime it
   *  accepts any ioredis client and shares it (Queue) or duplicates it for the blocking read (Worker). */
  private bull(): ConnectionOptions {
    return this.connection() as unknown as ConnectionOptions;
  }

  queue(name: string): Queue {
    const q = new Queue(name, { connection: this.bull(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
    q.on("error", (err) => this.logError(name, err));
    this.queues.add(q);
    return q;
  }

  /** Close and forget a short-lived queue handle (boot-time maintenance). */
  async release(q: Queue): Promise<void> {
    this.queues.delete(q);
    await q.close().catch(() => undefined);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- job payloads are typed by each caller, like BullMQ's own default
  worker<T = any>(name: string, processor: Processor<T>, opts: Omit<WorkerOptions, "connection"> = {}): Worker<T> {
    const w = new Worker<T>(name, processor, { ...opts, connection: this.bull() });
    w.on("error", (err) => this.logError(name, err));
    this.workers.add(w as Worker);
    return w;
  }

  private logError(scope: string, err: Error): void {
    const now = Date.now();
    if (now - (this.lastErrorAt.get(scope) ?? 0) < ERROR_LOG_EVERY_MS) return;
    this.lastErrorAt.set(scope, now);
    this.logger.warn(`redis/bullmq error (${scope}): ${err.message}`);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.workers].map((w) => w.close()));
    await Promise.allSettled([...this.queues].map((q) => q.close()));
    this.workers.clear();
    this.queues.clear();
    if (this.conn) {
      await this.conn.quit().catch(() => this.conn?.disconnect());
      this.conn = undefined;
    }
  }
}
