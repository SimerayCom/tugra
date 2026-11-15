import { describe, it, expect } from "vitest";
import { sortApps, sortProjects, toggleSort, defaultProjectSortDir, projectResourceCount } from "./list-sort";

const app = (name: string, status: string, projectName: string | null = null, environmentName: string | null = null) => ({ name, status, projectName, environmentName }) as never;
const names = (xs: { name: string }[]) => xs.map((x) => x.name);

describe("toggleSort", () => {
  it("starts at the default direction, then flips on the same key", () => {
    const a = toggleSort(null, "name", "asc");
    expect(a).toEqual({ key: "name", dir: "asc" });
    expect(toggleSort(a, "name")).toEqual({ key: "name", dir: "desc" });
    expect(toggleSort({ key: "name", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
    expect(toggleSort(a, "status", "desc")).toEqual({ key: "status", dir: "desc" });
  });
});

describe("sortApps", () => {
  const apps = [app("web-10", "RUNNING", "Zed", "prod"), app("web-2", "FAILED", "Alpha", "prod"), app("Api", "STOPPED"), app("db", "NEW", "Alpha", "dev")];
  it("sorts by name, natural + case-insensitive", () => {
    expect(names(sortApps(apps, "name", "asc"))).toEqual(["Api", "db", "web-2", "web-10"]);
    expect(names(sortApps(apps, "name", "desc"))).toEqual(["web-10", "web-2", "db", "Api"]);
  });
  it("sorts problems first by status, keeping the incoming order on ties", () => {
    expect(names(sortApps(apps, "status", "asc"))).toEqual(["web-2", "db", "Api", "web-10"]);
  });
  it("sorts by project / environment and always sinks apps without a project", () => {
    expect(names(sortApps(apps, "project", "asc"))).toEqual(["db", "web-2", "web-10", "Api"]);
    expect(names(sortApps(apps, "project", "desc"))).toEqual(["web-10", "web-2", "db", "Api"]);
  });
  it("does not mutate its input", () => {
    const copy = [...apps];
    sortApps(apps, "name", "asc");
    expect(apps).toEqual(copy);
  });
});

describe("sortProjects", () => {
  const env = (appCount: number, dbCount: number) => ({ appCount, dbCount });
  const p = (name: string, createdAt: string, envs: { appCount: number; dbCount: number }[]) => ({ name, createdAt, environments: envs }) as never;
  const projects = [p("beta", "2026-01-02T00:00:00Z", [env(1, 0)]), p("alpha", "2026-03-01T00:00:00Z", [env(2, 3), env(1, 1)]), p("gamma", "2026-02-01T00:00:00Z", [])];
  it("counts apps + databases across environments", () => {
    expect(projectResourceCount(projects[1])).toBe(7);
  });
  it("sorts by name, resources and created", () => {
    expect(names(sortProjects(projects, "name", "asc"))).toEqual(["alpha", "beta", "gamma"]);
    expect(names(sortProjects(projects, "resources", defaultProjectSortDir("resources")))).toEqual(["alpha", "beta", "gamma"]);
    expect(names(sortProjects(projects, "created", "desc"))).toEqual(["alpha", "gamma", "beta"]);
    expect(names(sortProjects(projects, "created", "asc"))).toEqual(["beta", "gamma", "alpha"]);
  });
});
