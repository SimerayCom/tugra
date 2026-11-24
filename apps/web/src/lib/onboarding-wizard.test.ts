import { describe, it, expect } from "vitest";
import { STEPS, resolveStep, nextStep, prevStep, isSkippable, stepNumber, TOTAL_STEPS } from "./onboarding-wizard";

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
      for (const s of ["choose-mode", "instance-basics", "email", "security", "add-first-server", "first-workload", "summary", "done"]) {
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
      for (const s of ["choose-mode", "instance-basics", "email", "security", "add-first-server", "first-workload", "summary", "done"] as const) {
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
    expect(nextStep("instance-basics")).toBe("email");
    expect(nextStep("email")).toBe("security");
    expect(nextStep("security")).toBe("add-first-server");
    expect(nextStep("add-first-server")).toBe("first-workload");
    expect(nextStep("first-workload")).toBe("summary");
    expect(nextStep("summary")).toBe("done");
    expect(nextStep("done")).toBe("done");
  });
});

describe("prevStep — back button", () => {
  it("steps back through the flow, so a choice like Fleet/Home can be changed", () => {
    expect(prevStep("instance-basics")).toBe("choose-mode");
    expect(prevStep("email")).toBe("instance-basics");
    expect(prevStep("security")).toBe("email");
    expect(prevStep("add-first-server")).toBe("security");
    expect(prevStep("first-workload")).toBe("add-first-server");
    expect(prevStep("summary")).toBe("first-workload");
    expect(prevStep("create-admin")).toBe("welcome");
  });
  it("has nowhere to go from the start, the post-registration pick, or the end", () => {
    expect(prevStep("welcome")).toBeNull();
    expect(prevStep("choose-mode")).toBeNull(); // the account already exists; going back would re-register
    expect(prevStep("done")).toBeNull();
  });
  it("never returns a step that resolveStep would clamp away for a logged-in owner", () => {
    for (const step of STEPS) {
      const p = prevStep(step);
      if (p && !["welcome", "create-admin"].includes(step)) expect(["welcome", "create-admin"]).not.toContain(p);
    }
  });
});

describe("isSkippable", () => {
  it("only the optional setup steps are skippable", () => {
    for (const s of ["welcome", "create-admin", "choose-mode", "summary", "done"] as const) expect(isSkippable(s)).toBe(false);
    for (const s of ["instance-basics", "email", "security", "add-first-server", "first-workload"] as const) expect(isSkippable(s)).toBe(true);
  });
});

describe("stepNumber / TOTAL_STEPS", () => {
  it("numbers the seven real steps 1..7 and 0 for welcome/choose-mode/done", () => {
    expect(TOTAL_STEPS).toBe(7);
    expect(stepNumber("welcome")).toBe(0);
    expect(stepNumber("choose-mode")).toBe(0); // uncounted interstitial, like welcome
    expect(stepNumber("create-admin")).toBe(1);
    expect(stepNumber("instance-basics")).toBe(2);
    expect(stepNumber("email")).toBe(3);
    expect(stepNumber("security")).toBe(4);
    expect(stepNumber("add-first-server")).toBe(5);
    expect(stepNumber("first-workload")).toBe(6);
    expect(stepNumber("summary")).toBe(7);
    expect(stepNumber("done")).toBe(0);
  });
});
