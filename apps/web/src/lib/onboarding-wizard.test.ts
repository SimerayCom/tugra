import { describe, it, expect } from "vitest";
import { STEPS, resolveStep, nextStep, isSkippable, stepNumber, TOTAL_STEPS } from "./onboarding-wizard";

describe("resolveStep — clamp table", () => {
  describe("not logged in (fresh install, bootstrap pending)", () => {
    const ctx = { loggedIn: false };
    it("null / welcome → welcome", () => {
      expect(resolveStep(null, ctx)).toBe("welcome");
      expect(resolveStep("welcome", ctx)).toBe("welcome");
    });
    it("create-admin → create-admin", () => {
      expect(resolveStep("create-admin", ctx)).toBe("create-admin");
    });
    it("any post-bootstrap step clamps BACK to create-admin (cannot skip bootstrap)", () => {
      for (const s of ["choose-mode", "instance-basics", "add-first-server", "first-workload", "done"]) {
        expect(resolveStep(s, ctx)).toBe("create-admin");
      }
    });
    it("garbage / unknown → welcome", () => {
      expect(resolveStep("nope", ctx)).toBe("welcome");
      expect(resolveStep("", ctx)).toBe("welcome");
    });
  });

  describe("logged in (bootstrap done — implies initialized)", () => {
    const ctx = { loggedIn: true };
    it("null → choose-mode (resume point)", () => {
      expect(resolveStep(null, ctx)).toBe("choose-mode");
    });
    it("welcome / create-admin clamp FORWARD to choose-mode (re-register is closed)", () => {
      expect(resolveStep("welcome", ctx)).toBe("choose-mode");
      expect(resolveStep("create-admin", ctx)).toBe("choose-mode");
    });
    it("valid post-bootstrap steps pass through", () => {
      for (const s of ["choose-mode", "instance-basics", "add-first-server", "first-workload", "done"] as const) {
        expect(resolveStep(s, ctx)).toBe(s);
      }
    });
    it("garbage / unknown → choose-mode", () => {
      expect(resolveStep("nope", ctx)).toBe("choose-mode");
    });
  });

  it("EXHAUSTIVE: no (loggedIn × requested) combo ever traps, loops, or skips bootstrap", () => {
    const requests = [null, "", "nope", ...STEPS];
    for (const loggedIn of [true, false]) {
      for (const req of requests) {
        const out = resolveStep(req, { loggedIn });
        // always a valid step
        expect(STEPS).toContain(out);
        // not-logged-in can only ever be on welcome or create-admin (bootstrap unreachable-past)
        if (!loggedIn) expect(["welcome", "create-admin"]).toContain(out);
        // logged-in never lands back on the pre-bootstrap steps
        if (loggedIn) expect(["welcome", "create-admin"]).not.toContain(out);
      }
    }
  });
});

describe("nextStep — linear flow", () => {
  it("advances one step; done is terminal", () => {
    expect(nextStep("welcome")).toBe("create-admin");
    expect(nextStep("create-admin")).toBe("choose-mode");
    expect(nextStep("choose-mode")).toBe("instance-basics");
    expect(nextStep("instance-basics")).toBe("add-first-server");
    expect(nextStep("add-first-server")).toBe("first-workload");
    expect(nextStep("first-workload")).toBe("done");
    expect(nextStep("done")).toBe("done");
  });
});

describe("isSkippable", () => {
  it("only the non-bootstrap steps are skippable", () => {
    expect(isSkippable("welcome")).toBe(false);
    expect(isSkippable("create-admin")).toBe(false);
    expect(isSkippable("choose-mode")).toBe(false);
    expect(isSkippable("instance-basics")).toBe(true);
    expect(isSkippable("add-first-server")).toBe(true);
    expect(isSkippable("first-workload")).toBe(true);
    expect(isSkippable("done")).toBe(false);
  });
});

describe("stepNumber / TOTAL_STEPS", () => {
  it("numbers the four real steps 1..4 and 0 for welcome/choose-mode/done", () => {
    expect(TOTAL_STEPS).toBe(4);
    expect(stepNumber("welcome")).toBe(0);
    expect(stepNumber("choose-mode")).toBe(0); // uncounted interstitial, like welcome
    expect(stepNumber("create-admin")).toBe(1);
    expect(stepNumber("instance-basics")).toBe(2);
    expect(stepNumber("add-first-server")).toBe(3);
    expect(stepNumber("first-workload")).toBe(4);
    expect(stepNumber("done")).toBe(0);
  });
});
