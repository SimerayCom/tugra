import { describe, it, expect } from "vitest";
import { showTeamContext, groupByTeam, teamCrumb } from "./team-context";

describe("showTeamContext", () => {
  it("shows the team only in the All-teams view of a multi-team account", () => {
    expect(showTeamContext(null, 3)).toBe(true);
    expect(showTeamContext("t1", 3)).toBe(false); // one team selected
    expect(showTeamContext(null, 1)).toBe(false); // only one team exists
    expect(showTeamContext(null, 0)).toBe(false);
  });
});

describe("groupByTeam", () => {
  const teams = [
    { id: "t2", name: "Zed" },
    { id: "t1", name: "Acme" },
  ];
  it("groups by team in team-name order and keeps item order inside a group", () => {
    const items = [
      { id: "a", teamId: "t2" },
      { id: "b", teamId: "t1" },
      { id: "c", teamId: "t2" },
    ];
    const g = groupByTeam(items, teams);
    expect(g.map((x) => x.name)).toEqual(["Acme", "Zed"]);
    expect(g[1].items.map((i) => i.id)).toEqual(["a", "c"]);
  });
  it("keeps items of an unknown team, after the named teams", () => {
    const g = groupByTeam([{ id: "x", teamId: "gone" }, { id: "y", teamId: "t1" }], teams);
    expect(g.map((x) => x.teamId)).toEqual(["t1", "gone"]);
    expect(g[1].team).toBeUndefined();
  });
});

describe("teamCrumb", () => {
  it("uses the picked colour first and the stable fallback otherwise", () => {
    expect(teamCrumb({ id: "t1", name: "Acme", color: "#112233" }, "/projects")).toEqual({ label: "Acme", href: "/projects", color: "#112233" });
    expect(teamCrumb({ id: "t1", name: "Acme" }, "/projects")?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(teamCrumb(undefined, "/projects")).toBeNull();
  });
});
