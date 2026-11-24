import { describe, it, expect } from "vitest";
import { moveTargets } from "./project-move";
import type { Team } from "./types";

const team = (id: string, role: Team["role"]): Team => ({ id, name: id, role });

describe("moveTargets", () => {
  it("offers the other teams the user owns or administers, never the current one or a viewer team", () => {
    const teams = [team("a", "OWNER"), team("b", "ADMIN"), team("c", "VIEWER"), team("d", "OWNER")];
    expect(moveTargets(teams, "a").map((x) => x.id)).toEqual(["b", "d"]);
  });
  it("is empty with a single team", () => {
    expect(moveTargets([team("a", "OWNER")], "a")).toEqual([]);
  });
});
