import { describe, expect, it } from "vitest";
import { canCancel, canHalt, canResume, canRollback, isRolloutActive, parseSteps, rolloutProgressPct, rolloutRefetchInterval, targetsByWave } from "./rollouts";
import type { Rollout, RolloutTarget } from "./types";

describe("rollouts helpers", () => {
  it("active vs terminal + allowed transitions", () => {
    expect(isRolloutActive("RUNNING")).toBe(true);
    expect(isRolloutActive("HALTED")).toBe(true);
    expect(isRolloutActive("COMPLETED")).toBe(false);
    expect(isRolloutActive("CANCELLED")).toBe(false);
    expect(canHalt("RUNNING")).toBe(true);
    expect(canHalt("HALTED")).toBe(false);
    expect(canResume("HALTED")).toBe(true);
    expect(canResume("RUNNING")).toBe(false);
    expect(canCancel("RUNNING")).toBe(true);
    expect(canCancel("HALTED")).toBe(true);
    expect(canCancel("COMPLETED")).toBe(false);
  });
  it("canRollback: at rest (HALTED/COMPLETED), nothing deploying, and something this rollout moved", () => {
    const tg = (status: RolloutTarget["status"], outcome: string | null = null) => ({ status, outcome }) as RolloutTarget;
    const sum = (deploying = 0) => ({ total: 1, pending: 0, deploying, succeeded: 0, failed: 0, skipped: 0, cancelled: 0 });
    const r = (status: Rollout["status"], targets: RolloutTarget[], deploying = 0) => ({ status, summary: sum(deploying), targets });
    expect(canRollback(r("HALTED", [tg("SUCCEEDED", "passed")]))).toBe(true);
    expect(canRollback(r("COMPLETED", [tg("SUCCEEDED", "passed")]))).toBe(true);
    expect(canRollback(r("HALTED", [tg("FAILED", "failed")]))).toBe(true);
    expect(canRollback(r("HALTED", [tg("FAILED", "rejected_safe")]))).toBe(false); // previous version already live
    expect(canRollback(r("HALTED", [tg("SUCCEEDED", "passed")], 1))).toBe(false); // a deploy still in flight
    expect(canRollback(r("HALTED", []))).toBe(false);
    for (const s of ["RUNNING", "CANCELLED", "ROLLING_BACK", "ROLLED_BACK"] as const) expect(canRollback(r(s, [tg("SUCCEEDED", "passed")]))).toBe(false);
  });

  it("progress counts every terminal target; empty = 0", () => {
    expect(rolloutProgressPct({ summary: { total: 4, pending: 1, deploying: 1, succeeded: 1, failed: 1, skipped: 0, cancelled: 0 } })).toBe(50);
    expect(rolloutProgressPct({ summary: { total: 0, pending: 0, deploying: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0 } })).toBe(0);
  });
  it("groups targets by wave, always waveCount long", () => {
    const g = targetsByWave([{ wave: 1 }, { wave: 0 }, { wave: 1 }], 3);
    expect(g.map((w) => w.length)).toEqual([1, 2, 0]);
  });
  it("parses the steps field strictly", () => {
    expect(parseSteps("25, 50, 100")).toEqual([25, 50, 100]);
    expect(parseSteps("100")).toEqual([100]);
    expect(parseSteps("50 25 100")).toBeNull();
    expect(parseSteps("25,50")).toBeNull();
    expect(parseSteps("0,100")).toBeNull();
    expect(parseSteps("")).toBeNull();
    expect(parseSteps("10,20,30,40,50,60,70,80,90,100")).toBeNull(); // > 9 steps
  });
  it("polls while active, stops once terminal", () => {
    expect(rolloutRefetchInterval(undefined)).toBe(3000);
    expect(rolloutRefetchInterval({ status: "RUNNING" })).toBe(3000);
    expect(rolloutRefetchInterval({ status: "COMPLETED" })).toBe(false);
  });
});
