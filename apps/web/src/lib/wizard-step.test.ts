import { describe, it, expect } from "vitest";
import { wizardStep } from "./wizard-step";

describe("wizardStep", () => {
  it("maps selection/server state to the current step", () => {
    expect(wizardStep(false, false)).toBe(1); // pick type
    expect(wizardStep(true, false)).toBe(2); // pick server
    expect(wizardStep(true, true)).toBe(3); // configure
  });
});
