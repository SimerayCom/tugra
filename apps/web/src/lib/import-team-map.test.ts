import { describe, it, expect } from "vitest";
import { createCount, mapBody, mappingSummary, newTeamName, normTeamName, ownedTeams, startingChoices, suggestTeam, teamMapIssue, type TeamChoice } from "./import-team-map";
import type { ImportPlan, Team } from "./types";

const team = (id: string, name: string, role: Team["role"] = "OWNER"): Team => ({ id, name, role });
const NORTHWIND = { ref: "1", name: "Northwind" };
const ACME = { ref: "2", name: "Acme" };
const LAB = { ref: "3", name: "Şirket Ğ" };
const plan = (teamMap?: Record<string, string | null>): ImportPlan =>
  ({
    sourceKind: "coolify",
    mode: "copy",
    items: [{ itemRef: "app:a:x", kind: "app", name: "x", proposed: {}, risks: [], dependsOn: [] }],
    totals: { apps: 1, databases: 0, volumes: 0, blockers: 0 },
    warnings: [],
    planHash: "a".repeat(32),
    preflight: {
      databases: [],
      services: [],
      appsWithVolumeData: 0,
      hosts: [{ ref: "a", name: "a", team: NORTHWIND }],
      projects: [{ ref: "p1", name: "Web", itemRefs: ["app:a:x"], team: NORTHWIND }, { ref: "p2", name: "Lab", itemRefs: [], team: ACME }, { ref: "p3", name: "L3", itemRefs: [], team: LAB }],
      ...(teamMap ? { teamMap } : {}),
    },
  }) as unknown as ImportPlan;

describe("normTeamName", () => {
  it("ignores case, accents, Turkish i and extra spaces", () => {
    expect(normTeamName("Northwind Labs")).toBe(normTeamName("  northwind   LABS "));
    expect(normTeamName("ÜMİT Labs")).toBe(normTeamName("umit labs"));
    expect(normTeamName("Şirket Ğ")).toBe("sirket g");
    expect(normTeamName("IŞIK")).toBe(normTeamName("ışık"));
    expect(normTeamName("İstanbul")).toBe("istanbul");
  });
});

describe("suggestTeam", () => {
  const teams = [team("t1", "northwind"), team("t2", "Other"), team("t3", "Acme", "ADMIN")];
  it("matches by name among the teams the person owns", () => {
    expect(suggestTeam("Northwind", teams)).toEqual({ teamId: "t1", notOwned: false });
  });
  it("a name only a team the person does not own has is no match, and says so", () => {
    expect(suggestTeam("Acme", teams)).toEqual({ teamId: "", notOwned: true });
  });
  it("no match, and a name two owned teams share is not guessed", () => {
    expect(suggestTeam("Nobody", teams)).toEqual({ teamId: "", notOwned: false });
    expect(suggestTeam("Dup", [team("a", "Dup"), team("b", "dup")]).teamId).toBe("");
  });
  it("only owners count, client members never do", () => {
    expect(ownedTeams([team("a", "A"), team("b", "B", "ADMIN"), { ...team("c", "C"), clientAccess: "view" }]).map((x) => x.id)).toEqual(["a"]);
  });
});

describe("startingChoices", () => {
  const teams = [team("t1", "Northwind"), team("t2", "Other")];
  it("preselects the match by name and leaves a team without one undecided: creating is never preselected", () => {
    const c = startingChoices(plan(), teams);
    expect(c["1"]).toEqual({ kind: "use", teamId: "t1" });
    expect(c["2"]).toEqual({ kind: "none" });
    expect(Object.values(c).some((x) => x.kind === "create")).toBe(false);
  });
  it("starts from a saved mapping while it is still valid, left-out teams included", () => {
    const c = startingChoices(plan({ "1": "t2", "2": null, "3": "gone" }), teams);
    expect(c["1"]).toEqual({ kind: "use", teamId: "t2" });
    expect(c["2"]).toEqual({ kind: "skip" });
    expect(c["3"]).toEqual({ kind: "none" }); // that team is not one the person owns any more
  });
});

describe("what the step still needs", () => {
  const use: TeamChoice = { kind: "use", teamId: "t1" };
  it("blocks while a Coolify team is undecided, or when every one is left out", () => {
    expect(teamMapIssue({ a: use, b: { kind: "none" } })).toBe("undecided");
    expect(teamMapIssue({ a: { kind: "skip" }, b: { kind: "skip" } })).toBe("nothing");
    expect(teamMapIssue({ a: use, b: { kind: "skip" }, c: { kind: "create" } })).toBeNull();
  });
  it("counts the teams Continue will create", () => {
    expect(createCount({ a: use, b: { kind: "create" }, c: { kind: "create" } })).toBe(2);
  });
});

describe("mapBody", () => {
  it("sends ids in ref order: a chosen team, a made team by its new id, null for a team left out", () => {
    expect(mapBody({ "2": { kind: "create" }, "1": { kind: "use", teamId: "t1" }, "3": { kind: "skip" } }, { "2": "new-id" })).toEqual([
      { sourceTeamRef: "1", teamId: "t1" },
      { sourceTeamRef: "2", teamId: "new-id" },
      { sourceTeamRef: "3", teamId: null },
    ]);
  });
  it("never sends a create that was not made, or an undecided team", () => {
    expect(mapBody({ "1": { kind: "create" }, "2": { kind: "none" } })).toEqual([]);
  });
  it("a made team is named like its Coolify team, cut to the allowed length", () => {
    expect(newTeamName("  Northwind ")).toBe("Northwind");
    expect(newTeamName("x".repeat(120))).toHaveLength(80);
  });
});

describe("mappingSummary", () => {
  it("names each mapped pair and skips the teams left out", () => {
    expect(mappingSummary(plan({ "1": "t1", "2": null }), [team("t1", "Northwind")])).toEqual([{ coolify: "Northwind", tugra: "Northwind" }]);
    expect(mappingSummary(plan(), [])).toEqual([]);
  });
});
