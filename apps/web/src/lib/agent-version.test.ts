import { describe, it, expect } from "vitest";
import { agentVersionState, compareVersions } from "./agent-version";

describe("compareVersions", () => {
  it("orders prerelease numbers numerically, not as text", () => {
    expect(compareVersions("0.1.0-beta.9", "0.1.0-beta.27")).toBe(-1);
    expect(compareVersions("v0.1.0-beta.27", "0.1.0-beta.27")).toBe(0);
    expect(compareVersions("0.1.0-beta.28", "0.1.0-beta.27")).toBe(1);
  });
  it("sorts a prerelease before its release and core numbers before prereleases", () => {
    expect(compareVersions("0.1.0-beta.27", "0.1.0")).toBe(-1);
    expect(compareVersions("0.2.0-beta.1", "0.1.9")).toBe(1);
  });
  it("returns null for non-versions", () => {
    expect(compareVersions("dev", "0.1.0")).toBeNull();
  });
});

describe("agentVersionState", () => {
  it("is outdated only when the agent is strictly older than the target", () => {
    expect(agentVersionState("0.1.0-beta.26", "0.1.0-beta.27")).toBe("outdated");
    expect(agentVersionState("0.1.0-beta.27", "0.1.0-beta.27")).toBe("current");
    expect(agentVersionState("0.1.0-beta.28", "0.1.0-beta.27")).toBe("current");
  });
  it("is unknown without a version on either side", () => {
    expect(agentVersionState(null, "0.1.0")).toBe("unknown");
    expect(agentVersionState("0.1.0", null)).toBe("unknown");
    expect(agentVersionState("weird", "0.1.0")).toBe("unknown");
  });
});
