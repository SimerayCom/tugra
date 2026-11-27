import type { ForeignFleet } from "./foreign-fleet";
import { teamMapViolations } from "./team-map-guard";

const fleet = (): ForeignFleet => ({
  servers: [
    { ref: "s1", team: { ref: "1", name: "Acme" } },
    { ref: "s2", team: { ref: "2", name: "Beta" } },
  ],
  apps: [
    { sourceRef: "a1", name: "web", kind: "git", buildPack: "nixpacks", ports: [], serverRef: "s1", env: [], volumes: [], domains: [] },
    { sourceRef: "a2", name: "api", kind: "git", buildPack: "nixpacks", ports: [], serverRef: "s2", env: [], volumes: [], domains: [] },
    // a project of team 1 running on a server of team 2: the project's team decides
    { sourceRef: "a3", name: "mixed", kind: "git", buildPack: "nixpacks", ports: [], serverRef: "s2", projectRef: "p1", env: [], volumes: [], domains: [] },
  ],
  databases: [{ sourceRef: "d1", name: "db", engine: "POSTGRES", version: "16", serverRef: "s2" }],
  services: [],
  volumes: [],
  sharedEnv: [],
  warnings: [],
  projects: [{ ref: "p1", name: "shop", tags: [], environments: [], team: { ref: "1", name: "Acme" } }],
} as unknown as ForeignFleet);

const all = () => true;

describe("teamMapViolations", () => {
  it("finds nothing without a mapping", () => {
    expect(teamMapViolations(fleet(), undefined, "T1", all)).toEqual({ leftOut: [], wrongTeam: [] });
    expect(teamMapViolations(fleet(), {}, "T1", all)).toEqual({ leftOut: [], wrongTeam: [] });
  });

  it("names the items of a left-out Coolify team, and of a team mapped to another Tugra team than the target's", () => {
    const v = teamMapViolations(fleet(), { "1": "T1", "2": null }, "T1", all);
    expect(v.leftOut.sort()).toEqual(["app:s2:a2", "database:s2:d1"]);
    expect(v.wrongTeam).toEqual([]);
    const w = teamMapViolations(fleet(), { "1": "T1", "2": "T2" }, "T1", all);
    expect(w.wrongTeam.sort()).toEqual(["app:s2:a2", "database:s2:d1"]);
  });

  it("an item's team is its project's, else its server's", () => {
    const v = teamMapViolations(fleet(), { "1": "T1", "2": "T1" }, "T1", all);
    expect(v).toEqual({ leftOut: [], wrongTeam: [] });
    expect(teamMapViolations(fleet(), { "1": null, "2": "T1" }, "T1", all).leftOut.sort()).toEqual(["app:s1:a1", "app:s2:a3"]);
  });

  it("does not judge what places nothing (excluded or skipped) or a team the mapping does not know", () => {
    const only = (ref: string) => ref === "app:s1:a1";
    expect(teamMapViolations(fleet(), { "1": "T1", "2": null }, "T1", only)).toEqual({ leftOut: [], wrongTeam: [] });
    expect(teamMapViolations(fleet(), { "9": null }, "T1", all)).toEqual({ leftOut: [], wrongTeam: [] });
  });
});
