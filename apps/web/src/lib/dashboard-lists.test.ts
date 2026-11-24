import { describe, expect, it } from "vitest";
import { limitRows, looksLikeContainerId, projectCards, realHostname, sortServersProblemsFirst, splitEmptyDefaults, teamColor, problemRank } from "./dashboard-lists";
import type { FleetRow } from "./fleet-view";
import type { Project } from "./types";

const row = (name: string, status: string, o: Partial<FleetRow> = {}): FleetRow => ({
  server: { id: name, name, status } as never, sample: null, cpu: null, memPct: null, diskPct: null, net: null, temp: null, gpuUtil: null, gpuTemp: null, battery: null, batteryState: null, stale: false, ...o,
});

describe("limitRows", () => {
  it("caps at the limit and reports the real total", () => {
    const out = limitRows([1, 2, 3, 4, 5, 6, 7, 8, 9], 6);
    expect(out.shown).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.total).toBe(9);
    expect(limitRows([1], 6)).toEqual({ shown: [1], total: 1 });
  });
});

describe("sortServersProblemsFirst", () => {
  it("orders offline, pending, hot/full online, then healthy; alphabetical inside a tier", () => {
    const rows = [row("zeta", "ONLINE"), row("hot", "ONLINE", { cpu: 95 }), row("alpha", "ONLINE"), row("wait", "PENDING"), row("down", "OFFLINE"), row("full", "ONLINE", { diskPct: 91 })];
    expect(sortServersProblemsFirst(rows).map((r) => r.server.name)).toEqual(["down", "wait", "full", "hot", "alpha", "zeta"]);
    expect(problemRank(row("x", "ONLINE", { memPct: 89 }))).toBe(3);
  });
  it("does not mutate its input", () => {
    const rows = [row("b", "ONLINE"), row("a", "OFFLINE")];
    sortServersProblemsFirst(rows);
    expect(rows[0].server.name).toBe("b");
  });
});

describe("realHostname / looksLikeContainerId", () => {
  it("hides a container id, an empty value and a repeat of the display name", () => {
    expect(looksLikeContainerId("7cefb92e6217")).toBe(true);
    expect(looksLikeContainerId("a".repeat(64))).toBe(true);
    expect(looksLikeContainerId("web-01")).toBe(false);
    expect(looksLikeContainerId("cafe")).toBe(false);
    expect(realHostname({ name: "Main", hostname: "27d495d47a83" })).toBeNull();
    expect(realHostname({ name: "Main", hostname: "  " })).toBeNull();
    expect(realHostname({ name: "web-01", hostname: "WEB-01" })).toBeNull();
    expect(realHostname({ name: "Main", hostname: "node-1.example.com" })).toBe("node-1.example.com");
    expect(realHostname({ name: "Main", hostname: null })).toBeNull();
  });
});

describe("teamColor", () => {
  it("is stable per id, spreads across ids and prefers the picked colour", () => {
    expect(teamColor("t1")).toBe(teamColor("t1"));
    expect(teamColor("t1")).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(new Set(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].map((id) => teamColor(id))).size).toBeGreaterThan(1);
    expect(teamColor("t1", "#112233")).toBe("#112233");
  });
});

const proj = (id: string, teamId: string, isDefault: boolean, apps: number, dbs: number, createdAt: string): Project =>
  ({ id, teamId, name: isDefault ? "Default" : id, isDefault, environments: [{ id: `${id}-e`, name: "production", isDefault: true, appCount: apps, dbCount: dbs, createdAt }], role: "OWNER", canWrite: true, iconUpdatedAt: null, createdAt }) as never;

describe("projectCards", () => {
  const teams = [{ id: "t1", name: "Acme", role: "OWNER" as const }, { id: "t2", name: "Beta", role: "OWNER" as const }];
  it("orders by the newest sign of life: an app deploy beats an old project", () => {
    const projects = [proj("old", "t1", false, 1, 0, "2026-01-01T00:00:00Z"), proj("busy", "t2", false, 1, 0, "2026-01-02T00:00:00Z"), proj("new", "t1", false, 0, 0, "2026-06-01T00:00:00Z")];
    const apps = [{ id: "a-busy", projectId: "busy", createdAt: "2026-01-02T00:00:00Z" }, { id: "a-old", projectId: "old", createdAt: "2026-01-01T00:00:00Z" }];
    const out = projectCards(projects, teams, apps, [], [{ appId: "a-busy", createdAt: "2026-11-20T00:00:00Z" }]);
    expect(out.map((c) => c.project.id)).toEqual(["busy", "new", "old"]);
    expect(out[0].team?.name).toBe("Beta");
    expect(out[0].appCount).toBe(1);
  });
  it("joins the team, tolerates an unknown one, and counts databases", () => {
    const out = projectCards([proj("p", "gone", false, 0, 2, "2026-01-01T00:00:00Z")], teams, [], [], []);
    expect(out[0].team).toBeNull();
    expect(out[0].dbCount).toBe(2);
  });
});

describe("splitEmptyDefaults", () => {
  it("separates only the empty default projects", () => {
    const cards = projectCards(
      [proj("d1", "t1", true, 0, 0, "2026-01-01T00:00:00Z"), proj("d2", "t2", true, 2, 0, "2026-01-01T00:00:00Z"), proj("x", "t1", false, 0, 0, "2026-01-01T00:00:00Z")],
      [], [], [], [],
    );
    const { visible, emptyDefaults } = splitEmptyDefaults(cards);
    expect(emptyDefaults.map((c) => c.project.id)).toEqual(["d1"]);
    expect(visible.map((c) => c.project.id).sort()).toEqual(["d2", "x"]);
  });
});
