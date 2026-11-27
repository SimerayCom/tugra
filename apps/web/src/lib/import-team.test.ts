import { describe, it, expect } from "vitest";
import { activeTeamScope, coolifyTeams, hostTugraTeam, mappedTeamRefs, teamScope } from "./import-team";
import type { ImportPlan } from "./types";

const NORTHWIND = { ref: "1", name: "Northwind" };
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
      hosts: [{ ref: "a", name: "a", team: NORTHWIND }, { ref: "b", name: "b", team: OTHER }, { ref: "c", name: "c", team: OTHER }, { ref: "d", name: "d" }],
      projects: [{ ref: "p1", name: "Web", itemRefs: ["app:c:x"], team: NORTHWIND }, { ref: "p2", name: "Lab", itemRefs: ["app:b:y"], team: OTHER }],
      ...pf,
    },
  }) as unknown as ImportPlan;

describe("teamScope", () => {
  it("is the team's own servers plus every server its projects run on, and its projects", () => {
    const s = teamScope(plan())!;
    expect(s.teamName).toBe("Northwind");
    expect([...s.hosts].sort()).toEqual(["a", "c"]);
    expect([...s.projects]).toEqual(["p1"]);
    expect(s).toMatchObject({ hiddenHosts: 2, hiddenProjects: 1, otherTeams: 1 });
  });

  it("does nothing without a picked team, with a single team, or when the picked team is unknown", () => {
    expect(teamScope(plan({ sourceTeamRef: undefined }))).toBeNull();
    expect(teamScope(plan({ sourceTeamRef: "9" }))).toBeNull();
    expect(teamScope(plan({ hosts: [{ ref: "a", team: NORTHWIND }], projects: [{ ref: "p1", name: "Web", itemRefs: ["app:a:x"], team: NORTHWIND }] }))).toBeNull();
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

describe("with a saved team mapping", () => {
  const item = (itemRef: string, kind = "app") => ({ itemRef, kind, name: itemRef, proposed: {}, risks: [], dependsOn: [] });
  const mapped = (teamMap: Record<string, string | null>, over: Record<string, unknown> = {}): ImportPlan => {
    const p = plan({ sourceTeamRef: undefined, teamMap, ...over });
    return { ...p, items: [item("app:c:x"), item("database:c:d", "database"), item("app:b:y"), item("app:z:q")] } as unknown as ImportPlan;
  };
  const pf = { projects: [{ ref: "p1", name: "Web", itemRefs: ["app:c:x", "database:c:d"], team: NORTHWIND }, { ref: "p2", name: "Lab", itemRefs: ["app:b:y"], team: OTHER }, { ref: "p3", name: "Misc", itemRefs: ["app:z:q"], team: { ref: "3", name: "Third" } }] };

  it("lists every Coolify team with what it holds", () => {
    expect(coolifyTeams(mapped({}, pf)).map((t) => [t.name, t.items, t.projects])).toEqual([["Northwind", 2, 1], ["Other", 1, 1], ["Third", 1, 1]]);
  });

  it("narrows to the mapped teams, counts what is shown against everything, and drops a team left out", () => {
    const p = mapped({ "1": "t1", "2": "t2", "3": null }, pf);
    expect(mappedTeamRefs(p).sort()).toEqual(["1", "2"]);
    const s = teamScope(p)!;
    expect(s.teamRefs).toEqual(["1", "2"]);
    expect(s).toMatchObject({ shownItems: 3, totalItems: 4, otherTeams: 1 });
    expect([...s.projects].sort()).toEqual(["p1", "p2"]);
    expect(s.teams.map((t) => t.name)).toEqual(["Northwind", "Other"]);
  });

  it("the switch picks one mapped team: its own count, and its servers and projects only", () => {
    const p = mapped({ "1": "t1", "2": "t2" }, pf);
    const s = teamScope(p, "1")!;
    expect(s).toMatchObject({ teamName: "Northwind", shownItems: 2, totalItems: 4 });
    expect([...s.projects]).toEqual(["p1"]);
    expect(s.hosts.has("b")).toBe(false);
    // a team that is not mapped cannot be switched to: the mapped teams stay in view
    expect(teamScope(p, "3")!.teamRefs).toEqual(["1", "2"]);
  });

  it("gives no filter when every team is left out, and the saved mapping wins over the connect-screen pick", () => {
    expect(teamScope(mapped({ "1": null, "2": null }, pf))).toBeNull();
    expect(teamScope(mapped({ "2": "t2" }, { ...pf, sourceTeamRef: "1" }))!.teamName).toBe("Other");
  });

  it("a source server must land in the Tugra team its Coolify team was mapped to", () => {
    const p = mapped({ "1": "t1", "2": null }, pf);
    expect(hostTugraTeam(p, "a")).toBe("t1");
    expect(hostTugraTeam(p, "b")).toBeUndefined(); // left out: nothing to enforce
    expect(hostTugraTeam(p, "d")).toBeUndefined(); // no Coolify team on the server
    expect(hostTugraTeam(plan(), "a")).toBeUndefined(); // no mapping saved
  });
});
