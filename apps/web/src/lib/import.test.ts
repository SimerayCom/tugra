import { describe, it, expect } from "vitest";
import { hasBlocker, blockingRisks, planSummary, itemsByKind, canApply, riskTone, opProgress } from "./import";
import type { ImportPlan, ImportPlanItem, ImportOperation } from "./types";

const item = (over: Partial<ImportPlanItem>): ImportPlanItem => ({
  itemRef: "app:srv:a",
  kind: "app",
  name: "app",
  proposed: {},
  risks: [],
  dependsOn: [],
  ...over,
});

const plan: ImportPlan = {
  sourceKind: "coolify",
  mode: "copy",
  planHash: "a".repeat(32),
  warnings: ["1 service needs a read:sensitive token"],
  totals: { apps: 2, databases: 1, volumes: 0, blockers: 1 },
  items: [
    item({ itemRef: "app:srv:web", name: "web" }),
    item({ itemRef: "app:srv:api", name: "api", risks: [{ level: "blocker", code: "x", message: "no image and no git" }] }),
    item({ itemRef: "database:srv:db", kind: "database", name: "orders", risks: [{ level: "warn", code: "db.version", message: "pin the version" }] }),
  ],
};

describe("plan helpers", () => {
  it("hasBlocker / blockingRisks", () => {
    expect(hasBlocker(plan.items[0])).toBe(false);
    expect(hasBlocker(plan.items[1])).toBe(true);
    expect(blockingRisks(plan.items[1]).map((r) => r.code)).toEqual(["x"]);
  });

  it("planSummary counts runnable vs blocked", () => {
    expect(planSummary(plan)).toEqual({ apps: 2, databases: 1, volumes: 0, blockers: 1, warnings: 1, runnable: 2, blocked: 1 });
  });

  it("itemsByKind groups all three kinds (empty arrays kept)", () => {
    const g = itemsByKind(plan);
    expect(g.app.map((i) => i.name)).toEqual(["web", "api"]);
    expect(g.database.map((i) => i.name)).toEqual(["orders"]);
    expect(g.volume).toEqual([]);
  });

  it("canApply true when ≥1 non-blocked app, false otherwise", () => {
    expect(canApply(plan)).toBe(true);
    expect(canApply({ ...plan, items: [item({ risks: [{ level: "blocker", code: "x", message: "m" }] })] })).toBe(false);
    expect(canApply({ ...plan, items: [item({ kind: "database" })] })).toBe(false);
  });

  it("riskTone maps level → tone token", () => {
    expect(riskTone("blocker")).toBe("danger");
    expect(riskTone("warn")).toBe("warning");
    expect(riskTone("info")).toBe("info");
  });
});

const op = (over: Partial<ImportOperation["totals"]>, status: ImportOperation["status"] = "RUNNING"): ImportOperation => ({
  id: "op1",
  sourceKind: "coolify",
  serverId: "srv",
  planHash: null,
  status,
  cancelRequested: false,
  createdAt: "2026-10-18T00:00:00.000Z",
  totals: { total: 4, done: 0, failed: 0, skipped: 0, running: 0, pending: 0, cancelled: 0, rolledBack: 0, ...over },
  tasks: [],
});

describe("opProgress", () => {
  it("computes pct from terminal/total and active = pending+running", () => {
    expect(opProgress(op({ total: 4, done: 2, running: 1, pending: 1 }))).toMatchObject({ pct: 50, active: 2, settled: false });
  });
  it("is 100% + settled once the op stops", () => {
    expect(opProgress(op({ total: 3, done: 3 }, "SUCCEEDED"))).toMatchObject({ pct: 100, active: 0, settled: true });
  });
  it("empty op → 100% (nothing to do)", () => {
    expect(opProgress(op({ total: 0 }, "SUCCEEDED")).pct).toBe(100);
  });
});
