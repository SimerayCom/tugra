import type { ForeignFleet, ImportPlan } from "./foreign-fleet";

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
  kind: "app" | "database" | "volume";
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
