import { describe, it, expect } from "vitest";
import { appColor, deploymentColor } from "./apps";

describe("app helpers", () => {
  it("maps app status to a color", () => {
    expect(appColor("RUNNING")).toContain("--c-g");
    expect(appColor("FAILED")).toContain("--c-r");
    expect(appColor("STOPPED")).toContain("--c-am");
    expect(appColor("NEW")).toContain("--c-tx3");
  });

  it("maps deployment status to a color", () => {
    expect(deploymentColor("SUCCESS")).toContain("--c-g");
    expect(deploymentColor("FAILED")).toContain("--c-r");
    expect(deploymentColor("RUNNING")).toContain("--c-am");
  });
});
