import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { isPatchUpgrade } from "@tugra/shared";
import { InstanceSettingsService } from "../instance/instance-settings.service";
import { UpdateService } from "./update.service";
import { UpdaterService } from "./updater.service";

const QUEUE = "update-check";

/**
 * Opt-in periodic self-update version check (only when UPDATE_MANIFEST_URL is set). Mirrors the house
 * recurring-job pattern (BullMQ Queue+Worker in OnApplicationBootstrap, disabled in tests). The INITIAL
 * check runs directly (not via the queue) so a flaky Redis can't block first check; only the recurring
 * repeat needs Redis. The check never throws — an offline/unreachable manifest keeps the cached status.
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
    const url = new URL(this.config.get<string>("REDIS_URL")!);
    return { host: url.hostname, port: Number(url.port || 6379), maxRetriesPerRequest: null };
  }

  /**
   * A recurring check: refresh the cached latest, then — ONLY when auto-update is on AND the new version is
   * a PATCH bump — apply it automatically. A minor/major is left as notify-only (the owner must click Update
   * now). Runs only from the recurring worker, never the initial bootstrap check, so a restart during a
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
    if (autoUpdate && isPatchUpgrade(result.latest, result.current)) {
      const applied = await this.updater.requestUpdate({ actor: "auto-update", auto: true });
      this.logger.log(`auto-update ${result.current} → ${result.latest}: ${applied.status}`);
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return; // schedulers disabled in tests
    if (!this.config.get<string>("UPDATE_MANIFEST_URL")) return; // opt-in
    // Initial check refreshes the cache only (never auto-applies — that's the recurring path's job).
    await this.update.checkRemote().catch((e) => this.logger.warn(`initial update check failed: ${String(e)}`));
    const intervalMin = this.config.get<number>("UPDATE_CHECK_INTERVAL_MIN") ?? 1440;
    const connection = this.connection();
    this.queue = new Queue(QUEUE, { connection });
    this.worker = new Worker(QUEUE, async () => { await this.runScheduledCheck(); }, { connection });
    await this.queue.add("update-check", {}, { repeat: { every: intervalMin * 60_000 } });
    this.logger.log(`scheduled update check every ${intervalMin}m`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
