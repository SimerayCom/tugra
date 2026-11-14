import type { Rollout, RolloutStatus, RolloutTargetStatus } from "./types";

/** Pure helpers for the rollouts pages (tested in rollouts.test.ts). */

export const ROLLOUT_TERMINAL: ReadonlySet<RolloutStatus> = new Set(["COMPLETED", "ROLLED_BACK", "ROLLBACK_FAILED", "CANCELLED"]);

export function isRolloutActive(status: RolloutStatus): boolean {
  return !ROLLOUT_TERMINAL.has(status);
}

export function rolloutStatusColor(status: RolloutStatus): string {
  switch (status) {
    case "RUNNING":
    case "ROLLING_BACK":
      return "var(--c-a)";
    case "HALTED":
    case "ROLLBACK_FAILED":
      return "var(--c-am)";
    case "COMPLETED":
      return "var(--c-g)";
    case "ROLLED_BACK":
    case "CANCELLED":
      return "var(--c-tx3)";
  }
}

export function targetStatusColor(status: RolloutTargetStatus): string {
  switch (status) {
    case "DEPLOYING":
    case "REVERTING":
      return "var(--c-a)";
    case "SUCCEEDED":
    case "ROLLED_BACK":
      return "var(--c-g)";
    case "FAILED":
    case "ROLLBACK_FAILED":
      return "var(--c-r)";
    case "CANCELLED":
    case "SKIPPED":
    case "PENDING":
      return "var(--c-tx3)";
  }
}

export const canHalt = (s: RolloutStatus) => s === "RUNNING";
export const canResume = (s: RolloutStatus) => s === "HALTED";
export const canCancel = (s: RolloutStatus) => s === "RUNNING" || s === "HALTED";
/** Fleet rollback is offered once the rollout is at rest (halted or done) and no deploy of it is still in flight. */
export const canRollback = (r: Pick<Rollout, "status" | "summary" | "targets">) =>
  (r.status === "HALTED" || r.status === "COMPLETED") && r.summary.deploying === 0 && r.targets.some((t) => t.status === "SUCCEEDED" || (t.status === "FAILED" && t.outcome === "failed"));

/** Percent of targets that reached a terminal status (SUCCEEDED/FAILED/SKIPPED/CANCELLED), for the progress bar. */
export function rolloutProgressPct(r: Pick<Rollout, "summary">): number {
  const { total, succeeded, failed, skipped, cancelled } = r.summary;
  if (total === 0) return 0;
  return Math.round(((succeeded + failed + skipped + cancelled) / total) * 100);
}

/** Group a rollout's targets by wave (index = wave), always `waveCount` long. */
export function targetsByWave<T extends { wave: number }>(targets: T[], waveCount: number): T[][] {
  const out: T[][] = Array.from({ length: Math.max(waveCount, 0) }, () => []);
  for (const t of targets) {
    if (t.wave >= 0 && t.wave < out.length) out[t.wave].push(t);
  }
  return out;
}

/** Parse the "25, 50, 100" steps field; null when invalid (non-increasing, out of range, or not ending at 100). */
export function parseSteps(text: string): number[] | null {
  const parts = text
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 9) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 100)) return null;
  if (nums.some((n, i) => i > 0 && n <= nums[i - 1])) return null;
  if (nums[nums.length - 1] !== 100) return null;
  return nums;
}

/** Poll interval for a rollout query: live while active, off once terminal. */
export function rolloutRefetchInterval(r: Pick<Rollout, "status"> | undefined): number | false {
  if (!r) return 3000;
  return isRolloutActive(r.status) ? 3000 : false;
}
