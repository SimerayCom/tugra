import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { redisConnectionOptions } from "../common/redis-connection";
import { createHash } from "node:crypto";
import { Job, Queue, Worker } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { RedisService } from "../redis/redis.service";
import { webBaseUrl } from "../common/web-url";
import { getProvider } from "./providers";
import { renderEvent, type NotificationEvent, type RenderEnv } from "./event";
import { NotifI18nService } from "./notif-i18n.service";
import { eventSeverity, routedConfig } from "./routing";
import { entityKey } from "./entity-key";
import { buildSummaryCtx, inQuietHours, msUntilQuietEnds, parsePolicy, rateLimitFor, type HeldEntry, type HoldReason } from "./policy";

const QUEUE = "notifications";

// Monitor events are NOT deduped at the notification layer: the monitor runner's state machine
// (monitors/transition.ts) is their authoritative throttle — it fires only on down/up EDGES plus the
// configured `resendEvery` re-alerts. A blind time-window dedup would silently drop those configured
// resend re-alerts AND (worse) suppress a genuine re-DOWN that follows a recovery, leaving the operator's
// last alert as "recovered" while the service is down. So we skip anything monitor_*.
const MONITOR_PREFIX = "monitor_";

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

/** A delayed job that turns what a channel held back (repeats / quiet hours / rate limit) into one summary. */
export interface FlushJob {
  channelId: string;
  reason: HoldReason;
  key: string;
  teamId: string;
  locale?: string;
  windowSec: number;
}

/** What {@link NotificationQueueService.enqueue} may be told up front, to skip a channel lookup. */
export interface EnqueueOpts {
  /** The channel's type + stored policy, when the caller already loaded the row. */
  channel?: { type: string; policy: unknown };
  /** Deliver regardless of quiet hours / repeat window / rate limit (digests, summaries). */
  bypassPolicy?: boolean;
}

const LEDGER_CAP = 200;

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
    return redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
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
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker<DeliverJob | FlushJob>(QUEUE, (job) => this.handleJob(job), { connection });
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
  async enqueue(channelId: string, event: NotificationEvent, opts: EnqueueOpts = {}): Promise<void> {
    // Policy gate (quiet hours → repeat window → rate limit), BEFORE the snapshot — a held alert creates no
    // delivery row and no job; it is folded into one summary later. Fail-open: a Redis/DB hiccup must never
    // drop an alert (availability > policy), and nothing here may throw (enqueue is best-effort). The test
    // button (deliverNow) and bypassPolicy callers (digests, summaries) skip it entirely.
    if (!opts.bypassPolicy && !(await this.admit(channelId, event, opts))) return;
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

  /** true = deliver now; false = held (and folded into a later summary). Never throws. */
  private async admit(channelId: string, event: NotificationEvent, opts: EnqueueOpts): Promise<boolean> {
    try {
      const channel =
        opts.channel ?? (await this.prisma.notificationChannel.findUnique({ where: { id: channelId }, select: { type: true, policy: true } }));
      if (!channel) return true; // gone — the snapshot step logs and skips it
      const policy = parsePolicy(channel.policy);
      const now = new Date();

      const quiet = policy.quietHours;
      if (quiet && inQuietHours(quiet, now) && !(quiet.allowCritical && eventSeverity(event) === "critical")) {
        await this.hold(channelId, "quiet", "all", event, msUntilQuietEnds(quiet, now), 0);
        return false;
      }

      // Repeat window. Skipped for monitors (the runner's state machine is their authoritative throttle — a
      // blind window would swallow configured resend re-alerts and a genuine re-DOWN after recovery) and for
      // events with no unique entity id (never risk collapsing two distinct resources).
      const windowSec = policy.dedupeWindowSec ?? Number(this.config.get<number>("NOTIFY_DEDUPE_WINDOW_SEC") ?? 0);
      if (windowSec > 0 && !event.type.startsWith(MONITOR_PREFIX)) {
        const entity = entityKey(event.ctx);
        if (entity) {
          const fresh = await this.redis.firstInWindow(dedupeKey(channelId, event.type, entity), windowSec).catch(() => true);
          if (!fresh) {
            await this.hold(channelId, "repeat", `${event.type}:${entity}`, event, windowSec * 1000, windowSec);
            return false;
          }
        }
      }

      const limit = rateLimitFor(channel.type, policy);
      const minute = Math.floor(now.getTime() / 60_000);
      const used = await this.redis.incr(`notifrate:${channelId}:${minute}`, 120);
      if (used > limit) {
        await this.hold(channelId, "rate", String(minute), event, 60_000 - (now.getTime() % 60_000) + 1000, 60);
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /** Record a held alert and make sure one flush job is waiting to summarise the group. Never throws. */
  private async hold(channelId: string, reason: HoldReason, group: string, event: NotificationEvent, delayMs: number, windowSec: number): Promise<void> {
    try {
      const msg = renderEvent(event, this.renderEnv(event.locale));
      const key = `notifsup:${channelId}:${reason}:${group}`;
      const entry: HeldEntry = { type: event.type, title: msg.title.slice(0, 200), level: msg.level, at: new Date().toISOString() };
      await this.redis.ledgerAdd(key, JSON.stringify(entry), LEDGER_CAP, Math.ceil(delayMs / 1000) + 3600);
      if (!this.queue) return; // tests / no-Redis: the ledger is kept, flush() is driven directly
      const job: FlushJob = { channelId, reason, key, teamId: event.teamId, locale: event.locale, windowSec };
      await this.queue.add("flush", job, {
        delay: Math.max(1000, delayMs),
        // Same group → same id → BullMQ ignores the duplicate, so a burst schedules exactly one summary.
        jobId: `flush-${createHash("sha1").update(key).digest("hex")}`,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
        backoff: { type: "fixed", delay: 30_000 },
      });
    } catch (err) {
      this.logger.warn(`hold(${channelId}): ${sanitizeError(err)}`);
    }
  }

  /** Turn a held group into one summary message and deliver it (durably, bypassing the policy gate). */
  async flush(job: FlushJob): Promise<void> {
    const { total, entries } = await this.redis.ledgerDrain(job.key);
    const held: HeldEntry[] = [];
    for (const raw of entries) {
      try {
        const e = JSON.parse(raw) as HeldEntry;
        if (typeof e.title === "string" && typeof e.level === "string") held.push(e);
      } catch {
        /* skip a corrupt entry */
      }
    }
    if (!total && held.length === 0) return;
    const ctx = buildSummaryCtx(job.reason, held, total || held.length, job.windowSec);
    await this.enqueue(job.channelId, { type: "alert_summary", teamId: job.teamId, locale: job.locale, ctx }, { bypassPolicy: true });
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
    // Telegram: the event's category may select a forum topic (resolved here, from the fresh channel row,
    // so a topic edited between enqueue and a retry applies). Other types are untouched.
    const cfg = routedConfig(ch.type, this.decodeConfig(ch.configEnc), ch.topics, event);
    await getProvider(ch.type).send(cfg, msg); // throws → inline caller / BullMQ retry
    // The send already happened — a DB hiccup here must NOT reject the job (that would re-send). Swallow.
    await this.markSent(deliveryId, attempts).catch((e) => this.logger.error(`markSent: ${e.message}`));
  }

  /** BullMQ processor. Throwing schedules a backoff retry; success is recorded inside attempt(). */
  private async handleJob(job: Job<DeliverJob | FlushJob>): Promise<void> {
    if (job.name === "flush") return this.flush(job.data as FlushJob);
    const { deliveryId, channelId, event } = job.data as DeliverJob;
    await this.attempt(deliveryId, channelId, event, job.attemptsMade + 1);
  }

  /** 'failed' handler — fire-and-forget; must never throw. Marks FAILED (interim) or DEAD (final). */
  private async handleFailed(job: Job<DeliverJob | FlushJob> | undefined, err: Error): Promise<void> {
    if (!job || job.name === "flush") return; // a flush has no delivery row; its own retries cover a hiccup
    const { deliveryId, channelId } = job.data as DeliverJob;
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
