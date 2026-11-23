import { gitSourcesUsableBy, sourceUsableBy } from "./source-scope";

describe("git source team scope", () => {
  it("a team uses its own sources and any shared with every team", () => {
    expect(gitSourcesUsableBy("t1")).toEqual({ OR: [{ teamId: "t1" }, { sharedAllTeams: true }] });
    expect(sourceUsableBy({ teamId: "t1" }, "t1")).toBe(true);
    expect(sourceUsableBy({ teamId: "t1", sharedAllTeams: false }, "t2")).toBe(false);
    expect(sourceUsableBy({ teamId: "t1", sharedAllTeams: true }, "t2")).toBe(true);
    expect(sourceUsableBy({ teamId: "t1", sharedAllTeams: null }, "t2")).toBe(false);
  });
});
