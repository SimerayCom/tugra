import { describe, it, expect } from "vitest";
import { installPhase } from "./install-progress";

describe("installPhase", () => {
  it("maps RUNNING → running and FAILED → failed", () => {
    expect(installPhase("RUNNING")).toBe("running");
    expect(installPhase("FAILED")).toBe("failed");
  });

  it("treats NEW / STOPPED / null as still installing (keep polling)", () => {
    for (const s of ["NEW", "STOPPED", null, undefined] as const) {
      expect(installPhase(s)).toBe("installing");
    }
  });
});
