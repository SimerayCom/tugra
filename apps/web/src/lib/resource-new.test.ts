import { describe, it, expect } from "vitest";
import { parseKind, visibleGroups, backTarget, defaultProjectId, defaultEnvId } from "./resource-new";

describe("parseKind", () => {
  it("accepts the three known kinds", () => {
    expect(parseKind("app")).toBe("app");
    expect(parseKind("service")).toBe("service");
    expect(parseKind("database")).toBe("database");
  });
  it("collapses unknown/empty to null", () => {
    expect(parseKind(null)).toBeNull();
    expect(parseKind(undefined)).toBeNull();
    expect(parseKind("")).toBeNull();
    expect(parseKind("APP")).toBeNull();
    expect(parseKind("foo")).toBeNull();
  });
});

describe("visibleGroups", () => {
  it("scopes the catalog to the matching section", () => {
    expect(visibleGroups("app")).toEqual({ app: true, db: false, service: false });
    expect(visibleGroups("database")).toEqual({ app: false, db: true, service: false });
    expect(visibleGroups("service")).toEqual({ app: false, db: false, service: true });
  });
  it("shows everything when no kind", () => {
    expect(visibleGroups(null)).toEqual({ app: true, db: true, service: true });
  });
});

describe("backTarget", () => {
  it("returns the owning project when a project param is present (chips / dashboard / projects list)", () => {
    expect(backTarget({ projectParam: "p1", kind: "app" })).toEqual({ href: "/projects/p1", key: "project" });
    expect(backTarget({ projectParam: "p1", kind: null })).toEqual({ href: "/projects/p1", key: "project" });
  });
  it("returns the typed list when only kind is present (Apps / Databases buttons)", () => {
    expect(backTarget({ projectParam: null, kind: "app" })).toEqual({ href: "/apps", key: "apps" });
    expect(backTarget({ projectParam: null, kind: "service" })).toEqual({ href: "/apps", key: "apps" });
    expect(backTarget({ projectParam: null, kind: "database" })).toEqual({ href: "/databases", key: "databases" });
  });
  it("falls back to projects for the generic +New entry (no params)", () => {
    expect(backTarget({ projectParam: null, kind: null })).toEqual({ href: "/projects", key: "projects" });
    expect(backTarget({ projectParam: undefined, kind: null })).toEqual({ href: "/projects", key: "projects" });
  });
});

describe("defaultProjectId", () => {
  it("prefers the default (isDefault) project over the first", () => {
    expect(
      defaultProjectId([
        { id: "p1", isDefault: false },
        { id: "p2", isDefault: true },
      ]),
    ).toBe("p2");
  });
  it("falls back to the first when none is marked default", () => {
    expect(
      defaultProjectId([
        { id: "p1", isDefault: false },
        { id: "p2", isDefault: false },
      ]),
    ).toBe("p1");
  });
  it("returns '' for an empty list", () => {
    expect(defaultProjectId([])).toBe("");
  });
});

describe("defaultEnvId", () => {
  it("prefers the default (isDefault) environment over the first", () => {
    expect(
      defaultEnvId({
        environments: [
          { id: "e1", isDefault: false },
          { id: "e2", isDefault: true },
        ],
      }),
    ).toBe("e2");
  });
  it("falls back to the first when none is marked default", () => {
    expect(defaultEnvId({ environments: [{ id: "e1", isDefault: false }] })).toBe("e1");
  });
  it("returns '' for an env-less or undefined project", () => {
    expect(defaultEnvId({ environments: [] })).toBe("");
    expect(defaultEnvId(undefined)).toBe("");
  });
});
