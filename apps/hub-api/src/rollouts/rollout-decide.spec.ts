import { INTERRUPTED_DEPLOY_NOTE } from "../applications/deployment-reconcile.service";
import { classifyDeployment, decide, rollbackKey, rollbackTargets, rolloutKey, type Action, type DeploymentFacts, type RolloutSnap, type TargetSnap } from "./rollout-decide";
import { RolloutConfigSchema } from "./rollout-plan";

const NOW = Date.parse("2026-11-15T10:00:00Z");
const BOOT = NOW - 3_600_000;
const T0 = new Date(NOW - 60_000);

const dep = (over: Partial<DeploymentFacts> = {}): DeploymentFacts => ({ status: "RUNNING", kind: "DEPLOY", exitCode: null, logs: null, startedAt: new Date(NOW - 30_000), createdAt: new Date(NOW - 40_000), ...over });
const rollout = (over: Partial<RolloutSnap> = {}): RolloutSnap => ({
  status: "RUNNING",
  currentWave: 0,
  waveCount: 2,
  waveStartedAt: T0,
  bakeUntil: null,
  config: RolloutConfigSchema.parse({ bakeSec: 0 }),
  ...over,
});
const target = (id: string, wave: number, over: Partial<TargetSnap> = {}): TargetSnap => ({
  id,
  wave,
  status: "PENDING",
  attempt: 0,
  deploymentId: null,
  deployment: null,
  rollbackAttempt: 0,
  rollbackDispatchedAt: null,
  rollbackDeploymentId: null,
  rollbackDeployment: null,
  appStatus: "RUNNING",
  superseded: false,
  online: true,
  ...over,
});
const types = (a: Action[]) => a.map((x) => x.type);
const settles = (a: Action[]) => a.filter((x): x is Extract<Action, { type: "settle" }> => x.type === "settle").map((x) => [x.targetId, x.status, x.outcome]);

describe("classifyDeployment", () => {
  const ctx = { now: NOW, bootAt: BOOT, dispatchTimeoutMs: 600_000 };
  it("maps the per-app pipeline outcome onto a rollout verdict", () => {
    expect(classifyDeployment(dep({ status: "SUCCESS" }), ctx)).toBe("passed");
    expect(classifyDeployment(dep({ status: "FAILED", kind: "AUTO_ROLLBACK", exitCode: 4 }), ctx)).toBe("rejected_safe");
    expect(classifyDeployment(dep({ status: "FAILED", exitCode: 1 }), ctx)).toBe("failed");
    expect(classifyDeployment(dep({ status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE }), ctx)).toBe("interrupted");
    expect(classifyDeployment(dep({ status: "FAILED", exitCode: -1, logs: "agent offline" }), ctx)).toBe("failed");
    expect(classifyDeployment(dep({ status: "CANCELLED" }), ctx)).toBe("cancelled");
    expect(classifyDeployment(dep(), ctx)).toBe("running");
  });
  it("a RUNNING row that started before this hub process is an orphan (interrupted); a QUEUED row past the dispatch timeout is queue_timeout", () => {
    expect(classifyDeployment(dep({ startedAt: new Date(BOOT - 1) }), ctx)).toBe("interrupted");
    // a RECOVERABLE pre-boot RUNNING row (durable command being adopted from the agent's journal) is still live
    expect(classifyDeployment(dep({ startedAt: new Date(BOOT - 1), recoverable: true }), ctx)).toBe("running");
    expect(classifyDeployment(dep({ startedAt: new Date(BOOT - 1), recoverable: false }), ctx)).toBe("interrupted");
    // ...and once adoption settles it, the usual terminal rules apply (the interrupted note may carry a detail suffix)
    expect(classifyDeployment(dep({ status: "FAILED", exitCode: -1, logs: `${INTERRUPTED_DEPLOY_NOTE}\nthe agent restarted` }), ctx)).toBe("interrupted");
    expect(classifyDeployment(dep({ status: "QUEUED", startedAt: null, createdAt: new Date(NOW - 600_001) }), ctx)).toBe("queue_timeout");
    expect(classifyDeployment(dep({ status: "QUEUED", startedAt: null, createdAt: new Date(NOW - 10_000) }), ctx)).toBe("running");
  });
});

describe("decide — dispatch", () => {
  it("enqueues the current wave's PENDING targets up to the concurrency, skips gone apps, waits for offline agents within waitOnlineSec", () => {
    const r = rollout({ config: RolloutConfigSchema.parse({ bakeSec: 0, concurrency: 2 }) });
    const ts = [target("a", 0), target("b", 0), target("c", 0), target("d", 0, { appStatus: null }), target("e", 0, { online: false }), target("z", 1)];
    const a = decide(r, ts, NOW, BOOT);
    expect(a.filter((x) => x.type === "enqueue").map((x) => (x as { targetId: string }).targetId)).toEqual(["a", "b"]);
    expect(settles(a)).toEqual([["d", "SKIPPED", "app_gone"]]);
    expect(types(a)).not.toContain("halt");
  });
  it("an offline target is SKIPPED once the wave's wait is over; the next wave is never touched", () => {
    const r = rollout({ waveStartedAt: new Date(NOW - 301_000) });
    const a = decide(r, [target("a", 0, { status: "SUCCEEDED" }), target("e", 0, { online: false }), target("z", 1)], NOW, BOOT);
    expect(settles(a)).toEqual([["e", "SKIPPED", "offline"]]);
    // wave now closed with one pass → advance
    expect(types(a)).toContain("advance_wave");
    expect(a.some((x) => x.type === "enqueue")).toBe(false);
  });
  it("in-flight targets keep the wave open (no verdict, no advance)", () => {
    const a = decide(rollout(), [target("a", 0, { status: "DEPLOYING", deploymentId: "d1", deployment: dep() })], NOW, BOOT);
    expect(a).toEqual([]);
  });
});

describe("decide — settle + wave verdict", () => {
  it("settles terminal deploys; a wave with failures above the tolerance halts (wave_failed)", () => {
    const ts = [
      target("a", 0, { status: "DEPLOYING", deploymentId: "d1", deployment: dep({ status: "SUCCESS" }) }),
      target("b", 0, { status: "DEPLOYING", deploymentId: "d2", deployment: dep({ status: "FAILED", kind: "AUTO_ROLLBACK", exitCode: 3 }) }),
    ];
    const a = decide(rollout(), ts, NOW, BOOT);
    expect(settles(a)).toEqual([
      ["a", "SUCCEEDED", "passed"],
      ["b", "FAILED", "rejected_safe"],
    ]);
    const halt = a.find((x) => x.type === "halt") as Extract<Action, { type: "halt" }>;
    expect(halt.reason).toBe("wave_failed");
    expect(halt.detail).toMatchObject({ wave: 0, failed: ["b"], passed: 1 });
  });
  it("failures within maxFailuresPerWave do not halt; a wave with ZERO passes never advances silently (wave_no_signal)", () => {
    const tolerant = rollout({ config: RolloutConfigSchema.parse({ bakeSec: 0, maxFailuresPerWave: 1 }) });
    const ok = decide(tolerant, [target("a", 0, { status: "SUCCEEDED" }), target("b", 0, { status: "FAILED" })], NOW, BOOT);
    expect(types(ok)).toEqual(["advance_wave"]);
    const none = decide(tolerant, [target("a", 0, { status: "SKIPPED" }), target("b", 0, { status: "FAILED" })], NOW, BOOT);
    expect((none[0] as Extract<Action, { type: "halt" }>).reason).toBe("wave_no_signal");
  });
  it("a queued deploy past the dispatch timeout is cancelled + FAILED (queue_timeout)", () => {
    const a = decide(rollout(), [target("a", 0, { status: "DEPLOYING", deploymentId: "d1", deployment: dep({ status: "QUEUED", startedAt: null, createdAt: new Date(NOW - 2701_000) }) })], NOW, BOOT);
    // conditional action: the engine settles FAILED/queue_timeout only if the cancel still lands
    expect(types(a)).toEqual(["queue_timeout", "halt"]);
    expect(a[0]).toEqual({ type: "queue_timeout", targetId: "a", deploymentId: "d1" });
  });
  it("the last wave completing → complete; an earlier wave → advance_wave", () => {
    expect(types(decide(rollout({ currentWave: 1 }), [target("a", 0, { status: "SUCCEEDED" }), target("b", 1, { status: "SUCCEEDED" })], NOW, BOOT))).toEqual(["complete"]);
    expect(types(decide(rollout(), [target("a", 0, { status: "SUCCEEDED" }), target("b", 1)], NOW, BOOT))).toEqual(["advance_wave"]);
  });
});

describe("decide — fail fast", () => {
  it("once failures exceed the tolerance the rollout halts AT ONCE: pending targets are never enqueued, deploying ones finish and settle while HALTED", () => {
    const ts = [
      target("a", 0, { status: "DEPLOYING", deploymentId: "d1", deployment: dep({ status: "FAILED", exitCode: 1 }) }),
      target("b", 0, { status: "DEPLOYING", deploymentId: "d2", deployment: dep() }),
      target("c", 0),
      target("d", 0),
    ];
    const a = decide(rollout({ config: RolloutConfigSchema.parse({ bakeSec: 0, concurrency: 10 }) }), ts, NOW, BOOT);
    expect(types(a)).toEqual(["settle", "halt"]);
    expect(a.some((x) => x.type === "enqueue")).toBe(false);
    expect((a[1] as Extract<Action, { type: "halt" }>)).toMatchObject({ reason: "wave_failed", detail: { failed: ["a"], passed: 0 } });
  });
  it("an already-FAILED or CANCELLED target in the wave counts against the tolerance before anything new is dispatched", () => {
    const a = decide(rollout(), [target("a", 0, { status: "CANCELLED" }), target("b", 0)], NOW, BOOT);
    expect(types(a)).toEqual(["halt"]);
    const ok = decide(rollout({ config: RolloutConfigSchema.parse({ bakeSec: 0, maxFailuresPerWave: 1 }) }), [target("a", 0, { status: "CANCELLED" }), target("b", 0)], NOW, BOOT);
    expect(types(ok)).toEqual(["enqueue"]);
  });
  it("concurrency across ticks: in-flight DEPLOYING targets occupy slots; a settle in the same tick frees one", () => {
    const r = rollout({ config: RolloutConfigSchema.parse({ bakeSec: 0, concurrency: 2 }) });
    const held = decide(r, [target("a", 0, { status: "DEPLOYING", deploymentId: "d1", deployment: dep() }), target("b", 0, { status: "DEPLOYING", deploymentId: "d2", deployment: dep() }), target("c", 0)], NOW, BOOT);
    expect(held).toEqual([]);
    const freed = decide(r, [target("a", 0, { status: "DEPLOYING", deploymentId: "d1", deployment: dep({ status: "SUCCESS" }) }), target("b", 0, { status: "DEPLOYING", deploymentId: "d2", deployment: dep() }), target("c", 0)], NOW, BOOT);
    expect(types(freed)).toEqual(["settle", "enqueue"]);
  });
});

describe("decide — interrupted deploys (hub restart)", () => {
  it("an interrupted deploy settles FAILED/interrupted and HALTS the rollout — nothing else is dispatched this tick", () => {
    const ts = [
      target("a", 0, { status: "DEPLOYING", deploymentId: "d1", deployment: dep({ status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE }) }),
      target("b", 0),
    ];
    const a = decide(rollout(), ts, NOW, BOOT);
    expect(settles(a)).toEqual([["a", "FAILED", "interrupted"]]);
    expect(types(a)).toEqual(["settle", "halt"]);
    expect((a[1] as Extract<Action, { type: "halt" }>).reason).toBe("interrupted");
  });
  it("a RUNNING row from before this process (reconcile not yet run) is treated the same way", () => {
    const a = decide(rollout(), [target("a", 0, { status: "DEPLOYING", deploymentId: "d1", deployment: dep({ startedAt: new Date(BOOT - 5) }) })], NOW, BOOT);
    expect(types(a)).toEqual(["settle", "halt"]);
  });
});

describe("decide — HALTED", () => {
  it("only records late results; never enqueues, halts or advances", () => {
    const ts = [
      target("a", 0, { status: "DEPLOYING", deploymentId: "d1", deployment: dep({ status: "SUCCESS" }) }),
      target("b", 0),
      target("c", 0, { status: "DEPLOYING", deploymentId: "d3", deployment: dep({ status: "FAILED", exitCode: -1, logs: INTERRUPTED_DEPLOY_NOTE }) }),
    ];
    const a = decide(rollout({ status: "HALTED" }), ts, NOW, BOOT);
    expect(types(a)).toEqual(["settle", "settle"]);
    expect(settles(a)).toEqual([
      ["a", "SUCCEEDED", "passed"],
      ["c", "FAILED", "interrupted"],
    ]);
  });
  it("a CANCELLED rollout still records late results of its in-flight deploys but never dispatches; COMPLETED produces nothing", () => {
    const late = decide(rollout({ status: "CANCELLED" }), [target("a", 0, { status: "DEPLOYING", deploymentId: "d1", deployment: dep({ status: "SUCCESS" }) }), target("b", 0)], NOW, BOOT);
    expect(types(late)).toEqual(["settle"]);
    expect(decide(rollout({ status: "COMPLETED" }), [target("a", 0)], NOW, BOOT)).toEqual([]);
  });
});

describe("decide — bake", () => {
  const baked = (over: Partial<RolloutSnap> = {}) => rollout({ config: RolloutConfigSchema.parse({ bakeSec: 60 }), ...over });
  it("a passed wave starts a bake instead of advancing; during the bake nothing happens; after it, advance", () => {
    const ts = [target("a", 0, { status: "SUCCEEDED", deploymentId: "d1" }), target("b", 1)];
    const start = decide(baked(), ts, NOW, BOOT);
    expect(start).toEqual([{ type: "start_bake", until: new Date(NOW + 60_000) }]);
    expect(decide(baked({ bakeUntil: new Date(NOW + 30_000) }), ts, NOW, BOOT)).toEqual([]);
    expect(types(decide(baked({ bakeUntil: new Date(NOW - 1) }), ts, NOW, BOOT))).toEqual(["advance_wave"]);
  });
  it("a passed app that is no longer RUNNING, went offline, or was superseded by a newer deploy fails the bake", () => {
    const r = baked({ bakeUntil: new Date(NOW + 30_000) });
    const base = { status: "SUCCEEDED" as const, deploymentId: "d1" };
    for (const over of [{ appStatus: "FAILED" }, { online: false }, { superseded: true }]) {
      const a = decide(r, [target("a", 0, { ...base, ...over }), target("b", 1)], NOW, BOOT);
      expect((a[0] as Extract<Action, { type: "halt" }>).reason).toBe("bake_failed");
    }
    // the bake check also runs once more at the end of the window
    const late = decide(baked({ bakeUntil: new Date(NOW - 1) }), [target("a", 0, { ...base, appStatus: "STOPPED" }), target("b", 1)], NOW, BOOT);
    expect((late[0] as Extract<Action, { type: "halt" }>).reason).toBe("bake_failed");
  });
});

describe("rolloutKey", () => {
  it("is unique per rollout × app × attempt (a retry can never collide with the attempt it replaces)", () => {
    expect(rolloutKey("r1", "app1", 1)).toBe("rollout:r1:app1:1");
    expect(rolloutKey("r1", "app1", 2)).not.toBe(rolloutKey("r1", "app1", 1));
  });
});

describe("decide — fleet rollback (ROLLING_BACK)", () => {
  const rb = (over: Partial<RolloutSnap> = {}) => rollout({ status: "ROLLING_BACK", config: RolloutConfigSchema.parse({ bakeSec: 0, concurrency: 2 }), ...over });
  const reverting = (id: string, over: Partial<TargetSnap> = {}) => target(id, 0, { status: "REVERTING", deploymentId: `d-${id}`, ...over });
  it("dispatches reverts for waiting targets up to the concurrency; in-flight rollbacks occupy slots; offline agents wait", () => {
    const a = decide(rb(), [reverting("a"), reverting("b", { rollbackAttempt: 1, rollbackDeploymentId: "rb-b", rollbackDeployment: dep({ kind: "ROLLBACK" }) }), reverting("c"), reverting("d", { online: false }), target("z", 1, { status: "SKIPPED" })], NOW, BOOT);
    expect(types(a)).toEqual(["revert"]);
    expect((a[0] as Extract<Action, { type: "revert" }>).targetId).toBe("a");
  });
  it("judges each ROLLBACK row: SUCCESS → ROLLED_BACK/reverted; FAILED/CANCELLED/orphaned-RUNNING → ROLLBACK_FAILED; a gone app or a busy app past the window fails too", () => {
    const ts = [
      reverting("ok", { rollbackAttempt: 1, rollbackDeploymentId: "r1", rollbackDeployment: dep({ status: "SUCCESS", kind: "ROLLBACK" }) }),
      reverting("bad", { rollbackAttempt: 1, rollbackDeploymentId: "r2", rollbackDeployment: dep({ status: "FAILED", kind: "ROLLBACK", exitCode: 7 }) }),
      reverting("orphan", { rollbackAttempt: 1, rollbackDeploymentId: "r3", rollbackDeployment: dep({ kind: "ROLLBACK", startedAt: new Date(BOOT - 1) }) }),
      reverting("gone", { appStatus: null }),
      // refused as busy at its FIRST try 2701s ago → the busy clock ran out
      reverting("busy", { rollbackDispatchedAt: new Date(NOW - 2701_000) }),
      // offline since the rollback was requested (301s ago) → the offline wait ran out
      reverting("off", { online: false }),
    ];
    const a = decide(rb({ waveStartedAt: new Date(NOW - 301_000) }), ts, NOW, BOOT);
    expect(settles(a)).toEqual([
      ["ok", "ROLLED_BACK", "reverted"],
      ["bad", "ROLLBACK_FAILED", "revert_failed"],
      ["orphan", "ROLLBACK_FAILED", "revert_interrupted"],
      ["gone", "ROLLBACK_FAILED", "app_gone"],
      ["busy", "ROLLBACK_FAILED", "busy_timeout"],
      ["off", "ROLLBACK_FAILED", "offline"],
    ]);
    expect(a.at(-1)).toEqual({ type: "finish_rollback", status: "ROLLBACK_FAILED", reverted: 1, failed: 5 });
  });
  it("a target merely queued behind the throttle never times out; the busy clock starts at its first refusal, not at the request", () => {
    // requested long ago, never tried (throttled) → still dispatched when a slot frees, never busy_timeout
    const late = rb({ waveStartedAt: new Date(NOW - 10 * 3600_000), config: RolloutConfigSchema.parse({ bakeSec: 0, concurrency: 1 }) });
    const a = decide(late, [reverting("a")], NOW, BOOT);
    expect(types(a)).toEqual(["revert"]);
    // first refusal 10 min ago with a 45 min window → keep retrying
    const b = decide(late, [reverting("a", { rollbackDispatchedAt: new Date(NOW - 600_000) })], NOW, BOOT);
    expect(types(b)).toEqual(["revert"]);
  });
  it("an offline target neither takes a slot nor blocks an online one, and waits (no settle) inside waitOnlineSec", () => {
    const r = rb({ config: RolloutConfigSchema.parse({ bakeSec: 0, concurrency: 1 }) });
    expect(decide(r, [reverting("x", { online: false })], NOW, BOOT)).toEqual([]);
    const a = decide(r, [reverting("x", { online: false }), reverting("y")], NOW, BOOT);
    expect(a).toEqual([{ type: "revert", targetId: "y" }]);
  });
  it("finishes ROLLED_BACK only when every revert passed; stays open while any target is still REVERTING", () => {
    const done = decide(rb(), [target("a", 0, { status: "ROLLED_BACK" }), target("b", 0, { status: "SKIPPED" })], NOW, BOOT);
    expect(done).toEqual([{ type: "finish_rollback", status: "ROLLED_BACK", reverted: 1, failed: 0 }]);
    const open = decide(rb(), [target("a", 0, { status: "ROLLED_BACK" }), reverting("b", { rollbackAttempt: 1, rollbackDeploymentId: "r", rollbackDeployment: dep({ kind: "ROLLBACK" }) })], NOW, BOOT);
    expect(open).toEqual([]);
  });
  it("rollbackTargets picks what the rollout moved (SUCCEEDED, hard-FAILED) and separates the ones with no baseline", () => {
    const r = rollbackTargets([
      { id: "a", status: "SUCCEEDED", outcome: "passed", baselineDeploymentId: "b1" },
      { id: "b", status: "FAILED", outcome: "failed", baselineDeploymentId: "b2" },
      { id: "c", status: "FAILED", outcome: "rejected_safe", baselineDeploymentId: "b3" }, // previous version already live
      { id: "d", status: "FAILED", outcome: "interrupted", baselineDeploymentId: "b4" }, // unknown state → operator first
      { id: "e", status: "SUCCEEDED", outcome: "passed", baselineDeploymentId: null },
      { id: "f", status: "PENDING", outcome: null, baselineDeploymentId: null },
      { id: "g", status: "SKIPPED", outcome: "offline", baselineDeploymentId: "b7" },
    ]);
    expect(r).toEqual({ revert: ["a", "b"], noBaseline: ["e"] });
    expect(rollbackKey("r1", "app1", 2)).toBe("rollout:rb:r1:app1:2");
  });
});
