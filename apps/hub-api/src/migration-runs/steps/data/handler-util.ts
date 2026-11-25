/**
 * Small helpers shared by the four data handlers: snapshot loading with fixed-code failures, the attached object
 * migrations, and the compensation keys the steps write (ids and flags only; never a secret).
 */
import type { GateCheck, GateResult, WaitSpec } from "../../core/dto";
import { StepFailure, type StepContext, type StepKey } from "../../core/run-contract";
import { agentRunnerHost } from "./data-logic";
import { DATA_CODES, DataPortError, type CapabilityPort, type DataPort, type DataSnapshot, type ObjectPort, type ObjectView } from "./data-contract";

/** The snapshot of the run's op, mapping a port failure to a deterministic step failure. */
export async function loadSnapshot(data: DataPort, ctx: StepContext): Promise<DataSnapshot> {
  if (!ctx.run.opId) throw new StepFailure(DATA_CODES.opMissing, undefined, false);
  try {
    return await data.snapshot(ctx.run);
  } catch (e) {
    if (e instanceof DataPortError) throw new StepFailure(DATA_CODES.opMissing, { reason: e.code }, false);
    throw e;
  }
}

/** The object migrations the operator attached (to DATA_SEED, where the design says they attach, or to the step itself). */
export function attachedObjectIds(ctx: StepContext): string[] {
  const ids = new Set<string>();
  for (const key of ["DATA_SEED", ctx.step.key] as StepKey[]) {
    for (const a of ctx.stepState(key).evidence.attachments) if (a.kind === "object-migration") ids.add(a.resourceId);
  }
  return [...ids].sort();
}

export async function loadObjects(objects: ObjectPort, ctx: StepContext): Promise<{ views: ObjectView[]; missing: string[] }> {
  const views: ObjectView[] = [];
  const missing: string[] = [];
  for (const id of attachedObjectIds(ctx)) {
    const v = await objects.get(ctx.actor.userId, id);
    if (v) views.push(v);
    else missing.push(id);
  }
  return { views, missing };
}

/** A gate result from checks (`unknown` fails: every data step gates data movement). */
export function gateFrom(checks: readonly GateCheck[], wait?: WaitSpec): GateResult {
  const passed = checks.every((c) => c.acked === true || c.status === "pass" || c.status === "warn");
  return { passed, checks: [...checks], ...(wait && !passed ? { wait } : {}) };
}

// ───────────────────────────── compensation keys ─────────────────────────────

export interface LaunchRecord {
  /** Monotonic per step: the launcher directory is `<runId>-<tag>-<seq>`. */
  seq: number;
  phase: "inspect" | "warm-db" | "final";
  at: string;
  /** The step that launched (part of the directory name, so two steps never share a run directory). Absent on a pre-tag record. */
  tag?: "seed" | "final";
}

export interface StepComp {
  launchSeq?: number;
  /** `launchSeq` as of the last explicit retry: the per-step launch budget counts from here. */
  launchBudgetFrom?: number;
  launch?: LaunchRecord;
  /** True when THIS run added the `migrate` capability (so only it may revoke it). */
  capAdded?: boolean;
  /** DATA_FINAL: when the data was first complete while the migrator's verify report was still due (the grace window starts here). */
  dataCompleteAt?: string | null;
  /** DATA_FINAL: the step wrapped up (token revoked, capability released). */
  wrapped?: boolean;
  /** FREEZE: what was stopped (see FreezeRecord). */
  freeze?: unknown;
  stopRequestedAt?: string;
  /** Object migrations started by this step, per migration id (a failing pass is not restarted forever). */
  objStarts?: Record<string, number>;
}

export const compOf = (ctx: StepContext, key: StepKey = ctx.step.key): StepComp => (ctx.stepState(key).compensation ?? {}) as StepComp;

/** Did any data step of this run add the `migrate` capability? */
export const runAddedCapability = (ctx: StepContext): boolean => (["DATA_SEED", "FREEZE", "DATA_FINAL"] as StepKey[]).some((k) => compOf(ctx, k).capAdded === true);

/** Fixed message for an exception thrown by a port that may be an agent problem (offline / capability not granted). */
export function classifyAgentError(e: unknown): "offline" | "forbidden" | "timeout" | "other" {
  const name = e instanceof Error ? e.constructor.name : "";
  const msg = e instanceof Error ? e.message : "";
  if (name === "AgentOfflineException" || /offline/i.test(msg)) return "offline";
  if (name === "ForbiddenException" || /not granted/i.test(msg)) return "forbidden";
  if (name === "AgentCommandTimeoutException" || /timed out/i.test(msg)) return "timeout";
  return "other";
}

/**
 * End a migrate-capability grant this run is responsible for. `addedNow`: THIS call added it. Otherwise it is released when
 * an earlier step of the run recorded that it added it. A capability the owner had granted before the run is never touched.
 */
export async function releaseIfOurs(ctx: StepContext, caps: CapabilityPort, addedNow: boolean): Promise<void> {
  if (!(addedNow || runAddedCapability(ctx))) return;
  const runner = agentRunnerHost(ctx.run);
  await caps.releaseMigrate(ctx.actor.userId, runner.ok ? runner.serverId : ctx.run.targetServerId);
}

/** Automatic starts of one object migration pass per step before a human has to press retry. */
export const MAX_AUTO_OBJECT_STARTS = 3;

/**
 * Count an automatic start of an object migration pass. Returns false (and records nothing) when the budget is spent and the
 * trigger is not an explicit retry: a pass that keeps failing is reported, not hammered.
 */
export async function takeObjectStart(ctx: StepContext, id: string): Promise<boolean> {
  const starts = { ...(compOf(ctx).objStarts ?? {}) };
  const n = starts[id] ?? 0;
  if (n >= MAX_AUTO_OBJECT_STARTS && ctx.trigger !== "retry") return false;
  starts[id] = ctx.trigger === "retry" && n >= MAX_AUTO_OBJECT_STARTS ? 1 : n + 1;
  await ctx.recordCompensation({ objStarts: starts });
  return true;
}
