import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { redisConnectionOptions } from "../common/redis-connection";
import { Queue, Worker } from "bullmq";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { isAutoApplicable } from "@tugra/shared";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { UpdateService } from "./update.service";
import { UpdaterService } from "./updater.service";

const QUEUE = "update-check";

/**
 * Periodic self-update version check — ON by default (the official manifest URL + key are env defaults;
 * TUGRA_UPDATE_CHECKS=0 turns it off entirely). Mirrors the house recurring-job pattern (BullMQ Queue+Worker in
 * OnApplicationBootstrap, disabled in tests). The INITIAL check runs directly (not via the queue) and is NOT
 * awaited, so neither a flaky Redis nor a blackholed network can delay boot; only the recurring repeat needs
 * Redis. The check never throws — an offline/unreachable manifest keeps the cached status.
 */
@Injectable()
export class UpdateCheckSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(UpdateCheckSchedulerService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly update: UpdateService,
    private readonly updater: UpdaterService,
    private readonly settings: InstanceSettingsService,
  ) {}

  private connection() {
    return redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
  }

  /**
   * A recurring check: refresh the cached latest, then — ONLY when auto-update is on AND the new version is
   * auto-applicable (a patch bump, or the next prerelease of the same series: beta.N → beta.N+1) — apply it
   * automatically. A minor/major and beta → stable are left as notify-only (the owner must click Update now). Runs only from the recurring worker, never the initial bootstrap check, so a restart during a
   * window that still lists a newer patch can't immediately re-trigger. Never throws.
   */
  async runScheduledCheck(): Promise<void> {
    const result = await this.update.checkRemote();
    if (result.status !== "ok" || !result.updateAvailable) return;
    let autoUpdate = false;
    try {
      autoUpdate = (await this.settings.get()).autoUpdate;
    } catch {
      return; // a transient DB error just skips this round's auto-apply
    }
    if (autoUpdate && isAutoApplicable(result.latest, result.current)) {
      const applied = await this.updater.requestUpdate({ actor: "auto-update", auto: true });
      this.logger.log(`auto-update ${result.current} → ${result.latest}: ${applied.status}`);
    }
  }

  /** True when the last successful check is older than the interval (or there was none). A DB error → not due. */
  private async dueForInitialCheck(intervalMin: number): Promise<boolean> {
    try {
      const s = await this.settings.get();
      if (!s.updateLastCheckedAt) return true;
      return (Date.now() - s.updateLastCheckedAt.getTime()) / 60_000 >= intervalMin;
    } catch {
      return false; // a transient DB error just defers the first check to the recurring job
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests
    if (this.update.isForcedOff()) {
      this.logger.log("update checks disabled by environment (TUGRA_UPDATE_CHECKS=0) — not scheduling");
      return; // hard off: no Redis, no network, nothing
    }
    if (!this.update.isConfigured()) {
      this.logger.warn(
        "update checks are unconfigured (UPDATE_PUBLISHER_KEY without UPDATE_MANIFEST_URL, or both blank) — set both or TUGRA_UPDATE_CHECKS=0",
      );
      return;
    }
    const intervalMin = this.config.get<number>("UPDATE_CHECK_INTERVAL_MIN") ?? 60;
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.worker = new Worker(QUEUE, async () => { await this.runScheduledCheck(); }, { connection });
    // Remove any stale repeatable keyed by a previous interval (the old daily default), so an upgraded install
    // doesn't run a 1440m job AND the new one (BullMQ keys a repeat by its `every` value).
    for (const r of await this.queue.getRepeatableJobs()) {
      if (r.name === "update-check") await this.queue.removeRepeatableByKey(r.key);
    }
    await this.queue.add("update-check", {}, { repeat: { every: intervalMin * 60_000 } });
    this.logger.log(`scheduled update check every ${intervalMin}m`);
    // Initial check refreshes the cache only (never auto-applies — that's the recurring path's job) and is
    // fire-and-forget: NestJS runs bootstrap hooks before accepting connections, so awaiting a network call
    // here would hold boot for up to the fetch timeout on a blackholed network.
    if (await this.dueForInitialCheck(intervalMin)) {
      void this.update.checkRemote().catch((e) => this.logger.warn(`initial update check failed: ${String(e)}`));
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
