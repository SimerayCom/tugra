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
  /** Fleet rollback: dispatch attempts so far (0 = not yet dispatched), when the first dispatch was tried (the
   *  "busy since" clock for an app that keeps another deploy running), and the ROLLBACK deployment's facts. */
  rollbackAttempt: number;
  rollbackDispatchedAt: Date | null;
  rollbackDeploymentId: string | null;
  rollbackDeployment: DeploymentFacts | null;
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
  | { type: "settle"; targetId: string; status: "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED" | "ROLLED_BACK" | "ROLLBACK_FAILED"; outcome: string; detail?: string }
  | { type: "enqueue"; targetId: string }
  /** Fleet rollback: dispatch the detached per-app rollback of this REVERTING target to its baseline. */
  | { type: "revert"; targetId: string }
  /** Fleet rollback finished: every REVERTING target settled. */
  | { type: "finish_rollback"; status: "ROLLED_BACK" | "ROLLBACK_FAILED"; reverted: number; failed: number }
  /** The dispatched deploy sat QUEUED past the dispatch timeout: cancel it if it has STILL not started; only then
   *  settle the target (a deploy that started meanwhile keeps running and is judged later). */
  | { type: "queue_timeout"; targetId: string; deploymentId: string | null }
  | { type: "halt"; reason: HaltReason; detail?: Record<string, unknown> }
  | { type: "start_bake"; until: Date }
  | { type: "advance_wave" }
  | { type: "complete" };

/** Judge every DEPLOYING target's deploy row and emit its settle; returns the ids whose deploy was interrupted. */
function settleDeploying(
  targets: ReadonlyArray<TargetSnap>,
  effective: Map<string, TargetStatus>,
  actions: Action[],
  ctx: { now: number; bootAt: number; dispatchTimeoutMs: number },
): string[] {
  const interrupted: string[] = [];
  for (const t of targets) {
    if (t.status !== "DEPLOYING") continue;
    if (!t.deployment) {
      actions.push({ type: "settle", targetId: t.id, status: "FAILED", outcome: "deployment_gone" });
      effective.set(t.id, "FAILED");
      continue;
    }
    const v = classifyDeployment(t.deployment, ctx);
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

  return interrupted;
}

/** Statuses that count as "this wave did not get that app onto the new version". */
const FAILURE_STATUSES: ReadonlySet<TargetStatus> = new Set(["FAILED", "CANCELLED"]);

/** Decide the next actions for one rollout. Settles are emitted first; at most one of halt / start_bake /
 *  advance_wave / complete follows, and never together with an enqueue. In HALTED and CANCELLED only settles
 *  are emitted (late results are recorded, nothing new is dispatched). */
export function decide(r: RolloutSnap, targets: ReadonlyArray<TargetSnap>, now: number, bootAt: number): Action[] {
  if (r.status === "ROLLING_BACK") return decideRollback(r, targets, now, bootAt);
  if (r.status !== "RUNNING" && r.status !== "HALTED" && r.status !== "CANCELLED") return [];
  const actions: Action[] = [];
  const dispatchTimeoutMs = r.config.dispatchTimeoutSec * 1000;
  // In-memory view of the statuses AFTER this tick's settles, so the wave verdict below is consistent.
  const effective = new Map<string, TargetStatus>(targets.map((t) => [t.id, t.status]));

  const interrupted = settleDeploying(targets, effective, actions, { now, bootAt, dispatchTimeoutMs });

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

/**
 * Fleet rollback (status ROLLING_BACK). Every REVERTING target is reverted to its baseline through the per-app
 * rollback pipeline: not yet dispatched (rollbackAttempt 0, or a dispatch that left no row) → `revert`, bounded
 * by `concurrency`; dispatched → judged by its ROLLBACK deployment row (SUCCESS → ROLLED_BACK, anything terminal
 * else → ROLLBACK_FAILED; an orphaned RUNNING row from a previous hub process is a failure too — a half-run
 * rollback is never retried blindly). A target that could not even be dispatched before `dispatchTimeoutSec`
 * (its app kept a RUNNING deploy) fails with `busy_timeout`. Once nothing is REVERTING the rollout finishes:
 * ROLLED_BACK when every revert passed, ROLLBACK_FAILED otherwise.
 */
function decideRollback(r: RolloutSnap, targets: ReadonlyArray<TargetSnap>, now: number, bootAt: number): Action[] {
  const actions: Action[] = [];
  const effective = new Map<string, TargetStatus>(targets.map((t) => [t.id, t.status]));
  // A deploy of the original rollout that was still running when the rollback was requested (it cannot be —
  // the service refuses then — but a late row is still recorded, never left DEPLOYING forever).
  settleDeploying(targets, effective, actions, { now, bootAt, dispatchTimeoutMs: r.config.dispatchTimeoutSec * 1000 });
  const reverting = targets.filter((t) => t.status === "REVERTING");
  let inflight = 0;
  const waiting: TargetSnap[] = [];
  for (const t of reverting) {
    if (!t.rollbackDeployment) {
      waiting.push(t);
      continue;
    }
    const v = classifyDeployment(t.rollbackDeployment, { now, bootAt, dispatchTimeoutMs: Number.MAX_SAFE_INTEGER });
    if (v === "running") {
      inflight++;
      continue;
    }
    if (v === "passed") {
      actions.push({ type: "settle", targetId: t.id, status: "ROLLED_BACK", outcome: "reverted" });
      effective.set(t.id, "ROLLED_BACK");
    } else {
      const detail = v === "interrupted" ? INTERRUPTED_DEPLOY_NOTE : t.rollbackDeployment.exitCode != null ? `exit ${t.rollbackDeployment.exitCode}` : undefined;
      actions.push({ type: "settle", targetId: t.id, status: "ROLLBACK_FAILED", outcome: `revert_${v}`, detail });
      effective.set(t.id, "ROLLBACK_FAILED");
    }
  }
  // Dispatch the waiting ones. Two bounded waits, each judged by its own clock and never by mere queueing behind
  // the concurrency throttle: an app that keeps ANOTHER deploy running is retried from its first refusal
  // (rollbackDispatchedAt) for dispatchTimeoutSec → busy_timeout; an offline agent is waited for waitOnlineSec
  // from the rollback request → offline.
  const busyMs = r.config.dispatchTimeoutSec * 1000;
  const offlineDeadline = r.waveStartedAt.getTime() + r.config.waitOnlineSec * 1000;
  for (const t of waiting) {
    if (t.appStatus == null) {
      actions.push({ type: "settle", targetId: t.id, status: "ROLLBACK_FAILED", outcome: "app_gone" });
      effective.set(t.id, "ROLLBACK_FAILED");
      continue;
    }
    if (t.rollbackDispatchedAt && now > t.rollbackDispatchedAt.getTime() + busyMs) {
      actions.push({ type: "settle", targetId: t.id, status: "ROLLBACK_FAILED", outcome: "busy_timeout", detail: "the app kept another deploy running until the rollback window closed" });
      effective.set(t.id, "ROLLBACK_FAILED");
      continue;
    }
    if (!t.online) {
      if (now > offlineDeadline) {
        actions.push({ type: "settle", targetId: t.id, status: "ROLLBACK_FAILED", outcome: "offline", detail: "the server's agent stayed offline" });
        effective.set(t.id, "ROLLBACK_FAILED");
      }
      continue; // wait for the agent
    }
    if (inflight >= r.config.concurrency) continue;
    actions.push({ type: "revert", targetId: t.id });
    inflight++;
  }
  const open = targets.some((t) => effective.get(t.id) === "REVERTING");
  if (open) return actions;
  const reverted = targets.filter((t) => effective.get(t.id) === "ROLLED_BACK").length;
  const failed = targets.filter((t) => effective.get(t.id) === "ROLLBACK_FAILED").length;
  actions.push({ type: "finish_rollback", status: failed > 0 ? "ROLLBACK_FAILED" : "ROLLED_BACK", reverted, failed });
  return actions;
}

/** Which targets a fleet rollback reverts: the ones this rollout moved onto the new version (SUCCEEDED) or left
 *  on a failed deploy of it (FAILED/failed — the app may be down). Not: rejected_safe (the previous version is
 *  already live), interrupted (unknown state — the operator looks first), skipped/cancelled/pending (never
 *  touched). Returns the target ids to flip to REVERTING and the ones that cannot be reverted (no baseline). */
export function rollbackTargets(targets: ReadonlyArray<{ id: string; status: TargetStatus; outcome: string | null; baselineDeploymentId: string | null }>): {
  revert: string[];
  noBaseline: string[];
} {
  const revert: string[] = [];
  const noBaseline: string[] = [];
  for (const t of targets) {
    const moved = t.status === "SUCCEEDED" || (t.status === "FAILED" && t.outcome === "failed");
    if (!moved) continue;
    (t.baselineDeploymentId ? revert : noBaseline).push(t.id);
  }
  return { revert, noBaseline };
}

export function rolloutKey(rolloutId: string, appId: string, attempt: number): string {
  return `rollout:${rolloutId}:${appId}:${attempt}`;
}

export function rollbackKey(rolloutId: string, appId: string, attempt: number): string {
  return `rollout:rb:${rolloutId}:${appId}:${attempt}`;
}

/** The reserved idempotency-key prefix: a user-supplied Idempotency-Key may never start with it (it would let a
 *  client pre-create the row a rollout dispatch dedupes against and have the rollout judge a foreign deploy). */
export const ROLLOUT_KEY_PREFIX = "rollout:";
