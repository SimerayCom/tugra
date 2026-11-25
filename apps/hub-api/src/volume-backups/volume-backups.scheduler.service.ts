import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import { QueueHubService } from "../scheduler/queue-hub.service";
import { TickSchedulerService } from "../scheduler/tick-scheduler.service";
import { reapIfGone } from "../common/orphan-reap";
import { PrismaService } from "../prisma/prisma.service";
import { VolumeBackupRunnerService } from "./volume-backup-runner.service";
import { BackupAlertsService } from "../backups/backup-alerts.service";
import { policyJobExists } from "./policy";

const QUEUE = "volume-backups";
/** Tick (shared scheduler queue) that runs the missing-backup watchdog (not a per-app backup). Older hubs ran it as a
 *  repeatable on this queue; handleJob still answers one that fires late, and boot removes the old key. */
const WATCHDOG_JOB = "watchdog";
const WATCHDOG_TICK = "volume-backup-watchdog";
const WATCHDOG_EVERY_MS = 3_600_000; // hourly

type VolJob = { name: string; data: { appId?: string; volumeName?: string; policyId?: string } };

/** Mirrors BackupSchedulerService: BullMQ repeatable jobs, disabled in tests. */
@Injectable()
export class VolumeBackupSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VolumeBackupSchedulerService.name);
  private queue?: Queue;

  constructor(
    private readonly hub: QueueHubService,
    private readonly ticks: TickSchedulerService,
    private readonly prisma: PrismaService,
    private readonly runner: VolumeBackupRunnerService,
    private readonly alerts: BackupAlertsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    this.queue = this.hub.queue(QUEUE);
    this.hub.worker(QUEUE, (job) => this.handleJob(job as VolJob));

    // Missing-backup watchdog (see BackupSchedulerService): idempotent re-register of the hourly check.
    await this.ticks.register({ name: WATCHDOG_TICK, every: WATCHDOG_EVERY_MS, run: () => this.alerts.checkApps() });

    await this.enrolApps();
  }

  /** Boot enrolment: every enabled app with a cron or interval, plus its per-volume policy jobs. */
  async enrolApps(): Promise<void> {
    const apps = await this.prisma.application.findMany({
      where: { volumeBackupEnabled: true, OR: [{ volumeBackupIntervalHours: { not: null } }, { volumeBackupCron: { not: null } }] },
    });
    let ok = 0;
    for (const a of apps) {
      // Own try/catch per app: a bad stored cron must not crash the hub at boot (BullMQ throws inside queue.add).
      try {
        // A cron expression wins over the plain interval.
        if (a.volumeBackupCron) await this.scheduleCron(a.id, a.volumeBackupCron);
        else await this.schedule(a.id, (a.volumeBackupIntervalHours ?? 24) * 3600);
        ok++;
      } catch (e) {
        this.logger.warn(`skipped volume backup schedule for app ${a.id} (bad cron "${a.volumeBackupCron}"): ${e instanceof Error ? e.message : e}`);
      }
      try {
        await this.syncPolicyJobs(a.id);
      } catch (e) {
        this.logger.warn(`skipped volume policy jobs for app ${a.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.logger.log(`scheduled ${ok}/${apps.length} volume backup(s)`);
  }

  /** Worker dispatcher: the watchdog, a per-volume policy job (`volpol:`), or the app-wide job (`volbackup:`). */
  async handleJob(job: VolJob): Promise<void> {
    if (job.name === WATCHDOG_JOB) {
      await this.alerts.checkApps();
      return;
    }
    if (job.name.startsWith("volpol:")) {
      const policyId = job.data.policyId as string;
      const appId = job.data.appId as string;
      const volumeName = job.data.volumeName as string;
      // Orphan self-heal: the policy (or its app) was deleted → stop this repeatable instead of failing every tick.
      const stillExists = async () => {
        const p = await this.prisma.volumeBackupPolicy.findUnique({ where: { id: policyId }, select: { id: true } });
        if (!p) return false;
        return Boolean(await this.prisma.application.findUnique({ where: { id: appId }, select: { id: true } }));
      };
      if (!(await reapIfGone(policyId, stillExists, (i) => this.unschedulePolicy(i)))) return;
      await this.runner.runBackup(appId, "scheduler", { only: [volumeName] });
      return;
    }
    const appId = job.data.appId as string;
    // Orphan self-heal: the app was deleted → stop this repeatable instead of failing every tick.
    if (!(await reapIfGone(appId, () => this.prisma.application.findUnique({ where: { id: appId }, select: { id: true } }).then(Boolean), (i) => this.unschedule(i)))) return;
    // The app-wide job skips volumes carved out by a per-volume policy (disabled, or on their own schedule).
    await this.runner.runBackup(appId, "scheduler", { excludePolicied: true });
  }

  async schedule(appId: string, intervalSec: number): Promise<void> {
    if (!this.queue) return;
    await this.unschedule(appId);
    await this.queue.add(`volbackup:${appId}`, { appId }, { repeat: { every: intervalSec * 1000 } });
  }

  /** Schedule the app-wide job on a 5-field cron (wins over the interval). */
  async scheduleCron(appId: string, cron: string): Promise<void> {
    if (!this.queue) return;
    await this.unschedule(appId);
    await this.queue.add(`volbackup:${appId}`, { appId }, { repeat: { pattern: cron } });
  }

  async unschedule(appId: string): Promise<void> {
    if (!this.queue) return;
    const reps = await this.queue.getRepeatableJobs();
    for (const r of reps) {
      if (r.name === `volbackup:${appId}`) await this.queue.removeRepeatableByKey(r.key);
    }
  }

  /** (Re)schedule one per-volume policy job: its own cron, else its own interval. */
  async schedulePolicy(p: { id: string; appId: string; volumeName: string; cron: string | null; intervalHours: number | null }): Promise<void> {
    if (!this.queue) return;
    await this.unschedulePolicy(p.id);
    const repeat = p.cron ? { pattern: p.cron } : { every: (p.intervalHours ?? 24) * 3_600_000 };
    await this.queue.add(`volpol:${p.id}`, { appId: p.appId, volumeName: p.volumeName, policyId: p.id }, { repeat });
  }

  async unschedulePolicy(policyId: string): Promise<void> {
    if (!this.queue) return;
    const reps = await this.queue.getRepeatableJobs();
    for (const r of reps) {
      if (r.name === `volpol:${policyId}`) await this.queue.removeRepeatableByKey(r.key);
    }
  }

  /** Make the per-volume jobs of one app match its policies: a job exists iff the app's volume backups are on and
   *  the policy is enabled with its own schedule; every other policy's job (if any) is removed. */
  async syncPolicyJobs(appId: string): Promise<void> {
    if (!this.queue) return;
    const app = await this.prisma.application.findUnique({ where: { id: appId }, select: { volumeBackupEnabled: true } });
    const policies = await this.prisma.volumeBackupPolicy.findMany({ where: { appId } });
    for (const p of policies) {
      if (app && policyJobExists(app.volumeBackupEnabled, p)) await this.schedulePolicy(p);
      else await this.unschedulePolicy(p.id);
    }
  }
}
