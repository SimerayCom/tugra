import { describe, expect, it } from "vitest";
import { canCancel, canHalt, canResume, isRolloutActive, parseSteps, rolloutProgressPct, rolloutRefetchInterval, targetsByWave } from "./rollouts";

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
