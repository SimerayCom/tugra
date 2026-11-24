import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker } from "bullmq";
import { redisConnectionOptions } from "../common/redis-connection";
import { DEFAULT_JOB_OPTIONS } from "../common/queue-options";
import { PrismaService } from "../prisma/prisma.service";
import { HubRestoreDrillService } from "./hub-restore-drill.service";
import { HubDeadmanService } from "./hub-deadman.service";

const DRILL_QUEUE = "hub-backup-drill";
const DRILL_JOB = "hub-backup-drill";
/** 03:20 on the 1st of every month. */
export const DRILL_CRON = "20 3 1 * *";
const DEADMAN_QUEUE = "hub-deadman";
const DEADMAN_JOB = "hub-deadman";

/** Two repeatable jobs: the monthly restore drill and the dead-man check-in. Disabled in tests (no Redis). */
@Injectable()
export class HubWatchSchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(HubWatchSchedulerService.name);
  private drillQueue?: Queue;
  private deadmanQueue?: Queue;
  private workers: Worker[] = [];

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly drills: HubRestoreDrillService,
    private readonly deadman: HubDeadmanService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const connection = redisConnectionOptions(this.config.get<string>("REDIS_URL")!);
    this.drillQueue = new Queue(DRILL_QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.deadmanQueue = new Queue(DEADMAN_QUEUE, { connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    this.workers = [
      new Worker(DRILL_QUEUE, async () => this.runDrillIfEnabled(), { connection }),
      new Worker(DEADMAN_QUEUE, async () => this.deadman.tick(), { connection }),
    ];
    try {
      await this.applyDrill();
      await this.applyDeadman();
    } catch (e) {
      this.logger.warn(`hub watch schedules not applied: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async runDrillIfEnabled(): Promise<void> {
    const cfg = await this.prisma.hubBackupConfig.findUnique({ where: { id: "singleton" } });
    if (cfg && !cfg.drillEnabled) return;
    // nothing to drill without a stored hub backup (a manual one counts: the schedule need not be on)
    if ((await this.prisma.hubBackup.count({ where: { status: "SUCCESS" } })) === 0) return;
    await this.drills.run("schedule").catch((e) => this.logger.warn(`scheduled restore drill could not run: ${e instanceof Error ? e.message : e}`));
  }

  /** Always scheduled; the job itself checks the switch, so toggling needs no re-apply. */
  async applyDrill(): Promise<void> {
    if (!this.drillQueue) return;
    for (const r of await this.drillQueue.getRepeatableJobs()) if (r.name === DRILL_JOB) await this.drillQueue.removeRepeatableByKey(r.key);
    await this.drillQueue.add(DRILL_JOB, {}, { repeat: { pattern: DRILL_CRON } });
  }

  /** A one-minute tick; the service decides whether a check-in is due (so an interval change needs no re-schedule). */
  async applyDeadman(): Promise<void> {
    if (!this.deadmanQueue) return;
    for (const r of await this.deadmanQueue.getRepeatableJobs()) if (r.name === DEADMAN_JOB) await this.deadmanQueue.removeRepeatableByKey(r.key);
    await this.deadmanQueue.add(DEADMAN_JOB, {}, { repeat: { every: 60_000 } });
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await this.drillQueue?.close();
    await this.deadmanQueue?.close();
  }
}
