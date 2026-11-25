import { describe, it, expect } from "vitest";
import type { MoveOffServerRow, MoveOffStatusView } from "@tugra/shared";
import { currentStep, readyToShutDown, rowAction, sortRows, stepOf, coolifyRows, takeoverHref, connectHref } from "./coolify-move";

const row = (o: Partial<MoveOffServerRow>): MoveOffServerRow => ({ serverId: "s1", name: "a", agentOnline: true, coolify: true, isCoolifyHub: false, takeover: "none", cleanup: "none", stage: "takeover", ...o });
const view = (o: Partial<MoveOffStatusView> = {}): MoveOffStatusView => ({
  teamId: "t1",
  hub: null,
  servers: [],
  campaigns: [],
  projectMoves: { total: 0, active: 0, completed: 0, failed: 0, latestPhase: null },
  steps: [
    { step: "takeover", done: 0, total: 2, complete: false },
    { step: "cleanup", done: 0, total: 2, complete: false },
    { step: "consolidate", done: 0, total: 0, complete: false },
    { step: "shutdown", done: 0, total: 1, complete: false },
  ],
  ...o,
});

describe("rowAction", () => {
  it("sends each stage to the screen where the owner presses the button", () => {
    expect(rowAction(row({ stage: "agent", agentOnline: false }))).toEqual({ href: "/servers/s1", labelKey: "coolifyMove.rowAction.agent" });
    expect(rowAction(row({ stage: "takeover" }))).toEqual({ href: "/import", labelKey: "coolifyMove.rowAction.takeoverStart" });
    expect(rowAction(row({ stage: "takeover", takeover: "FAILED" }))).toEqual({ href: "/import/inplace?serverId=s1", labelKey: "coolifyMove.rowAction.takeoverOpen" });
    expect(rowAction(row({ stage: "cleanup", takeover: "VERIFIED" }))?.href).toBe("/servers/s1");
    expect(rowAction(row({ stage: "hub" }))).toBeNull();
    expect(rowAction(row({ stage: "not_coolify" }))).toBeNull();
  });
  it("encodes the id so it cannot change the route", () => {
    expect(takeoverHref("a b&x=1")).toBe("/import/inplace?serverId=a%20b%26x%3D1");
    expect(connectHref("a/b")).toBe("/import/coolify-host?server=a%2Fb");
    expect(rowAction(row({ stage: "agent", serverId: "../x" }))?.href).toBe("/servers/..%2Fx");
  });
});

describe("sortRows", () => {
  it("puts what needs attention first and finished and unrelated servers last, by name inside a stage", () => {
    const rows = [row({ name: "z", stage: "done" }), row({ name: "b", stage: "takeover" }), row({ name: "a", stage: "takeover" }), row({ name: "m", stage: "agent" }), row({ name: "n", stage: "not_coolify" })];
    expect(sortRows(rows).map((r) => r.name)).toEqual(["m", "a", "b", "z", "n"]);
  });
  it("does not change its input", () => {
    const rows = [row({ name: "b", stage: "done" }), row({ name: "a", stage: "agent" })];
    sortRows(rows);
    expect(rows.map((r) => r.name)).toEqual(["b", "a"]);
  });
});

describe("steps", () => {
  it("currentStep is the first step not complete, and shutdown only after both are", () => {
    expect(currentStep(view())).toBe("takeover");
    const a = view({ steps: view().steps.map((s) => (s.step === "takeover" ? { ...s, complete: true, done: 2 } : s)) });
    expect(currentStep(a)).toBe("cleanup");
    const ab = view({ steps: view().steps.map((s) => (s.step === "takeover" || s.step === "cleanup" ? { ...s, complete: true, done: 2 } : s)) });
    expect(currentStep(ab)).toBe("shutdown");
  });
  it("readyToShutDown needs A and B complete and no project move running", () => {
    const done = view().steps.map((s) => (s.step === "takeover" || s.step === "cleanup" ? { ...s, complete: true, done: 2 } : s));
    expect(readyToShutDown(view({ steps: done }))).toBe(true);
    expect(readyToShutDown(view({ steps: done, projectMoves: { total: 1, active: 1, completed: 0, failed: 0, latestPhase: "MOVING" } }))).toBe(false);
    expect(readyToShutDown(view())).toBe(false);
  });
  it("stepOf has a safe default", () => {
    expect(stepOf(view({ steps: [] }), "cleanup")).toEqual({ step: "cleanup", done: 0, total: 0, complete: false });
  });
  it("coolifyRows leaves out the hub and servers Coolify does not know", () => {
    const rows = [row({ serverId: "a" }), row({ serverId: "h", isCoolifyHub: true }), row({ serverId: "n", coolify: false })];
    expect(coolifyRows(rows).map((r) => r.serverId)).toEqual(["a"]);
  });
});
