import { describe, it, expect } from "vitest";
import { buildTimeline } from "./deployment-timeline";

describe("buildTimeline", () => {
  const base = { status: "SUCCESS" as const, createdAt: "2026-11-14T10:00:00.000Z", startedAt: "2026-11-14T10:00:02.000Z", durationMs: 8000, finishedAt: "2026-11-14T10:00:10.000Z" };

  it("a finished deploy: three done steps, queue wait and run time", () => {
    const t = buildTimeline(base);
    expect(t.steps.map((s) => [s.key, s.state])).toEqual([["queued", "done"], ["started", "done"], ["finished", "done"]]);
    expect(t.steps[2].at).toBe(base.finishedAt);
    expect(t.queueWaitMs).toBe(2000);
    expect(t.runMs).toBe(8000);
  });

  it("queued: start is the active step, nothing finished, no durations yet", () => {
    const t = buildTimeline({ ...base, status: "QUEUED", startedAt: null, durationMs: null, finishedAt: null });
    expect(t.steps.map((s) => s.state)).toEqual(["done", "active", "pending"]);
    expect(t.queueWaitMs).toBeNull();
    expect(t.runMs).toBeNull();
  });

  it("running: started done, finish active, run time unknown", () => {
    const t = buildTimeline({ ...base, status: "RUNNING", durationMs: null, finishedAt: null });
    expect(t.steps.map((s) => s.state)).toEqual(["done", "done", "active"]);
    expect(t.runMs).toBeNull();
    expect(t.queueWaitMs).toBe(2000);
  });

  it("cancelled while queued / legacy without startedAt: the start step is skipped (unknown), never faked", () => {
    const t = buildTimeline({ ...base, status: "CANCELLED", startedAt: null, durationMs: null, finishedAt: null });
    expect(t.steps.map((s) => s.state)).toEqual(["done", "skipped", "skipped"]); // no finish time either → unknown, not "done"
    expect(t.steps[1].at).toBeNull();
    const legacy = buildTimeline({ ...base, startedAt: null, finishedAt: null });
    expect(legacy.steps[1].state).toBe("skipped");
    expect(legacy.steps[2].state).toBe("skipped");
    const reaped = buildTimeline({ ...base, status: "FAILED", durationMs: null, finishedAt: null }); // hub-restart reap writes no duration
    expect(reaped.steps[2].state).toBe("skipped");
    expect(legacy.queueWaitMs).toBeNull();
    expect(legacy.runMs).toBe(8000);
  });

  it("never reports a negative queue wait on clock skew", () => {
    expect(buildTimeline({ ...base, startedAt: "2026-11-14T09:59:59.000Z" }).queueWaitMs).toBe(0);
  });
});
