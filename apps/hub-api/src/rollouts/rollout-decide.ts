/**
 * The rollout state machine as a PURE function: given a snapshot of one rollout (its targets, their deployments,
 * the agents' online state) and the clock, return the actions the engine must apply. No Prisma, no clock reads —
 * the engine owns I/O and applies every action as a status-guarded compare-and-set. Table-tested.
 *
 * Per-target verdicts come from the Deployment row the per-app pipeline wrote: SUCCESS = the health gate (and
 * soak, when configured) passed; FAILED+AUTO_ROLLBACK = the gate rejected the new version but the previous one
 * is still (or again) live — a wave failure that needs NO fleet revert; FAILED with the reconcile note = the hub
 * restarted mid-deploy → the result is unknown and the rollout halts for the operator.
 */
import { INTERRUPTED_DEPLOY_NOTE } from "../applications/deployment-reconcile.service";
import type { RolloutConfig } from "./rollout-plan";

export type DeployVerdict = "running" | "passed" | "rejected_safe" | "interrupted" | "failed" | "cancelled" | "queue_timeout";

export interface DeploymentFacts {
  status: "QUEUED" | "RUNNING" | "SUCCESS" | "FAILED" | "CANCELLED";
  kind: string;
  exitCode: number | null;
  logs: string | null;
  startedAt: Date | null;
  createdAt: Date;
}

export function classifyDeployment(dep: DeploymentFacts, ctx: { now: number; bootAt: number; dispatchTimeoutMs: number }): DeployVerdict {
  switch (dep.status) {
    case "SUCCESS":
      return "passed";
    case "FAILED":
      if (dep.kind === "AUTO_ROLLBACK") return "rejected_safe";
      if (dep.exitCode === -1 && (dep.logs ?? "").includes(INTERRUPTED_DEPLOY_NOTE)) return "interrupted";
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "RUNNING":
      // A RUNNING row that started before THIS hub process did is an orphan of the previous process (the boot
      // reconcile marks it FAILED moments later) — never a live deploy we could wait on.
      return dep.startedAt && dep.startedAt.getTime() < ctx.bootAt ? "interrupted" : "running";
    case "QUEUED":
      return dep.createdAt.getTime() + ctx.dispatchTimeoutMs < ctx.now ? "queue_timeout" : "running";
  }
}

export type TargetStatus = "PENDING" | "DEPLOYING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "SKIPPED" | "REVERTING" | "ROLLED_BACK" | "ROLLBACK_FAILED";
export type RolloutStatus = "RUNNING" | "HALTED" | "ROLLING_BACK" | "COMPLETED" | "ROLLED_BACK" | "ROLLBACK_FAILED" | "CANCELLED";

export interface TargetSnap {
  id: string;
  wave: number;
  status: TargetStatus;
  attempt: number;
  deploymentId: string | null;
  deployment: DeploymentFacts | null;
  /** The app's current status, or null when the app no longer exists. */
  appStatus: string | null;
  /** True when a deploy NEWER than this target's dispatched one exists for the app (bake: superseded). */
  superseded: boolean;
  online: boolean;
}

export interface RolloutSnap {
  status: RolloutStatus;
  currentWave: number;
  waveCount: number;
  waveStartedAt: Date;
  bakeUntil: Date | null;
  config: RolloutConfig;
}

export type HaltReason = "manual" | "wave_failed" | "wave_no_signal" | "bake_failed" | "interrupted" | "initiator_lost";

export type Action =
  | { type: "settle"; targetId: string; status: "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED"; outcome: string; detail?: string }
  | { type: "enqueue"; targetId: string }
  /** The dispatched deploy sat QUEUED past the dispatch timeout: cancel it if it has STILL not started; only then
   *  settle the target (a deploy that started meanwhile keeps running and is judged later). */
  | { type: "queue_timeout"; targetId: string; deploymentId: string | null }
  | { type: "halt"; reason: HaltReason; detail?: Record<string, unknown> }
  | { type: "start_bake"; until: Date }
  | { type: "advance_wave" }
  | { type: "complete" };

/** Statuses that count as "this wave did not get that app onto the new version". */
const FAILURE_STATUSES: ReadonlySet<TargetStatus> = new Set(["FAILED", "CANCELLED"]);

/** Decide the next actions for one rollout. Settles are emitted first; at most one of halt / start_bake /
 *  advance_wave / complete follows, and never together with an enqueue. In HALTED and CANCELLED only settles
 *  are emitted (late results are recorded, nothing new is dispatched). */
export function decide(r: RolloutSnap, targets: ReadonlyArray<TargetSnap>, now: number, bootAt: number): Action[] {
  if (r.status !== "RUNNING" && r.status !== "HALTED" && r.status !== "CANCELLED") return [];
  const actions: Action[] = [];
  const dispatchTimeoutMs = r.config.dispatchTimeoutSec * 1000;
  // In-memory view of the statuses AFTER this tick's settles, so the wave verdict below is consistent.
  const effective = new Map<string, TargetStatus>(targets.map((t) => [t.id, t.status]));
  const interrupted: string[] = [];

  for (const t of targets) {
    if (t.status !== "DEPLOYING") continue;
    if (!t.deployment) {
      actions.push({ type: "settle", targetId: t.id, status: "FAILED", outcome: "deployment_gone" });
      effective.set(t.id, "FAILED");
      continue;
    }
    const v = classifyDeployment(t.deployment, { now, bootAt, dispatchTimeoutMs });
    switch (v) {
      case "running":
        break;
      case "passed":
        actions.push({ type: "settle", targetId: t.id, status: "SUCCEEDED", outcome: "passed" });
        effective.set(t.id, "SUCCEEDED");
        break;
      case "rejected_safe":
        actions.push({ type: "settle", targetId: t.id, status: "FAILED", outcome: "rejected_safe", detail: "health gate rejected the new version; the previous version is still live" });
        effective.set(t.id, "FAILED");
        break;
      case "failed":
        actions.push({ type: "settle", targetId: t.id, status: "FAILED", outcome: "failed", detail: t.deployment.exitCode != null ? `exit ${t.deployment.exitCode}` : undefined });
        effective.set(t.id, "FAILED");
        break;
      case "cancelled":
        actions.push({ type: "settle", targetId: t.id, status: "FAILED", outcome: "cancelled" });
        effective.set(t.id, "FAILED");
        break;
      case "interrupted":
        actions.push({ type: "settle", targetId: t.id, status: "FAILED", outcome: "interrupted", detail: INTERRUPTED_DEPLOY_NOTE });
        effective.set(t.id, "FAILED");
        interrupted.push(t.id);
        break;
      case "queue_timeout":
        // Conditional: the engine settles only if the cancel lands (the row was still QUEUED). Assume it does
        // for this tick's verdict; a deploy that started meanwhile stays DEPLOYING next tick.
        actions.push({ type: "queue_timeout", targetId: t.id, deploymentId: t.deploymentId });
        effective.set(t.id, "FAILED");
        break;
    }
  }

  if (r.status !== "RUNNING") return actions;

  // An interrupted deploy is NOT a health verdict: the agent script may still be running. Halt for the operator
  // instead of redeploying over it; nothing else is dispatched this tick.
  if (interrupted.length) {
    actions.push({ type: "halt", reason: "interrupted", detail: { targets: interrupted } });
    return actions;
  }

  const wave = targets.filter((t) => t.wave === r.currentWave);
  const passed = wave.filter((t) => effective.get(t.id) === "SUCCEEDED");
  const failed = wave.filter((t) => FAILURE_STATUSES.has(effective.get(t.id)!));

  // FAIL FAST: once the wave's failures exceed the tolerance, stop spreading the release — halt NOW (halt cancels
  // the still-queued deploys; running ones finish and are settled while HALTED). Never enqueue past this point.
  if (failed.length > r.config.maxFailuresPerWave) {
    actions.push({ type: "halt", reason: "wave_failed", detail: { wave: r.currentWave, failed: failed.map((t) => t.id), passed: passed.length } });
    return actions;
  }

  let deploying = wave.filter((t) => effective.get(t.id) === "DEPLOYING").length;
  const waitOnlineMs = r.config.waitOnlineSec * 1000;
  for (const t of wave) {
    if (effective.get(t.id) !== "PENDING") continue;
    if (t.appStatus == null) {
      actions.push({ type: "settle", targetId: t.id, status: "SKIPPED", outcome: "app_gone" });
      effective.set(t.id, "SKIPPED");
      continue;
    }
    if (!t.online) {
      if (r.waveStartedAt.getTime() + waitOnlineMs < now) {
        actions.push({ type: "settle", targetId: t.id, status: "SKIPPED", outcome: "offline", detail: "the server's agent stayed offline" });
        effective.set(t.id, "SKIPPED");
      }
      continue; // wait for the agent (bounded by waitOnlineSec)
    }
    if (deploying >= r.config.concurrency) continue;
    actions.push({ type: "enqueue", targetId: t.id });
    effective.set(t.id, "DEPLOYING");
    deploying++;
  }

  const open = wave.some((t) => effective.get(t.id) === "PENDING" || effective.get(t.id) === "DEPLOYING");
  if (open) return actions;

  // A wave that produced no positive signal (everything skipped/failed within tolerance) never advances silently.
  if (passed.length === 0) {
    actions.push({ type: "halt", reason: "wave_no_signal", detail: { wave: r.currentWave } });
    return actions;
  }

  // Bake: keep observing the wave's apps for bakeSec after they passed. A failed, stopped or superseded app
  // (an interleaved deploy replaced ours) fails the bake; an offline server makes it unobservable.
  if (r.config.bakeSec > 0) {
    if (!r.bakeUntil) {
      actions.push({ type: "start_bake", until: new Date(now + r.config.bakeSec * 1000) });
      return actions;
    }
    const bad = passed.find((t) => t.appStatus !== "RUNNING" || !t.online || t.superseded);
    if (bad) {
      const why = bad.appStatus !== "RUNNING" ? `app is ${bad.appStatus}` : !bad.online ? "server offline during bake" : "superseded by a newer deploy";
      actions.push({ type: "halt", reason: "bake_failed", detail: { wave: r.currentWave, target: bad.id, why } });
      return actions;
    }
    if (now < r.bakeUntil.getTime()) return actions;
  }

  actions.push(r.currentWave + 1 < r.waveCount ? { type: "advance_wave" } : { type: "complete" });
  return actions;
}

export function rolloutKey(rolloutId: string, appId: string, attempt: number): string {
  return `rollout:${rolloutId}:${appId}:${attempt}`;
}

/** The reserved idempotency-key prefix: a user-supplied Idempotency-Key may never start with it (it would let a
 *  client pre-create the row a rollout dispatch dedupes against and have the rollout judge a foreign deploy). */
export const ROLLOUT_KEY_PREFIX = "rollout:";
