/**
 * Pure planning for fleet rollouts: the config shape, the wave sizing and the per-app preflight. No I/O —
 * everything here is table-tested without a database.
 */
import { z } from "zod";

export const ROLLOUT_MAX_TARGETS = 200;
export const ROLLOUT_MAX_WAVES = 10;

/** Frozen onto Rollout.config at create. Steps are cumulative percentages of the target set; the final step is
 *  always 100 so the last wave covers everything. `dispatchTimeoutSec` is clamped under the 6h stale-QUEUED
 *  sweep so a queued deploy is judged by the rollout before the sweep cancels it. */
export const RolloutConfigSchema = z.object({
  canary: z.number().int().min(0).max(10).default(1),
  steps: z
    .array(z.number().int().min(1).max(100))
    .min(1)
    .max(ROLLOUT_MAX_WAVES - 1)
    .default([25, 50, 100])
    .refine((s) => s.every((v, i) => i === 0 || v > s[i - 1]), { message: "steps must be strictly increasing" })
    .refine((s) => s[s.length - 1] === 100, { message: "the last step must be 100" }),
  concurrency: z.number().int().min(1).max(10).default(3),
  maxFailuresPerWave: z.number().int().min(0).max(50).default(0),
  bakeSec: z.number().int().min(0).max(3600).default(60),
  dispatchTimeoutSec: z.number().int().min(60).max(5 * 3600).default(2700),
  waitOnlineSec: z.number().int().min(0).max(3600).default(300),
  allowUngated: z.boolean().default(false),
  noCache: z.boolean().default(false),
});
export type RolloutConfig = z.infer<typeof RolloutConfigSchema>;

/** Wave sizes for `n` targets: an optional canary first, then each cumulative step (ceil), dropping empty waves;
 *  the sizes always sum to n. n=12 with the defaults → [1, 2, 3, 6]. */
export function planWaves(n: number, cfg: Pick<RolloutConfig, "canary" | "steps">): number[] {
  if (n <= 0) return [];
  const sizes: number[] = [];
  let done = 0;
  const canary = Math.min(cfg.canary, n);
  if (canary > 0 && canary < n) {
    sizes.push(canary);
    done = canary;
  }
  for (const pct of cfg.steps) {
    const cum = Math.max(done, Math.min(n, Math.ceil((n * pct) / 100)));
    if (cum > done) {
      sizes.push(cum - done);
      done = cum;
    }
  }
  if (done < n) sizes.push(n - done);
  return sizes;
}

/** Wave index per position (targets are laid out in the order given). */
export function assignWaves(sizes: ReadonlyArray<number>): number[] {
  const out: number[] = [];
  sizes.forEach((size, wave) => {
    for (let i = 0; i < size; i++) out.push(wave);
  });
  return out;
}

export interface PreflightApp {
  clusterId: string | null;
  source: string;
  rollbackOnFailure: boolean;
  healthCheckType: string | null;
  imagesToKeep: number | null;
  autoDeploy: boolean;
}

export type PreflightBlock = "swarm_unsupported" | "ungated" | "in_other_rollout";
export type PreflightWarning = "no_health_gate" | "few_images" | "auto_deploy_on";

/** An app is "gated" when a failed deploy can never take the previous version down: the classic (non-compose)
 *  pipeline with rollbackOnFailure keeps/restores the old container on a failed health gate or soak. */
export function isGatedApp(app: Pick<PreflightApp, "source" | "rollbackOnFailure">): boolean {
  return app.source !== "COMPOSE" && app.rollbackOnFailure;
}

/** Why an app cannot join a rollout, and what the operator should know if it does. */
export function preflightApp(
  app: PreflightApp,
  opts: { allowUngated: boolean; inOtherRollout: boolean },
): { blocked: PreflightBlock | null; warnings: PreflightWarning[] } {
  const warnings: PreflightWarning[] = [];
  // A swarm deploy targets the dynamically-resolved manager and its QUEUED rows are cancelled at boot — it
  // cannot be resumed across a hub restart, so it cannot be a rollout target yet.
  if (app.clusterId) return { blocked: "swarm_unsupported", warnings };
  if (opts.inOtherRollout) return { blocked: "in_other_rollout", warnings };
  if (!isGatedApp(app) && !opts.allowUngated) return { blocked: "ungated", warnings };
  if (app.healthCheckType === "NONE") warnings.push("no_health_gate");
  if (app.imagesToKeep != null && app.imagesToKeep < 2) warnings.push("few_images");
  if (app.autoDeploy) warnings.push("auto_deploy_on");
  return { blocked: null, warnings };
}
