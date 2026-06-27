import { describe, it, expect } from "vitest";
import { scopeByTeam } from "./team-scope";

const items = [{ teamId: "t1", n: 1 }, { teamId: "t2", n: 2 }, { teamId: "t1", n: 3 }];

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
