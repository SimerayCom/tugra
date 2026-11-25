import { appIdOfContainer, liveContainerOf, reduceHealth, UNKNOWN_HEALTH, CONTAINER_STATE_MAX_AGE_MS, type ContainerStateRow } from "./container-health";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const row = (status: string, health: string | null, ageMs = 1000): ContainerStateRow => ({ status, health, updatedAt: new Date(NOW - ageMs) });

describe("reduceHealth", () => {
  it("gives unknown for no rows, stale rows and exited/dead/paused rows", () => {
    expect(reduceHealth([], "NONE", NOW)).toEqual(UNKNOWN_HEALTH("NONE"));
    expect(reduceHealth([row("running", "healthy", CONTAINER_STATE_MAX_AGE_MS + 1)], "CMD", NOW).state).toBe("unknown");
    expect(reduceHealth([row("exited", null), row("dead", null), row("paused", "healthy")], "HTTP", NOW).state).toBe("unknown");
  });

  it("is worst-of: unhealthy > starting > healthy > none", () => {
    expect(reduceHealth([row("running", null), row("running", "healthy")], "CMD", NOW).state).toBe("healthy");
    expect(reduceHealth([row("running", "healthy"), row("running", "starting")], "CMD", NOW).state).toBe("starting");
    expect(reduceHealth([row("running", "starting"), row("running", "unhealthy"), row("running", "healthy")], "CMD", NOW).state).toBe("unhealthy");
    expect(reduceHealth([row("running", null)], "NONE", NOW).state).toBe("none");
  });

  it("counts restarting as unhealthy and created as starting; an exited init container does not drive health", () => {
    expect(reduceHealth([row("running", null), row("restarting", null)], "NONE", NOW).state).toBe("unhealthy");
    expect(reduceHealth([row("created", null)], "NONE", NOW).state).toBe("starting");
    expect(reduceHealth([row("exited", "unhealthy"), row("running", "healthy")], "CMD", NOW).state).toBe("healthy");
  });

  it("reports the kept container count, the resolved check type and the newest updatedAt", () => {
    const r = reduceHealth([row("running", "healthy", 5000), row("running", "healthy", 2000), row("exited", null, 100)], "CMD", NOW);
    expect(r).toEqual({ state: "healthy", checkType: "CMD", containers: 2, observedAt: new Date(NOW - 2000).toISOString() });
  });
});

describe("container name matching", () => {
  it("parses live app container names and rejects rollout/prev/database containers", () => {
    expect(appIdOfContainer("tugra_abc123")).toBe("abc123");
    expect(appIdOfContainer("tugra_abc123-web-1")).toBe("abc123");
    expect(appIdOfContainer("tugra_abc123.1.xyz")).toBe("abc123");
    expect(appIdOfContainer("tugra_abc123__rollout")).toBeNull();
    expect(appIdOfContainer("tugra_abc123__prev")).toBeNull();
    expect(appIdOfContainer("tugra_db_abc123")).toBeNull();
    expect(appIdOfContainer("tugra_dbv_abc123")).toBeNull();
    expect(appIdOfContainer("other_abc")).toBeNull();
  });

  it("rejects a sibling id prefix and accepts the swarm '.' suffix only when clustered", () => {
    expect(liveContainerOf("abc", false, "tugra_abc")).toBe(true);
    expect(liveContainerOf("abc", false, "tugra_abc-web-1")).toBe(true);
    expect(liveContainerOf("abc", false, "tugra_abcd-web-1")).toBe(false);
    expect(liveContainerOf("abc", false, "tugra_abcd")).toBe(false);
    expect(liveContainerOf("abc", false, "tugra_abc.1.xyz")).toBe(false);
    expect(liveContainerOf("abc", true, "tugra_abc.1.xyz")).toBe(true);
    expect(liveContainerOf("abc", true, "tugra_abc__rollout")).toBe(false);
  });

  it("an adopted stack is matched by its own project name, never by tugra_<id>", () => {
    expect(liveContainerOf("abc", false, "shop-web-1", "shop")).toBe(true);
    expect(liveContainerOf("abc", false, "shop", "shop")).toBe(true);
    expect(liveContainerOf("abc", false, "shopper-web-1", "shop")).toBe(false);
    expect(liveContainerOf("abc", false, "tugra_abc-web-1", "shop")).toBe(false);
  });
});
