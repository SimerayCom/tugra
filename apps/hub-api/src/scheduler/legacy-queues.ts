import type { QueueHubService } from "./queue-hub.service";
import type { TickSchedulerService } from "./tick-scheduler.service";

/** Queues the previous hub versions created for one global periodic tick each. Everything they held is obsolete once the
 *  tick lives on the shared "scheduler" queue, so the whole queue is removed (repeat key, pending delayed job, history). */
export const RETIRED_QUEUES = [
  "metrics-rollup",
  "retention-prune",
  "image-update-check",
  "notify-digest",
  "catalog-sync",
  "telemetry",
  "expiry",
  "update-check",
  "deploy-queue-sweep",
  "compose-restart-heal",
  "container-health",
  "swarm-status",
  "wal-ship",
  "hub-deadman",
  "hub-backup-drill",
  "hub-backup",
  "rollout-tick",
  "server-reboot",
] as const;

/** Queues that stay (they carry per-entity schedules) but lost one global tick to the shared scheduler: the old repeat
 *  key of that tick is removed, together with the delayed job it had pending. */
export const MOVED_REPEATABLES: Record<string, string[]> = {
  cleanup: ["cleanup-threshold-sweep"],
  backups: ["watchdog"],
  "volume-backups": ["watchdog"],
};

/** One-off jobs of a retired queue that must survive the move: `queue -> job name` (re-added to the shared scheduler). */
const CARRY_OVER: Record<string, string[]> = { "server-reboot": ["reboot-due"] };

export interface LegacyCleanupResult {
  retiredQueues: string[];
  removedRepeatables: number;
  movedJobs: number;
}

/**
 * Idempotent boot cleanup of the pre-consolidation queues. Existence is checked with plain EXISTS calls on the shared
 * connection, so on an install that has already been cleaned this costs one pipeline of ~20 commands and opens no queue.
 */
export async function retireLegacyQueues(hub: QueueHubService, scheduler: TickSchedulerService): Promise<LegacyCleanupResult> {
  const conn = hub.connection();
  const names = [...RETIRED_QUEUES, ...Object.keys(MOVED_REPEATABLES)];
  const pipe = conn.pipeline();
  for (const n of names) pipe.exists(`bull:${n}:meta`, `bull:${n}:repeat`, `bull:${n}:delayed`, `bull:${n}:wait`);
  const res = (await pipe.exec()) ?? [];
  const present = new Set(names.filter((_, i) => Number(res[i]?.[1] ?? 0) > 0));

  const out: LegacyCleanupResult = { retiredQueues: [], removedRepeatables: 0, movedJobs: 0 };
  for (const name of RETIRED_QUEUES) {
    if (!present.has(name)) continue;
    const q = hub.queue(name);
    try {
      for (const jobName of CARRY_OVER[name] ?? []) {
        for (const job of await q.getJobs(["delayed", "wait", "prioritized", "paused"])) {
          if (job.name !== jobName || !job.id) continue;
          const at = new Date(job.timestamp + (job.opts.delay ?? 0));
          await scheduler.enqueueAt(jobName, job.data as object, String(job.id), at);
          out.movedJobs++;
        }
      }
      // Counts the repeat keys before they go, so the report shows what the old version had registered.
      out.removedRepeatables += (await q.getRepeatableJobs().catch(() => [])).length;
      await q.obliterate({ force: true });
      out.retiredQueues.push(name);
    } finally {
      await hub.release(q);
    }
  }
  for (const [name, jobNames] of Object.entries(MOVED_REPEATABLES)) {
    if (!present.has(name)) continue;
    const q = hub.queue(name);
    try {
      for (const r of await q.getRepeatableJobs()) {
        if (!jobNames.includes(r.name)) continue;
        await q.removeRepeatableByKey(r.key);
        out.removedRepeatables++;
      }
    } finally {
      await hub.release(q);
    }
  }
  return out;
}
