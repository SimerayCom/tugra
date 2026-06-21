import { describe, it, expect } from "vitest";
import { envOptions } from "./project-options";
import type { Project } from "./types";

const p = (id: string, name: string, envs: { id: string; name: string }[]): Project =>
  ({ id, name, teamId: "t", role: "OWNER", canWrite: true, createdAt: "", environments: envs.map((e) => ({ ...e, appCount: 0, dbCount: 0 })) }) as Project;

describe("envOptions", () => {
  it("flattens projects into 'Project / env' options with ids", () => {
    expect(envOptions([p("p1", "Web", [{ id: "e1", name: "production" }, { id: "e2", name: "staging" }])])).toEqual([
      { value: "e1", label: "Web / production", projectId: "p1" },
      { value: "e2", label: "Web / staging", projectId: "p1" },
    ]);
  });

  it("returns empty for no projects", () => {
    expect(envOptions([])).toEqual([]);
  });
});
