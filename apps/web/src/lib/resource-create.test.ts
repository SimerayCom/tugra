import { describe, it, expect, beforeEach } from "vitest";
import { soleOnlineServerId, createdHref, readDeployPref, writeDeployPref } from "./resource-create";

describe("soleOnlineServerId", () => {
  it("returns the id only when exactly one server is online", () => {
    expect(soleOnlineServerId([{ id: "a", status: "ONLINE" }])).toBe("a");
    expect(soleOnlineServerId([{ id: "a", status: "ONLINE" }, { id: "b", status: "OFFLINE" }])).toBe("a");
    expect(soleOnlineServerId([{ id: "a", status: "ONLINE" }, { id: "b", status: "ONLINE" }])).toBeNull();
    expect(soleOnlineServerId([{ id: "a", status: "PENDING" }])).toBeNull();
    expect(soleOnlineServerId([])).toBeNull();
  });
});

describe("createdHref", () => {
  it("opens logs for deploying apps and overview for databases", () => {
    expect(createdHref("app", "1", true)).toBe("/apps/1?tab=logs");
    expect(createdHref("app", "1", false)).toBe("/apps/1");
    expect(createdHref("db", "2", true)).toBe("/databases/2");
  });
});

describe("deploy preference", () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });
  it("defaults to true and persists", () => {
    expect(readDeployPref()).toBe(true);
    writeDeployPref(false);
    expect(readDeployPref()).toBe(false);
    writeDeployPref(true);
    expect(readDeployPref()).toBe(true);
  });
});
