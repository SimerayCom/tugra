import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, Queue, Worker } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { RedisService } from "../redis/redis.service";
import { webBaseUrl } from "../common/web-url";
import { getProvider } from "./providers";
import { renderEvent, type NotificationEvent, type RenderEnv } from "./event";
import { NotifI18nService } from "./notif-i18n.service";

const QUEUE = "notifications";

// Monitor events are NOT deduped at the notification layer: the monitor runner's state machine
// (monitors/transition.ts) is their authoritative throttle — it fires only on down/up EDGES plus the
// configured `resendEvery` re-alerts. A blind time-window dedup would silently drop those configured
// resend re-alerts AND (worse) suppress a genuine re-DOWN that follows a recovery, leaving the operator's
// last alert as "recovered" while the service is down. So we skip anything monitor_*.
const MONITOR_PREFIX = "monitor_";

// Stable, UNIQUE resource-identity fields read from a fired event's ctx to build a dedupe key. Only durable
// unique ids belong here — NOT display names (e.g. tokenName is a non-unique label → deliberately excluded,
// else two distinct tokens sharing a name collapse and the second is never alerted) and NOT volatile fields
// (errorTail/sizeBytes/responseMs/durationMs/days/…). All present values are joined so an app-scoped task
// keeps appId+taskName distinct. An event carrying none of these has no safe key and is NOT deduped.
const ID_FIELDS = ["appId", "dbId", "serverId", "domain", "taskName"] as const;

/** A stable entity key for the resource an event is about, or "" when the ctx carries no unique identifier. */
function entityKey(ctx: Record<string, unknown>): string {
  return ID_FIELDS.map((f) => ctx[f]).filter((v) => v != null && v !== "").map(String).join(":");
}

/** Redis key for the dedupe window. event.type is part of the key so distinct event types on the same
 *  resource never collapse into each other. */
function dedupeKey(channelId: string, eventType: string, entity: string): string {
  return `notifdedup:${channelId}:${eventType}:${entity}`;
}

interface DeliverJob {
  deliveryId: string;
  channelId: string;
  event: NotificationEvent;
}

/**
 * Durable notification delivery. Firing sites enqueue one job per channel; a BullMQ worker sends it
 * with retry/backoff and records the outcome in a NotificationDelivery row (PENDING → SENT | FAILED →
 * DEAD). The job carries only {deliveryId, channelId, event} — the channel config (secrets) is NEVER
 * put on Redis; the worker re-fetches the channel and decrypts the config at send time. In tests
 * (NODE_ENV==="test") no Queue/Worker/Redis is created and delivery runs inline+synchronously.
 */
@Injectable()
export class NotificationQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NotificationQueueService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly i18n: NotifI18nService,
    private readonly redis: RedisService,
  ) {}

  private connection() {
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
  }

  /** Render environment for the templates: deep-link base + a translator bound to the channel's locale. */
  private renderEnv(locale?: string): RenderEnv {
    return { webBaseUrl: webBaseUrl(this.config), t: this.i18n.forLocale(locale) };
  }

  private decodeConfig(configEnc: string): Record<string, unknown> {
    try {
      return JSON.parse(this.crypto.decrypt(configEnc));
    } catch {
      return {};
    }
  }

  onApplicationBootstrap(): void {
    // BullMQ worker/Redis are disabled in tests; delivery runs inline (see enqueue/deliverNow).
    if (process.env.NODE_ENV === "test") return;
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker<DeliverJob>(QUEUE, (job) => this.handleJob(job), { connection });
    this.worker.on("failed", (job, err) => void this.handleFailed(job, err));
    this.worker.on("error", (err) => this.logger.error(`worker error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  /**
   * Persist a PENDING snapshot, then queue it (prod) or send it once inline (test). BEST-EFFORT — this
   * NEVER throws: firing sites loop over channels and some callers (the monitor runner) don't guard the
   * await, so one channel's DB/Redis hiccup must not abort the loop or reject to the caller.
   */
  async enqueue(channelId: string, event: NotificationEvent): Promise<void> {
    // Dedupe/throttle: suppress a repeat of the same (channel, event, entity) GENERAL alert within the
    // window, BEFORE the snapshot — a suppressed enqueue creates no delivery row and no job. Skipped for
    // monitors (the runner throttles them) and for events with no unique entity id (never risk collapsing
    // two distinct resources). Fail-open: a Redis hiccup must never drop an alert (availability > dedup),
    // and this check must never throw (enqueue is best-effort). 0/unset window disables dedupe. deliverNow
    // (the test button) bypasses this entirely.
    const windowSec = Number(this.config.get<number>("NOTIFY_DEDUPE_WINDOW_SEC") ?? 0);
    if (windowSec > 0 && !event.type.startsWith(MONITOR_PREFIX)) {
      const entity = entityKey(event.ctx);
      if (entity) {
        const fresh = await this.redis.firstInWindow(dedupeKey(channelId, event.type, entity), windowSec).catch(() => true);
        if (!fresh) return;
      }
    }
    let delivery: { id: string };
    try {
      delivery = await this.snapshot(channelId, event);
    } catch (err) {
      // Couldn't even record it (e.g. the channel was deleted between the fire query and here → FK
      // violation). Log and move on so the remaining channels in the loop still fire.
      this.logger.error(`enqueue snapshot(${channelId}): ${sanitizeError(err)}`);
      return;
    }
    if (this.queue) {
      try {
        await this.queue.add(
          "deliver",
          { deliveryId: delivery.id, channelId, event },
          {
            attempts: 5,
            // 10s → 20s → 40s → 80s, ±jitter so N channels don't retry in lockstep on a provider outage.
            backoff: { type: "exponential", delay: 10_000, jitter: 0.5 },
            removeOnComplete: 1000,
            // NOT `false` — that keeps every dead job in Redis forever; the DB row is the durable record.
            removeOnFail: { count: 5000 },
          },
        );
      } catch (err) {
        // Queue unavailable (Redis down) — don't leave the row stuck PENDING and don't reject the fire.
        this.logger.error(`enqueue add(${channelId}): ${sanitizeError(err)}`);
        await this.markFailed(delivery.id, 0, err, false).catch(() => undefined);
      }
      return;
    }
    // test / no-Redis: one synchronous attempt; record the outcome and swallow (fire is best-effort).
    try {
      await this.attempt(delivery.id, channelId, event, 1);
    } catch (err) {
      await this.markFailed(delivery.id, 1, err, false).catch(() => undefined);
      await this.audit.log({ actor: "system", action: "notification.failed", target: channelId }).catch(() => undefined);
    }
  }

  /** Test button: one synchronous send that records a delivery and RETHROWS so the caller sees pass/fail. */
  async deliverNow(channelId: string, event: NotificationEvent): Promise<void> {
    const delivery = await this.snapshot(channelId, event);
    try {
      await this.attempt(delivery.id, channelId, event, 1);
    } catch (err) {
      await this.markFailed(delivery.id, 1, err, false).catch(() => undefined);
      throw err;
    }
  }

  /** Create the PENDING delivery row with a rendered snapshot (title/summary/level) for the history. */
  private async snapshot(channelId: string, event: NotificationEvent) {
    const msg = renderEvent(event, this.renderEnv(event.locale));
    return this.prisma.notificationDelivery.create({
      data: { channelId, event: event.type, level: msg.level, title: msg.title, summary: msg.summary },
    });
  }

  /** One send attempt: re-fetch the channel (fresh config), render, send. Throws on provider failure. */
  private async attempt(deliveryId: string, channelId: string, event: NotificationEvent, attempts: number): Promise<void> {
    const ch = await this.prisma.notificationChannel.findUnique({ where: { id: channelId } });
    if (!ch) return; // channel was deleted (its deliveries cascade away) — nothing to send, no retry
    const msg = renderEvent(event, this.renderEnv(event.locale));
    await getProvider(ch.type).send(this.decodeConfig(ch.configEnc), msg); // throws → inline caller / BullMQ retry
    // The send already happened — a DB hiccup here must NOT reject the job (that would re-send). Swallow.
    await this.markSent(deliveryId, attempts).catch((e) => this.logger.error(`markSent: ${e.message}`));
  }

  /** BullMQ processor. Throwing schedules a backoff retry; success is recorded inside attempt(). */
  private async handleJob(job: Job<DeliverJob>): Promise<void> {
    const { deliveryId, channelId, event } = job.data;
    await this.attempt(deliveryId, channelId, event, job.attemptsMade + 1);
  }

  /** 'failed' handler — fire-and-forget; must never throw. Marks FAILED (interim) or DEAD (final). */
  private async handleFailed(job: Job<DeliverJob> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const { deliveryId, channelId } = job.data;
    // In BullMQ v5, attemptsMade is already incremented (includes the attempt that just failed).
    const attempts = job.attemptsMade;
    const dead = attempts >= (job.opts.attempts ?? 1);
    await this.markFailed(deliveryId, attempts, err, dead).catch(() => undefined);
    if (dead) {
      await this.audit.log({ actor: "system", action: "notification.dead", target: channelId }).catch(() => undefined);
    }
  }

  private async markSent(deliveryId: string, attempts: number): Promise<void> {
    // updateMany + status guard: a stale interim-FAILED can never clobber SENT, and a cascade-deleted
    // row is a 0-row no-op instead of a P2025 throw.
    await this.prisma.notificationDelivery.updateMany({
      where: { id: deliveryId, status: { not: "SENT" } },
      data: { status: "SENT", attempts, sentAt: new Date(), lastError: null },
    });
  }

  private async markFailed(deliveryId: string, attempts: number, err: unknown, dead: boolean): Promise<void> {
    await this.prisma.notificationDelivery.updateMany({
      where: { id: deliveryId, status: { not: "SENT" } },
      data: { status: dead ? "DEAD" : "FAILED", attempts, lastError: sanitizeError(err) },
    });
  }
}

/** Keep a delivery error useful in the history UI but redact anything that looks like a credential. */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/\b(token|api[_-]?key|password|passwd|pass|secret|authorization|bearer)\b\s*[:=]?\s*\S+/gi, "$1=***")
    .replace(/([?&](?:token|api[_-]?key|key|secret|access_token)=)[^&\s]+/gi, "$1***")
    .slice(0, 200);
}
