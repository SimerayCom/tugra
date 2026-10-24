import { linkRoute, linkRouteReasonText, defaultEnvVar, envSlug, derivedEnvVar, type LinkRouteApp } from "./db-link";

const classic: LinkRouteApp = { clusterId: null, source: "IMAGE", serverId: "s1", hasCustomNetwork: false };

describe("linkRoute", () => {
  it("allows an internal link for a classic, non-compose, same-server app with no custom network", () => {
    expect(linkRoute(classic, { serverId: "s1" })).toEqual({ route: "internal" });
  });

  it("refuses a swarm/cluster app", () => {
    expect(linkRoute({ ...classic, clusterId: "c1" }, { serverId: "s1" })).toEqual({ route: null, reason: "swarm-app" });
  });

  it("refuses a compose app", () => {
    expect(linkRoute({ ...classic, source: "COMPOSE" }, { serverId: "s1" })).toEqual({ route: null, reason: "compose-app" });
  });

  it("refuses an app with a custom --network", () => {
    expect(linkRoute({ ...classic, hasCustomNetwork: true }, { serverId: "s1" })).toEqual({ route: null, reason: "custom-network" });
  });

  it("refuses a database on a different server", () => {
    expect(linkRoute(classic, { serverId: "s2" })).toEqual({ route: null, reason: "cross-server" });
  });

  it("checks cluster first, then compose, then network, then server (precedence is stable)", () => {
    // every ineligibility at once -> the first reason in the chain wins
    expect(linkRoute({ clusterId: "c1", source: "COMPOSE", serverId: "s1", hasCustomNetwork: true }, { serverId: "s2" }))
      .toEqual({ route: null, reason: "swarm-app" });
  });
});

describe("linkRouteReasonText", () => {
  it("has human text for every reason", () => {
    for (const r of ["swarm-app", "compose-app", "custom-network", "cross-server"] as const) {
      expect(linkRouteReasonText(r).length).toBeGreaterThan(0);
    }
  });
});

describe("defaultEnvVar", () => {
  it("maps sql engines to DATABASE_URL and redis-family to REDIS_URL", () => {
    expect(defaultEnvVar("POSTGRES")).toBe("DATABASE_URL");
    expect(defaultEnvVar("MYSQL")).toBe("DATABASE_URL");
    expect(defaultEnvVar("MARIADB")).toBe("DATABASE_URL");
    expect(defaultEnvVar("LIBSQL")).toBe("DATABASE_URL");
    expect(defaultEnvVar("REDIS")).toBe("REDIS_URL");
    expect(defaultEnvVar("KEYDB")).toBe("REDIS_URL");
    expect(defaultEnvVar("DRAGONFLY")).toBe("REDIS_URL");
    expect(defaultEnvVar("MONGO")).toBe("MONGO_URL");
    expect(defaultEnvVar("CLICKHOUSE")).toBe("CLICKHOUSE_URL");
  });
});

describe("envSlug / derivedEnvVar", () => {
  it("upper-snakes a db name into an env-safe prefix", () => {
    expect(envSlug("my-pg 2")).toBe("MY_PG_2");
    expect(envSlug("orders")).toBe("ORDERS");
    expect(envSlug("--weird__name--")).toBe("WEIRD_NAME");
  });

  it("never lets the slug start with a digit, and never yields empty", () => {
    expect(envSlug("9lives")).toBe("DB_9LIVES");
    expect(envSlug("!!!")).toBe("DB");
  });

  it("derives <SLUG>_<DEFAULT> for a collision fallback", () => {
    expect(derivedEnvVar("orders", "POSTGRES")).toBe("ORDERS_DATABASE_URL");
    expect(derivedEnvVar("cache", "REDIS")).toBe("CACHE_REDIS_URL");
  });
});
