import { describe, it, expect } from "vitest";
import { composeServiceOf, friendlyContainer, linkServices, pickDefaultLogContainer } from "./log-container";

const c = (svc: string, state = "running", n = 1) => ({ name: `tugra_ck1abc-${svc}-${n}`, state });

describe("composeServiceOf / friendlyContainer", () => {
  it("extracts the compose service from replica and swarm task names", () => {
    expect(composeServiceOf("tugra_ck1abc-immich-1")).toBe("immich");
    expect(composeServiceOf("tugra_ck1abc-redis-cache-2")).toBe("redis-cache");
    expect(composeServiceOf("tugra_ck1abc-web.2.def456")).toBe("web");
  });
  it("returns null for a bare app container or a custom container name", () => {
    expect(composeServiceOf("tugra_ck1abc")).toBeNull();
    expect(composeServiceOf("immich_machine_learning")).toBeNull();
  });
  it("friendlyContainer keeps the readable name", () => {
    expect(friendlyContainer("tugra_ck1abc-database-1")).toBe("database");
    expect(friendlyContainer("tugra_ck1abc")).toBe("container");
    expect(friendlyContainer("tugra_ck1abc.1.abc789")).toBe("container");
    expect(friendlyContainer("immich_machine_learning")).toBe("immich_machine_learning");
  });
});

describe("linkServices", () => {
  it("collects services from service and port links, in order, without duplicates", () => {
    expect(
      linkServices([
        { kind: "primary", label: null },
        { kind: "service", label: "web" },
        { kind: "port", label: "web:8080" },
        { kind: "port", label: "api:3000" },
        { kind: "alias", label: "x" },
      ]),
    ).toEqual(["web", "api"]);
    expect(linkServices(undefined)).toEqual([]);
  });
});

describe("pickDefaultLogContainer", () => {
  it("returns undefined with no containers", () => {
    expect(pickDefaultLogContainer([])).toBeUndefined();
  });
  it("prefers the service that serves a link over the others", () => {
    const list = [c("database"), c("redis"), c("server"), c("web")];
    expect(pickDefaultLogContainer(list, { appName: "Photos", services: ["web"] })).toBe("tugra_ck1abc-web-1");
  });
  it("falls back to the service named like the app, then one prefixed with the app name", () => {
    expect(pickDefaultLogContainer([c("database"), c("immich"), c("redis")], { appName: "Immich" })).toBe("tugra_ck1abc-immich-1");
    expect(pickDefaultLogContainer([c("database"), c("immich-server"), c("redis")], { appName: "Immich" })).toBe("tugra_ck1abc-immich-server-1");
  });
  it("prefers a running container over an exited one, even a better-named exited one", () => {
    const list = [c("immich", "exited"), c("worker", "running")];
    expect(pickDefaultLogContainer(list, { appName: "Immich" })).toBe("tugra_ck1abc-worker-1");
  });
  it("skips backing services (database, cache) when nothing else identifies the main one", () => {
    expect(pickDefaultLogContainer([c("db"), c("redis"), c("app")], {})).toBe("tugra_ck1abc-app-1");
  });
  it("still picks the first running container when every one is a backing service", () => {
    expect(pickDefaultLogContainer([c("db", "exited"), c("redis"), c("postgres")], {})).toBe("tugra_ck1abc-redis-1");
  });
  it("falls back to the first container when none is running", () => {
    expect(pickDefaultLogContainer([c("a", "exited"), c("b", "exited")], {})).toBe("tugra_ck1abc-a-1");
  });
  it("handles containers with custom names (no service) by taking the first running one", () => {
    expect(pickDefaultLogContainer([{ name: "immich_machine_learning", state: "running" }, { name: "immich_server", state: "running" }], { appName: "Immich" })).toBe("immich_machine_learning");
  });
});
