import { decideDeployOutcome, isDispatchPlan } from "./deploy-outcome";

describe("decideDeployOutcome — the one exit-code contract (live path + adoption)", () => {
  const base = { rolling: false, recreate: false, isCompose: false, hadPrev: false };
  it("0 = ok", () => {
    expect(decideDeployOutcome(0, base)).toEqual({ ok: true, rolledBack: false });
    expect(decideDeployOutcome(0, { ...base, isCompose: true })).toEqual({ ok: true, rolledBack: false });
  });
  it("3 = pre-cutover auto-rollback ONLY for rolling/recreate WITH a previous image; otherwise a hard failure", () => {
    expect(decideDeployOutcome(3, { ...base, recreate: true, hadPrev: true })).toEqual({ ok: false, rolledBack: true });
    expect(decideDeployOutcome(3, { ...base, rolling: true, hadPrev: true })).toEqual({ ok: false, rolledBack: true });
    expect(decideDeployOutcome(3, { ...base, recreate: true, hadPrev: false })).toEqual({ ok: false, rolledBack: false }); // first deploy
    expect(decideDeployOutcome(3, { ...base, rolling: true, hadPrev: false })).toEqual({ ok: false, rolledBack: false });
    expect(decideDeployOutcome(3, base)).toEqual({ ok: false, rolledBack: false }); // hard cutover that happens to exit 3
    expect(decideDeployOutcome(3, { ...base, rolling: true, hadPrev: true, isCompose: true })).toEqual({ ok: false, rolledBack: false }); // compose never
  });
  it("4 = post-cutover revert, rolling only (the script already restarted __prev)", () => {
    expect(decideDeployOutcome(4, { ...base, rolling: true })).toEqual({ ok: false, rolledBack: true });
    expect(decideDeployOutcome(4, { ...base, recreate: true, hadPrev: true })).toEqual({ ok: false, rolledBack: false });
    expect(decideDeployOutcome(4, base)).toEqual({ ok: false, rolledBack: false });
  });
  it("anything else = hard failure", () => {
    for (const code of [1, 2, 5, 127, 137, -1]) expect(decideDeployOutcome(code, { ...base, rolling: true, hadPrev: true })).toEqual({ ok: false, rolledBack: false });
  });
  it("isDispatchPlan accepts only the v1 shape", () => {
    expect(isDispatchPlan({ v: 1, rolling: true, recreate: false, isCompose: false, hadPrev: true, isGitCompose: false, gitSourced: true, runTag: "t", registryRef: null, wasRunning: true })).toBe(true);
    expect(isDispatchPlan(null)).toBe(false);
    expect(isDispatchPlan({ v: 2, rolling: true })).toBe(false);
    expect(isDispatchPlan("x")).toBe(false);
  });
});
