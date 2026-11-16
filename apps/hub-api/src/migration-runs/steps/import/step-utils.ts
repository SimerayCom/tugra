/** Small helpers shared by the four import-side step handlers (P7 lane A). */
import { ConflictException, HttpException } from "@nestjs/common";
import type { ImportApplyInput } from "../../../importer/dto";
import type { ImportPlanResponse } from "../../../importer/importer.service";
import { isAcked } from "../../../importer/import-executor.logic";
import type { DryRunItem, GateCheck } from "../../core/dto";
import { RunLeaseLostError, StepFailure, type RunSnapshot, type StepContext } from "../../core/run-contract";
import { RunAbortRequestedError } from "../../core/run-engine.service";
import type { OpSnapshot, OpTask } from "./import-ports";

/** Task statuses in which the op's fan-out still has work to do. */
export const ACTIVE_TASK = new Set(["PENDING", "RUNNING", "AWAITING_CUTOVER"]);
/** Task statuses that mean "this item did not import". */
export const BAD_TASK = new Set(["FAILED", "FAILED_VERIFY", "CANCELLED"]);

export const hasActive = (op: OpSnapshot): boolean => op.tasks.some((t) => ACTIVE_TASK.has(t.status) && !isDataTask(t));
export const hasBad = (op: OpSnapshot): boolean => op.tasks.some((t) => BAD_TASK.has(t.status) && !isDataTask(t));
/** Migrator data tasks (`data:*`) belong to the data steps, never to IMPORT. */
export const isDataTask = (t: OpTask): boolean => t.kind === "data" || (t.itemRef ?? "").startsWith("data:");
export const itemTasks = (op: OpSnapshot): OpTask[] => op.tasks.filter((t) => !isDataTask(t));

/** A lower-case code fragment from an importer error code like `import.mapping_invalid`. */
const frag = (s: string): string => s.toLowerCase().replace(/^import\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "error";

/**
 * Map an error thrown by an existing service to a deterministic {@link StepFailure}: the raw message never reaches a row,
 * an event or a view; only the stable code the importer attaches (or the HTTP status) does.
 */
export function failureOf(e: unknown, prefix: string): StepFailure {
  if (e instanceof RunLeaseLostError || e instanceof RunAbortRequestedError) throw e; // control flow, never a step failure
  if (e instanceof StepFailure) return e;
  if (e instanceof HttpException) {
    const status = e.getStatus();
    const r = e.getResponse();
    const code = typeof r === "object" && r && typeof (r as { code?: unknown }).code === "string" ? (r as { code: string }).code : undefined;
    if (e instanceof ConflictException && /plan changed/i.test(e.message)) return new StepFailure("import.plan-changed", undefined, false);
    if (code) return new StepFailure(`${prefix}.${frag(code)}`, undefined, status >= 500);
    return new StepFailure(`${prefix}.http-${status}`, undefined, status >= 500 || status === 409);
  }
  return new StepFailure(`${prefix}.failed`, undefined, true);
}

/** Is this the "still running" 409 of `rollback` / the "in progress" 409 of apply? */
export const isConflict = (e: unknown): boolean => e instanceof ConflictException;

/** The importer's apply input for this run (the frozen secret-free input plus the live session id). */
export function applyInputOf(run: RunSnapshot, sessionId: string): ImportApplyInput {
  const a = run.applyInput;
  return {
    sourceKind: a.sourceKind,
    sessionId,
    targetServerId: a.targetServerId,
    planHash: a.planHash,
    ...(a.environmentId ? { environmentId: a.environmentId } : {}),
    ...(a.acks ? { acks: a.acks } : {}),
    ...(a.serviceChoices ? { serviceChoices: a.serviceChoices } : {}),
    ...(a.mapping ? { mapping: a.mapping } : {}),
    ...(a.mappingHash ? { mappingHash: a.mappingHash } : {}),
    ...(a.reconcile !== undefined ? { reconcile: a.reconcile } : {}),
    ...(a.ignoreStoredMapping !== undefined ? { ignoreStoredMapping: a.ignoreStoredMapping } : {}),
    ...(a.saveMapping !== undefined ? { saveMapping: a.saveMapping } : {}),
    ...(a.dbDataModes ? { dbDataModes: a.dbDataModes } : {}),
  } as ImportApplyInput;
}

/** Items the importer actually imports: not excluded by the mapping document. */
export function includedItems(plan: ImportPlanResponse, run: RunSnapshot): ImportPlanResponse["items"] {
  const items = run.applyInput.mapping?.items ?? {};
  return plan.items.filter((i) => items[i.itemRef]?.include !== false);
}

/** Plan blockers (per risk code) that no operator ack covers: the importer would skip those items entirely. */
export function unackedBlockers(plan: ImportPlanResponse, run: RunSnapshot): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const it of includedItems(plan, run)) {
    for (const r of it.risks) {
      if (r.level !== "blocker" || isAcked(run.applyInput.acks, it.itemRef, r.code)) continue;
      const list = out.get(r.code) ?? [];
      list.push(it.name);
      out.set(r.code, list);
    }
  }
  return out;
}

/** The dry-run projection of a list of gate checks (fail blocks, unknown would block, warn warns, pass informs). */
export function itemsFromChecks(checks: readonly GateCheck[]): DryRunItem[] {
  return checks.map((c) => ({
    code: c.code,
    level: c.status === "fail" ? "block" : c.status === "unknown" ? "unknown" : c.status === "warn" ? "warn" : "info",
    ...(c.subject ? { subject: c.subject } : {}),
    ...(c.params ? { params: c.params } : {}),
  }));
}

/** Turn unacknowledged ACKABLE problems into warnings for the pre-gate: the approval gate (not the pre-gate) parks them. */
export function softenAckable(checks: readonly GateCheck[]): GateCheck[] {
  return checks.map((c) => (c.ackable === true && !c.acked && (c.status === "fail" || c.status === "unknown") ? { ...c, status: "warn" as const } : c));
}

/** A tiny time-boxed memo: a rate limiter for expensive READ-ONLY lookups of parked ticks. It is never authority. */
export class Memo<T> {
  private readonly m = new Map<string, { at: number; v: T }>();
  constructor(private readonly ttlMs: number) {}
  async get(key: string, bypass: boolean, now: () => number, fn: () => Promise<T>): Promise<T> {
    const hit = this.m.get(key);
    if (!bypass && hit && now() - hit.at < this.ttlMs) return hit.v;
    const v = await fn();
    this.m.set(key, { at: now(), v });
    for (const [k, e] of this.m) if (now() - e.at > this.ttlMs * 4) this.m.delete(k);
    return v;
  }
}

/** True when the engine entered the step because time passed or the hub restarted (not because a human acted). */
export const isPassive = (ctx: StepContext): boolean => ctx.trigger === "tick" || ctx.trigger === "timer" || ctx.trigger === "recover";

/** `migrun:<runId>:<appId>` : the idempotency key prefix of an app's run-owned deployments. */
export const deployKeyBase = (runId: string, appId: string): string => `migrun:${runId}:${appId}`;
