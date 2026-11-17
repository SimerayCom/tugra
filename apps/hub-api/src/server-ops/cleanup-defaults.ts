import { ServerStatus } from "@prisma/client";

/** Daily at 03:00 — the default cleanup schedule for every server. */
export const DEFAULT_CLEANUP_CRON = "0 3 * * *";
/** Disk usage % at which a cleanup also runs on top of the schedule (Coolify parity: 80%). */
export const DEFAULT_CLEANUP_THRESHOLD_PCT = 80;

/**
 * Cleanup defaults written on EVERY server create path (enrol token, SSH/cloud provision, bulk create, the
 * local server at install) and by the "never configured" backfill migration. The prune itself stays scoped
 * and rollback-safe (see cleanup-script.ts), so on-by-default is safe; an operator can retune or turn it off.
 */
export const DEFAULT_CLEANUP_DATA = {
  cleanupEnabled: true,
  cleanupCron: DEFAULT_CLEANUP_CRON,
  cleanupThresholdPct: DEFAULT_CLEANUP_THRESHOLD_PCT,
} as const;

/** A threshold-triggered run happens at most once per hour per server. */
export const THRESHOLD_COOLDOWN_SEC = 3600;
/** After a threshold run that freed nothing (disk full of non-Docker data), wait this long before the next one. */
export const THRESHOLD_BACKOFF_SEC = 6 * 3600;
/** A disk sample older than this is not evidence of the CURRENT usage (agent offline / metrics stalled). */
export const THRESHOLD_SAMPLE_MAX_AGE_MS = 10 * 60 * 1000;

export interface ThresholdInput {
  enabled: boolean;
  status: ServerStatus | string;
  thresholdPct: number | null;
  /** Latest reported host disk sample, or null when the hub has none. */
  sample: { ts: Date; diskUsed: bigint; diskTotal: bigint } | null;
  now: Date;
}

/** Disk usage % of a sample, or null when the total is unknown/zero. */
export function diskUsagePct(s: { diskUsed: bigint; diskTotal: bigint }): number | null {
  if (s.diskTotal <= 0n) return null;
  return (Number(s.diskUsed) / Number(s.diskTotal)) * 100;
}

/**
 * Pure decision: should the disk-threshold trigger fire for this server now? Only an enabled, ONLINE server
 * with a threshold and a FRESH sample at/above that threshold qualifies. The once-an-hour throttle is applied
 * separately (CleanupSchedulerService) so this stays a pure function of its inputs.
 */
export function shouldTriggerThresholdCleanup(i: ThresholdInput): boolean {
  if (!i.enabled || i.status !== ServerStatus.ONLINE || i.thresholdPct == null || !i.sample) return false;
  if (i.now.getTime() - i.sample.ts.getTime() > THRESHOLD_SAMPLE_MAX_AGE_MS) return false;
  const pct = diskUsagePct(i.sample);
  return pct != null && pct >= i.thresholdPct;
}

/** The repeatable schedule for a server row: a cron wins over an interval; enabled with neither gets the default cron. */
export function planCleanupSchedule(s: {
  cleanupCron: string | null;
  cleanupIntervalHours: number | null;
  timezone: string | null;
}): { kind: "cron"; cron: string; tz?: string } | { kind: "interval"; intervalSec: number } {
  if (s.cleanupCron) return { kind: "cron", cron: s.cleanupCron, ...(s.timezone ? { tz: s.timezone } : {}) };
  if (s.cleanupIntervalHours) return { kind: "interval", intervalSec: s.cleanupIntervalHours * 3600 };
  return { kind: "cron", cron: DEFAULT_CLEANUP_CRON, ...(s.timezone ? { tz: s.timezone } : {}) };
}

/** True when a completed (not skipped, not failed) cleanup run freed nothing: no reclaimed figure or 0B. */
export function reclaimedNothing(r: { ok: boolean; reclaimed: string; output: string }): boolean {
  if (!r.ok || r.output.startsWith("skipped:")) return false;
  return r.reclaimed === "" || /^0(\.0+)?\s*B$/i.test(r.reclaimed);
}
