import type { ForeignApp, ForeignDb, ForeignFleet, ImportPlan, ImportPlanItem } from "./foreign-fleet";
import { ACKABLE_RISK_CODES } from "./import-planner";

/** The BulkTaskStatus values, as a string union (the logic here does not import Prisma). */
export type TaskStatus =
  | "PENDING"
  | "RUNNING"
  | "DONE"
  | "FAILED"
  | "SKIPPED"
  | "ROLLED_BACK"
  | "FAILED_VERIFY"
  | "AWAITING_CUTOVER"
  | "CANCELLED";

/** One task to persist for a plan item. For the local-docker source only app items are runnable (adopt in
 *  place); databases/volumes cannot be moved in place, so they are recorded SKIPPED with a reason. */
export interface TaskSeed {
  itemRef: string;
  kind: "app" | "database" | "volume" | "service";
  name: string;
  dependsOn: string[];
  run: boolean;
  skipReason?: string;
  /** adopt parameters for a runnable app item: the source container ref + its current (original) name. */
  adopt?: { container: string; originalName: string };
}

export const SKIP_NON_APP =
  "local-docker import adopts running app containers in place; databases and volumes are not moved (use a source-PaaS adapter)";

const appKey = (serverRef: string | undefined, sourceRef: string): string => `app:${serverRef ?? "_"}:${sourceRef}`;

/**
 * Pure: turn a local-docker {@link ImportPlan} (+ the fleet it was planned from) into the task seeds to
 * persist. App items with no blocking risk become runnable adopt tasks; everything else is skipped with a
 * reason so the operation honestly records what it did not do.
 */
export function seedTasks(plan: ImportPlan, fleet: ForeignFleet): TaskSeed[] {
  const appByRef = new Map(fleet.apps.map((a) => [appKey(a.serverRef, a.sourceRef), a]));
  return plan.items.map((it) => {
    const base = { itemRef: it.itemRef, kind: it.kind, name: it.name, dependsOn: it.dependsOn };
    if (it.kind !== "app") return { ...base, run: false, skipReason: SKIP_NON_APP };
    const app = appByRef.get(it.itemRef);
    if (!app) return { ...base, run: false, skipReason: "no source container for this item" };
    if (it.risks.some((r) => r.level === "blocker")) return { ...base, run: false, skipReason: "blocked by a plan risk" };
    return { ...base, run: true, adopt: { container: app.sourceRef, originalName: app.name } };
  });
}

export type DepGate = "ready" | "wait" | "blocked";

/**
 * Pure: can a task start, given the current status of every itemRef in the operation? A dependency that is
 * DONE or SKIPPED is satisfied; one that failed/was cancelled/rolled back blocks the dependent; one still
 * pending/running means wait. A dependency not present in this operation is ignored (not our gate).
 */
export function dependencyGate(dependsOn: string[], statusByRef: Map<string, TaskStatus>): DepGate {
  let wait = false;
  for (const ref of dependsOn) {
    const s = statusByRef.get(ref);
    if (s === undefined || s === "DONE" || s === "SKIPPED") continue;
    if (s === "FAILED" || s === "FAILED_VERIFY" || s === "CANCELLED" || s === "ROLLED_BACK") return "blocked";
    wait = true; // PENDING | RUNNING | AWAITING_CUTOVER
  }
  return wait ? "wait" : "ready";
}

export type OpStatus = "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "CANCELLED";

/**
 * Pure: derive the operation-level status from its task statuses. RUNNING while any task is still active;
 * otherwise FAILED (all failed), PARTIAL (some done, some failed), CANCELLED (cancelled, none failed), or
 * SUCCEEDED (all done/skipped/rolled-back). An operation with no tasks is SUCCEEDED (nothing to do).
 */
export function deriveOpStatus(statuses: TaskStatus[]): OpStatus {
  if (statuses.some((s) => s === "PENDING" || s === "RUNNING" || s === "AWAITING_CUTOVER")) return "RUNNING";
  const anyFailed = statuses.some((s) => s === "FAILED" || s === "FAILED_VERIFY");
  const anyDone = statuses.some((s) => s === "DONE");
  if (anyFailed) return anyDone ? "PARTIAL" : "FAILED";
  if (statuses.some((s) => s === "CANCELLED")) return "CANCELLED";
  return "SUCCEEDED";
}

/** Engines Tugra can provision a resource for — a discovered DB with any other engine (e.g. UNKNOWN)
 *  is skipped by a plan blocker, but we re-check at apply so a bad engine never reaches DatabasesService. */
export const PROVISIONABLE_ENGINES = new Set(["POSTGRES", "MYSQL", "REDIS", "MONGO", "MARIADB", "KEYDB", "DRAGONFLY", "CLICKHOUSE", "LIBSQL"]);

/** An operator acknowledgement of an ackable plan blocker (structurally the dto's `ImportAck`; declared here so this
 *  pure module does not import the dto). */
export type RiskAck = { code: string; itemRef?: string };

/** Is `code` on `itemRef` covered by an operator ack? Only the ackable codes can ever be; an ack without `itemRef`
 *  covers every item carrying the code. */
export function isAcked(acks: readonly RiskAck[] | undefined, itemRef: string, code: string): boolean {
  if (!acks?.length || !ACKABLE_RISK_CODES.includes(code)) return false;
  return acks.some((a) => a.code === code && (a.itemRef === undefined || a.itemRef === itemRef));
}

type PredicateItem = Pick<ImportPlanItem, "kind" | "risks"> & { itemRef?: string };

/** Pure: does the item carry a blocker the operator has NOT acknowledged? */
export function hasUnackedBlocker(item: PredicateItem, acks?: readonly RiskAck[]): boolean {
  return item.risks.some((r) => r.level === "blocker" && !(item.itemRef !== undefined && isAcked(acks, item.itemRef, r.code)));
}

/**
 * Pure: will the remote-copy apply actually create a Tugra resource for this app/database plan item? One predicate
 * shared by the apply loop and the mapping resolver, so the preview can never disagree with what apply does. `dup` =
 * the item was already imported onto the target server by a prior op (and its resource still exists). `acks` are
 * the operator's risk acknowledgements (none = the original behaviour, byte-identical). Services are decided by the
 * apply loop's own service branch.
 */
export function isRunnable(item: PredicateItem, app: ForeignApp | undefined, db: ForeignDb | undefined, dup: boolean, acks?: readonly RiskAck[]): boolean {
  const provisionableDb = !!db && PROVISIONABLE_ENGINES.has(db.engine);
  return !dup && !hasUnackedBlocker(item, acks) && ((item.kind === "app" && !!app) || (item.kind === "database" && provisionableDb));
}

/** Pure: why a non-runnable item is skipped (the exact text apply has always written). */
export function skipReason(item: PredicateItem, db: ForeignDb | undefined, dup: boolean, acks?: readonly RiskAck[]): string {
  const provisionableDb = !!db && PROVISIONABLE_ENGINES.has(db.engine);
  return dup
    ? "already imported onto this server in a previous run"
    : hasUnackedBlocker(item, acks)
      ? "blocked by a plan risk"
      : item.kind === "volume"
        ? "handled with its owning app (declared there when eligible); its data is not copied by this import yet"
        : item.kind === "database" && !provisionableDb
          ? "database engine has no Tugra equivalent"
          : "could not resolve the source resource";
}
