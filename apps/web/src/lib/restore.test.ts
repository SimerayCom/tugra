import { describe, it, expect } from "vitest";
import { compatibleRestoreTargets } from "./restore";
import type { Database } from "./types";

const db = (id: string, engine: string, teamId: string): Database =>
  ({ id, name: id, engine, teamId, serverId: "s", version: "16", environmentId: null, projectId: null, projectName: null, environmentName: null } as unknown as Database);

describe("compatibleRestoreTargets", () => {
  const source = db("A", "POSTGRES", "t1");
  const all = [source, db("B", "POSTGRES", "t1"), db("C", "MYSQL", "t1"), db("D", "POSTGRES", "t2")];

  it("keeps same-engine, same-team databases (excluding the source)", () => {
    expect(compatibleRestoreTargets(all, source).map((d) => d.id)).toEqual(["B"]);
  });
  it("returns [] when nothing is compatible", () => {
    expect(compatibleRestoreTargets([source, db("C", "MYSQL", "t1")], source)).toEqual([]);
  });
});
