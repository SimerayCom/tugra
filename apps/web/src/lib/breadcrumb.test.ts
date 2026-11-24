import { describe, it, expect } from "vitest";
import { resourceBreadcrumb } from "./breadcrumb";

const base = {
  name: "web-1",
  projectsLabel: "Projects",
  fallbackLabel: "Apps",
  fallbackHref: "/apps",
};

describe("resourceBreadcrumb", () => {
  it("frames an assigned resource as Projects > Project > Environment > resource", () => {
    expect(
      resourceBreadcrumb({ ...base, projectId: "p1", projectName: "Shop", environmentId: "e1", environmentName: "production" }),
    ).toEqual([
      { label: "Projects", href: "/projects" },
      { label: "Shop", href: "/projects/p1" },
      { label: "production", href: "/projects/p1#env-e1" },
      { label: "web-1" },
    ]);
  });

  it("omits the environment crumb when there is none", () => {
    expect(
      resourceBreadcrumb({ ...base, projectId: "p1", projectName: "Shop", environmentId: null, environmentName: null }),
    ).toEqual([
      { label: "Projects", href: "/projects" },
      { label: "Shop", href: "/projects/p1" },
      { label: "web-1" },
    ]);
  });

  it("links the environment crumb to the project when it has no id", () => {
    expect(
      resourceBreadcrumb({ ...base, projectId: "p1", projectName: "Shop", environmentId: null, environmentName: "production" })[2],
    ).toEqual({ label: "production", href: "/projects/p1" });
  });

  it("falls back to the flat list for an unassigned resource", () => {
    expect(
      resourceBreadcrumb({ ...base, projectId: null, projectName: null, environmentId: null, environmentName: null }),
    ).toEqual([
      { label: "Apps", href: "/apps" },
      { label: "web-1" },
    ]);
  });

  it("carries the project colour on the project and environment crumbs only", () => {
    const crumbs = resourceBreadcrumb({ ...base, projectId: "p1", projectName: "Shop", projectColor: "#46a758", environmentId: "e1", environmentName: "production" });
    expect(crumbs.map((c) => c.color)).toEqual([undefined, "#46a758", "#46a758", undefined]);
  });
});
