import { describe, it, expect } from "vitest";
import { IN_PLACE_STEPS, isSwitching, needsYou, runStepperState, stepElapsedSec, stepperModel, stepState } from "./run-stepper";
import { MIGRATION_RUN_STEP_KEYS } from "./migration-run";
import { mkRun, mkStep } from "../components/migration-run/test-fixtures";
import type { MigrationRunStepKey, MigrationRunStepStatus } from "./types";

const FLOW = MIGRATION_RUN_STEP_KEYS.filter((k) => k !== "DECOMMISSION");
const NOT_APPLICABLE: MigrationRunStepKey[] = ["DNS_PREPARE", "DATA_SEED", "FREEZE", "DATA_FINAL", "TLS_PREISSUE"];
const steps = (status: Partial<Record<MigrationRunStepKey, MigrationRunStepStatus>>) => FLOW.map((k) => mkStep(k, NOT_APPLICABLE.includes(k) ? "SKIPPED" : (status[k] ?? "PENDING")));
const inPlace = (over: Parameters<typeof mkRun>[0], status: Partial<Record<MigrationRunStepKey, MigrationRunStepStatus>>) => mkRun({ inPlace: true, ...over }, steps(status));

describe("stepperModel", () => {
  it("an in-place run keeps the eight steps that apply and counts the rest", () => {
    const m = stepperModel(inPlace({ status: "RUNNING", currentStep: "IMPORT" }, { PREFLIGHT: "PASSED", IMPORT: "RUNNING" }));
    expect(m.rows.map((r) => r.step.key)).toEqual([...IN_PLACE_STEPS]);
    expect(m.hidden).toBe(5);
    expect(m.done).toBe(1);
    expect(m.rows.find((r) => r.current)?.step.key).toBe("IMPORT");
    expect(m.working).toBe(true);
  });

  it("a step that was skipped for a reason (no observe window) is not drawn either", () => {
    const run = inPlace({ status: "RUNNING", currentStep: "CUTOVER" }, { PREFLIGHT: "PASSED", CUTOVER: "RUNNING", OBSERVE: "SKIPPED" });
    expect(stepperModel(run).rows.map((r) => r.step.key)).not.toContain("OBSERVE");
  });

  it("a move to another server draws all thirteen steps; DECOMMISSION is its own armed action, never a step of the flow", () => {
    const m = stepperModel(mkRun({ status: "RUNNING", currentStep: "IMPORT" }, [...FLOW.map((k) => mkStep(k)), mkStep("DECOMMISSION")]));
    expect(m.rows).toHaveLength(13);
    expect(m.hidden).toBe(0);
  });

  it("a queued run is not working", () => {
    expect(stepperModel(inPlace({ status: "QUEUED", currentStep: null }, {})).working).toBe(false);
  });
});

describe("stepState", () => {
  const run = { status: "RUNNING", currentStep: "VERIFY" } as const;
  it("names every status in the owner's words", () => {
    const of = (status: MigrationRunStepStatus) => stepState(run, { key: "VERIFY", status });
    expect(of("PASSED")).toBe("done");
    expect(of("FAILED")).toBe("failed");
    expect(of("COMPENSATED")).toBe("undone");
    expect(of("WAITING_APPROVAL")).toBe("needs-you");
    expect(of("WAITING_OPERATOR")).toBe("needs-you");
    expect(of("WAITING_TIMER")).toBe("waiting");
    expect(of("RUNNING")).toBe("working");
    expect(of("PENDING")).toBe("todo");
  });
  it("a paused run does not read as working", () => {
    expect(stepState({ status: "PAUSED", currentStep: "VERIFY" }, { key: "VERIFY", status: "RUNNING" })).toBe("paused");
  });
});

describe("whole-run helpers", () => {
  it("runStepperState: done when completed, not started when queued, else the state of the step it is on", () => {
    expect(runStepperState(inPlace({ status: "COMPLETED", currentStep: null }, {}))).toBe("done");
    expect(runStepperState(inPlace({ status: "QUEUED", currentStep: null }, {}))).toBe("todo");
    expect(runStepperState(inPlace({ status: "WAITING", currentStep: "VERIFY" }, { VERIFY: "WAITING_APPROVAL" }))).toBe("needs-you");
  });

  it("needsYou follows the hub's next action and never fires for a finished run", () => {
    const na = (kind: "approval" | "engine" | "failed") => ({ kind, stepKey: null, code: "x", since: "2026-11-28T08:00:00.000Z" });
    expect(needsYou({ status: "WAITING", nextAction: na("approval") })).toBe(true);
    expect(needsYou({ status: "FAILED", nextAction: na("failed") })).toBe(true);
    expect(needsYou({ status: "RUNNING", nextAction: na("engine") })).toBe(false);
    expect(needsYou({ status: "COMPLETED", nextAction: na("approval") })).toBe(false);
  });

  it("isSwitching: approved, switching or stuck half way counts; waiting for the approval or switched does not", () => {
    expect(isSwitching(inPlace({ status: "WAITING" }, { VERIFY: "WAITING_APPROVAL" }))).toBe(false);
    expect(isSwitching({ status: "WAITING", inPlace: true, steps: [mkStep("VERIFY", "WAITING_APPROVAL", { approval: { at: "2026-11-28T08:00:00.000Z" } as never })] })).toBe(true);
    expect(isSwitching(inPlace({ status: "RUNNING" }, { VERIFY: "PASSED", CUTOVER: "RUNNING" }))).toBe(true);
    expect(isSwitching(inPlace({ status: "RUNNING" }, { VERIFY: "PASSED", CUTOVER: "PASSED", OBSERVE: "WAITING_TIMER" }))).toBe(false);
    expect(isSwitching(mkRun({ status: "RUNNING" }, steps({ CUTOVER: "RUNNING" })))).toBe(false); // a copy run is not held
  });

  it("stepElapsedSec counts a running step up to now and a finished one to its end", () => {
    const now = new Date("2026-11-28T08:10:00.000Z").getTime();
    expect(stepElapsedSec({ startedAt: "2026-11-28T08:00:00.000Z", finishedAt: null }, now)).toBe(600);
    expect(stepElapsedSec({ startedAt: "2026-11-28T08:00:00.000Z", finishedAt: "2026-11-28T08:02:00.000Z" }, now)).toBe(120);
    expect(stepElapsedSec({ startedAt: null, finishedAt: null }, now)).toBeNull();
  });
});
