import { describe, it, expect } from "vitest";
import { failureMessage, formatBytes, formatElapsed, parseFailure, stepOfPhase, updateSteps, type UpdatePhase } from "./useUpdateStream";

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

describe("failure reporting (never a bare 'update failed')", () => {
  it("parseFailure keeps the cause and the disk numbers, drops wrong-typed fields", () => {
    expect(parseFailure({ phase: "failed", error: "boom", code: "disk_space", needBytes: 10, haveBytes: 2, path: "/x" })).toEqual({
      error: "boom",
      code: "disk_space",
      needBytes: 10,
      haveBytes: 2,
      path: "/x",
    });
    expect(parseFailure({ error: 5, code: {}, needBytes: "1", haveBytes: -1, path: "" })).toEqual({ error: null, code: null, needBytes: null, haveBytes: null, path: null });
  });

  it("formatBytes matches the update helper's wording (binary GB, MB under 1 GB)", () => {
    expect(formatBytes(21474836480)).toBe("20.0 GB");
    expect(formatBytes(5368709120)).toBe("5.0 GB");
    expect(formatBytes(268435456)).toBe("256 MB");
  });

  it("failureMessage: disk numbers > reported cause > the generic key", () => {
    const base = { error: null, code: null, needBytes: null, haveBytes: null, path: null };
    expect(failureMessage({ ...base, code: "disk_space", needBytes: 21474836480, haveBytes: 5368709120, path: "/var/lib/docker" }, "g")).toEqual({
      key: "settings.updateDiskShort",
      params: { need: "20.0 GB", have: "5.0 GB", path: "/var/lib/docker" },
    });
    expect(failureMessage({ ...base, code: "disk_space" }, "g")).toEqual({ key: "settings.updateDiskFull" });
    expect(failureMessage({ ...base, error: "image pull failed: x" }, "g")).toEqual({ key: "settings.updateFailedReason", params: { reason: "image pull failed: x" } });
    expect(failureMessage(base, "settings.updateFailed")).toEqual({ key: "settings.updateFailed" });
    expect(failureMessage(null, "settings.updateFailed")).toEqual({ key: "settings.updateFailed" });
  });
});
