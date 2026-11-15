import { describe, it, expect } from "vitest";
import { formatElapsed, stepOfPhase, updateSteps, type UpdatePhase } from "./useUpdateStream";

const states = (phase: UpdatePhase, failed?: Parameters<typeof updateSteps>[1]) => updateSteps(phase, failed).map((s) => s.state);

describe("updateSteps (phase → stepper mapping)", () => {
  it("has the 4 steps in order", () => {
    expect(updateSteps("idle").map((s) => s.id)).toEqual(["queued", "pulling", "recreating", "reconnecting"]);
  });
  it("idle is all pending", () => {
    expect(states("idle")).toEqual(["pending", "pending", "pending", "pending"]);
  });
  it("starting and queued both show step 1 active", () => {
    expect(states("starting")).toEqual(["active", "pending", "pending", "pending"]);
    expect(states("queued")).toEqual(["active", "pending", "pending", "pending"]);
  });
  it("advances active step through pulling → recreating → reconnecting", () => {
    expect(states("pulling")).toEqual(["done", "active", "pending", "pending"]);
    expect(states("recreating")).toEqual(["done", "done", "active", "pending"]);
    expect(states("reconnecting")).toEqual(["done", "done", "done", "active"]);
  });
  it("done is all done", () => {
    expect(states("done")).toEqual(["done", "done", "done", "done"]);
  });
  it("failed / recovery_required turn the failed step red, earlier done, later pending", () => {
    expect(states("failed", "pulling")).toEqual(["done", "failed", "pending", "pending"]);
    expect(states("recovery_required", "recreating")).toEqual(["done", "done", "failed", "pending"]);
    expect(states("failed", "reconnecting")).toEqual(["done", "done", "done", "failed"]);
    expect(states("failed")).toEqual(["failed", "pending", "pending", "pending"]); // unknown step → the first
  });
  it("stepOfPhase maps working phases only", () => {
    expect(stepOfPhase("starting")).toBe("queued");
    expect(stepOfPhase("recreating")).toBe("recreating");
    expect(stepOfPhase("done")).toBeNull();
    expect(stepOfPhase("failed")).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("formats mm:ss and clamps negatives", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(9_999)).toBe("00:09");
    expect(formatElapsed(65_000)).toBe("01:05");
    expect(formatElapsed(61 * 60_000)).toBe("61:00");
    expect(formatElapsed(-5)).toBe("00:00");
  });
});
