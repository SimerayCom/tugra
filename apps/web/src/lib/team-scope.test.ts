import { describe, it, expect } from "vitest";
import { scopeByTeam, defaultTeamId, scopeTeamName } from "./team-scope";

const items = [{ teamId: "t1", n: 1 }, { teamId: "t2", n: 2 }, { teamId: "t1", n: 3 }];

describe("defaultTeamId", () => {
  const teams = [{ id: "t1" }, { id: "t2" }];

  it("keeps the active scope when it is a real team", () => {
    expect(defaultTeamId("t2", teams)).toBe("t2");
  });
  it("falls back to the first team when scope is null (all teams)", () => {
    expect(defaultTeamId(null, teams)).toBe("t1");
  });
  it("falls back to the first team when scope is stale (not in the list)", () => {
    expect(defaultTeamId("gone", teams)).toBe("t1");
  });
  it("returns '' when there are no teams", () => {
    expect(defaultTeamId(null, [])).toBe("");
    expect(defaultTeamId("t1", [])).toBe("");
  });
});

describe("scopeByTeam", () => {
  it("returns everything when no team is active (all teams)", () => {
    expect(scopeByTeam(items, null)).toEqual(items);
  });
  it("filters to the active team", () => {
    expect(scopeByTeam(items, "t1").map((i) => i.n)).toEqual([1, 3]);
  });
  it("returns [] when nothing matches", () => {
    expect(scopeByTeam(items, "t9")).toEqual([]);
  });
});

describe("scopeTeamName", () => {
  const teams = [{ id: "t1", name: "Northwind" }, { id: "t2", name: "Acme" }];
  it("is null with no team picked (all teams)", () => {
    expect(scopeTeamName(teams, null)).toBeNull();
  });
  it("names the picked team", () => {
    expect(scopeTeamName(teams, "t1")).toBe("Northwind");
  });
  it("is null for a scope that is not in the list", () => {
    expect(scopeTeamName(teams, "gone")).toBeNull();
  });
});
