import type { ImportPlan, ImportPlanItem, ImportRisk, ImportRiskLevel, ImportOperation } from "./types";

// Pure view helpers for the import wizard. No network, no React — the data shaping the plan-review and
// apply-timeline screens render from (and the only part worth unit-testing).

export function hasBlocker(item: ImportPlanItem): boolean {
  return item.risks.some((r) => r.level === "blocker");
}

export function blockingRisks(item: ImportPlanItem): ImportRisk[] {
  return item.risks.filter((r) => r.level === "blocker");
}

export interface PlanSummary {
  apps: number;
  databases: number;
  volumes: number;
  blockers: number;
  warnings: number;
  runnable: number; // items that will actually be imported (not blocked)
  blocked: number;
}

export function planSummary(plan: ImportPlan): PlanSummary {
  const blocked = plan.items.filter(hasBlocker).length;
  return {
    apps: plan.totals.apps,
    databases: plan.totals.databases,
    volumes: plan.totals.volumes,
    blockers: plan.totals.blockers,
    warnings: plan.warnings.length,
    runnable: plan.items.length - blocked,
    blocked,
  };
}

/** Group plan items by kind for sectioned display (empty arrays kept so the UI can show "0 databases"). */
export function itemsByKind(plan: ImportPlan): Record<ImportPlanItem["kind"], ImportPlanItem[]> {
  const out: Record<ImportPlanItem["kind"], ImportPlanItem[]> = { app: [], database: [], volume: [] };
  for (const it of plan.items) out[it.kind].push(it);
  return out;
}

/** The apply button is enabled only when at least one app will actually be imported. */
export function canApply(plan: ImportPlan): boolean {
  return plan.items.some((it) => it.kind === "app" && !hasBlocker(it));
}

/** UI tone token for a risk level (a class/color key, not a display string). */
export function riskTone(level: ImportRiskLevel): "danger" | "warning" | "info" {
  return level === "blocker" ? "danger" : level === "warn" ? "warning" : "info";
}

export interface OpProgress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  active: number; // pending + running
  pct: number; // 0–100, by terminal/total
  settled: boolean; // the operation has stopped (not RUNNING)
}

export function opProgress(op: ImportOperation): OpProgress {
  const t = op.totals;
  const active = t.running + t.pending;
  const terminal = Math.max(0, t.total - active);
  return {
    total: t.total,
    done: t.done,
    failed: t.failed,
    skipped: t.skipped,
    active,
    pct: t.total > 0 ? Math.round((terminal / t.total) * 100) : 100,
    settled: op.status !== "RUNNING",
  };
}
