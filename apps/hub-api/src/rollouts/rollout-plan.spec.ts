import { assignWaves, isGatedApp, planWaves, preflightApp, RolloutConfigSchema } from "./rollout-plan";

describe("rollout-plan — config", () => {
  it("applies the defaults and refuses non-increasing or non-terminal steps", () => {
    const d = RolloutConfigSchema.parse({});
    expect(d).toMatchObject({ canary: 1, steps: [25, 50, 100], concurrency: 3, maxFailuresPerWave: 0, bakeSec: 60, dispatchTimeoutSec: 2700, waitOnlineSec: 300, allowUngated: false, noCache: false });
    expect(RolloutConfigSchema.safeParse({ steps: [50, 25, 100] }).success).toBe(false);
    expect(RolloutConfigSchema.safeParse({ steps: [25, 50] }).success).toBe(false);
    expect(RolloutConfigSchema.safeParse({ steps: [100] }).success).toBe(true);
    // the dispatch timeout can never outlive the 6h stale-QUEUED sweep
    expect(RolloutConfigSchema.safeParse({ dispatchTimeoutSec: 6 * 3600 }).success).toBe(false);
    expect(RolloutConfigSchema.safeParse({ concurrency: 11 }).success).toBe(false);
  });
});

describe("rollout-plan — waves", () => {
  const cfg = RolloutConfigSchema.parse({});
  it("canary first, then cumulative steps (ceil), sizes always sum to n", () => {
    expect(planWaves(12, cfg)).toEqual([1, 2, 3, 6]);
    expect(planWaves(1, cfg)).toEqual([1]); // a lone app is its own (and only) wave — no empty canary
    expect(planWaves(2, cfg)).toEqual([1, 1]);
    expect(planWaves(3, cfg)).toEqual([1, 1, 1]);
    expect(planWaves(0, cfg)).toEqual([]);
    for (const n of [1, 2, 3, 5, 7, 12, 50, 199, 200]) {
      const sizes = planWaves(n, cfg);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n);
      expect(sizes.every((s) => s > 0)).toBe(true);
    }
  });
  it("no canary → steps only; custom steps; a 100-only step is one wave after the canary", () => {
    expect(planWaves(10, { canary: 0, steps: [10, 50, 100] })).toEqual([1, 4, 5]);
    expect(planWaves(10, { canary: 2, steps: [100] })).toEqual([2, 8]);
    expect(planWaves(10, { canary: 0, steps: [100] })).toEqual([10]);
  });
  it("assigns wave indexes positionally", () => {
    expect(assignWaves([1, 2, 3])).toEqual([0, 1, 1, 2, 2, 2]);
  });
});

describe("rollout-plan — preflight", () => {
  const app = { clusterId: null, source: "GIT", rollbackOnFailure: true, healthCheckType: null, imagesToKeep: null, autoDeploy: false };
  it("gated = classic pipeline with rollbackOnFailure; compose or no-rollback is ungated", () => {
    expect(isGatedApp(app)).toBe(true);
    expect(isGatedApp({ ...app, source: "COMPOSE" })).toBe(false);
    expect(isGatedApp({ ...app, rollbackOnFailure: false })).toBe(false);
  });
  it("blocks swarm apps, apps already in a live rollout and ungated apps (unless explicitly allowed)", () => {
    expect(preflightApp({ ...app, clusterId: "c1" }, { allowUngated: false, inOtherRollout: false }).blocked).toBe("swarm_unsupported");
    expect(preflightApp(app, { allowUngated: false, inOtherRollout: true }).blocked).toBe("in_other_rollout");
    expect(preflightApp({ ...app, source: "COMPOSE" }, { allowUngated: false, inOtherRollout: false }).blocked).toBe("ungated");
    expect(preflightApp({ ...app, source: "COMPOSE" }, { allowUngated: true, inOtherRollout: false }).blocked).toBeNull();
    expect(preflightApp(app, { allowUngated: false, inOtherRollout: false })).toEqual({ blocked: null, warnings: [] });
  });
  it("warns about a disabled health gate, too few retained images and push-to-deploy interleaving", () => {
    const r = preflightApp({ ...app, healthCheckType: "NONE", imagesToKeep: 1, autoDeploy: true }, { allowUngated: false, inOtherRollout: false });
    expect(r.blocked).toBeNull();
    expect(r.warnings).toEqual(["no_health_gate", "few_images", "auto_deploy_on"]);
  });
});
