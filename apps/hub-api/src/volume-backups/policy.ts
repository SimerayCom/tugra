import type { VolumeBackupPolicy } from "@prisma/client";

/** Minimal policy shape the scheduling rules need (a Prisma row satisfies it). */
export type PolicyLike = Pick<VolumeBackupPolicy, "enabled" | "cron" | "intervalHours">;

/** A policy with its own cron or interval runs on its own job (not the app-wide one). */
export function hasOwnSchedule(p: Pick<PolicyLike, "cron" | "intervalHours">): boolean {
  return !!(p.cron || p.intervalHours);
}

/** A volume is carved OUT of the app-wide job when its policy disables it or gives it its own schedule. */
export function isCarvedOut(p: PolicyLike): boolean {
  return !p.enabled || hasOwnSchedule(p);
}

/** A dedicated per-volume job exists only while the app's volume backups are on and the policy is enabled+scheduled. */
export function policyJobExists(appEnabled: boolean, p: PolicyLike): boolean {
  return appEnabled && p.enabled && hasOwnSchedule(p);
}

/** Composite alert/watch id for a per-volume policy run (Redis key segment; ids are plain strings). */
export function policyAlertId(appId: string, volumeName: string): string {
  return `${appId}:${volumeName}`;
}

/** The shared size pool's internal key. It starts with a NUL, which a volume name can never contain
 *  (names match /^[a-z0-9][a-z0-9_-]*$/), so a volume literally called "app" cannot collide with it. */
export const SHARED_POOL = "\u0000app";

/** Which size pool a volume's backups count against: its own (keyed by its name) when its policy sets
 *  `maxSizeGb`, else the app-wide shared pool. Prune and the usage view both group through this. */
export function poolKeyOf(policies: Map<string, { maxSizeGb: number | null }>, volumeName: string): string {
  return policies.get(volumeName)?.maxSizeGb != null ? volumeName : SHARED_POOL;
}

/** The size budget (GiB, null = unlimited) of a pool produced by {@link poolKeyOf}. */
export function poolBudgetGb(
  pool: string,
  appMaxSizeGb: number | null,
  policies: Map<string, { maxSizeGb: number | null }>,
): number | null {
  return pool === SHARED_POOL ? appMaxSizeGb : policies.get(pool)?.maxSizeGb ?? null;
}
