import { describe, it, expect } from "vitest";
import { activeTeamScope, teamScope } from "./import-team";
import type { ImportPlan } from "./types";

const OLGU = { ref: "1", name: "Olgu" };
const OTHER = { ref: "2", name: "Other" };
const plan = (pf: Record<string, unknown> = {}): ImportPlan =>
  ({
    sourceKind: "coolify",
    mode: "copy",
    items: [],
    totals: { apps: 0, databases: 0, volumes: 0, blockers: 0 },
    warnings: [],
    planHash: "a".repeat(32),
    preflight: {
      databases: [],
      services: [],
      appsWithVolumeData: 0,
      sourceTeamRef: "1",
      hosts: [{ ref: "a", name: "a", team: OLGU }, { ref: "b", name: "b", team: OTHER }, { ref: "c", name: "c", team: OTHER }, { ref: "d", name: "d" }],
      projects: [{ ref: "p1", name: "Web", itemRefs: ["app:c:x"], team: OLGU }, { ref: "p2", name: "Lab", itemRefs: ["app:b:y"], team: OTHER }],
      ...pf,
    },
  }) as unknown as ImportPlan;

describe("teamScope", () => {
  it("is the team's own servers plus every server its projects run on, and its projects", () => {
    const s = teamScope(plan())!;
    expect(s.teamName).toBe("Olgu");
    expect([...s.hosts].sort()).toEqual(["a", "c"]);
    expect([...s.projects]).toEqual(["p1"]);
    expect(s).toMatchObject({ hiddenHosts: 2, hiddenProjects: 1, otherTeams: 1 });
  });

  it("does nothing without a picked team, with a single team, or when the picked team is unknown", () => {
    expect(teamScope(plan({ sourceTeamRef: undefined }))).toBeNull();
    expect(teamScope(plan({ sourceTeamRef: "9" }))).toBeNull();
    expect(teamScope(plan({ hosts: [{ ref: "a", team: OLGU }], projects: [{ ref: "p1", name: "Web", itemRefs: ["app:a:x"], team: OLGU }] }))).toBeNull();
    expect(teamScope(null)).toBeNull();
  });

  it("an older hub that names no team on the servers still narrows by the projects", () => {
    const s = teamScope(plan({ hosts: [{ ref: "a" }, { ref: "b" }, { ref: "c" }] }))!;
    expect([...s.hosts]).toEqual(["c"]);
    expect(s.hiddenHosts).toBe(2);
  });

  it("never narrows to nothing: a picked team with no server and no project gives no filter", () => {
    expect(teamScope(plan({ hosts: [{ ref: "b", team: OTHER }], projects: [{ ref: "p2", name: "Lab", itemRefs: ["app:b:y"], team: OTHER }] }))).toBeNull();
  });

  it("activeTeamScope is off while the owner shows every team", () => {
    expect(activeTeamScope(plan(), false)).not.toBeNull();
    expect(activeTeamScope(plan(), true)).toBeNull();
  });
});
