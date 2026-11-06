import { describe, it, expect } from "vitest";
import { containerBadges } from "./container-badges";

describe("containerBadges", () => {
  it("returns no badges for a healthy, running, never-restarted container", () => {
    expect(containerBadges({ status: "running", restartCount: 0, exitCode: 0, oomKilled: false, health: "healthy" })).toEqual([]);
  });

  it("surfaces restart count with the n var, as a warn tone", () => {
    expect(containerBadges({ status: "running", restartCount: 7, exitCode: 0 })).toEqual([
      { key: "restarts", tone: "warn", vars: { n: 7 } },
    ]);
  });

  it("does NOT show an exit badge for a running container even with a non-zero last exit code", () => {
    // ContainerState keeps the last exit code on a container that has since come back up — never paint Exit 137 on it.
    const badges = containerBadges({ status: "running", exitCode: 137, restartCount: 0 });
    expect(badges.find((b) => b.key === "exit")).toBeUndefined();
  });

  it("shows an exit badge with the code when the container is not running", () => {
    expect(containerBadges({ status: "exited", exitCode: 137 })).toEqual([
      { key: "exit", tone: "danger", vars: { code: 137 } },
    ]);
  });

  it("flags OOM kills as danger regardless of run state", () => {
    const badges = containerBadges({ status: "running", oomKilled: true, restartCount: 2 });
    expect(badges).toContainEqual({ key: "oom", tone: "danger" });
    expect(badges).toContainEqual({ key: "restarts", tone: "warn", vars: { n: 2 } });
  });

  it("flags an unhealthy healthcheck (case-insensitive) as warn", () => {
    expect(containerBadges({ status: "running", health: "Unhealthy" })).toContainEqual({ key: "unhealthy", tone: "warn" });
  });

  it("emits no exit badge for a clean exit-0 stopped container, but still flags restarts/oom", () => {
    expect(containerBadges({ status: "exited", exitCode: 0, restartCount: 3, oomKilled: true })).toEqual([
      { key: "restarts", tone: "warn", vars: { n: 3 } },
      { key: "oom", tone: "danger" },
    ]);
  });

  it("treats missing fields as benign (no badges)", () => {
    expect(containerBadges({})).toEqual([]);
  });
});
