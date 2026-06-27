import { describe, it, expect } from "vitest";
import { resourceBreadcrumb } from "./breadcrumb";

const base = {
  name: "web-1",
  projectsLabel: "Projects",
  fallbackLabel: "Apps",
  fallbackHref: "/apps",
};

describe("resourceBreadcrumb", () => {
  it("frames an assigned resource under its project + environment", () => {
    expect(
      resourceBreadcrumb({ ...base, projectId: "p1", projectName: "Shop", environmentName: "production" }),
    ).toEqual([
      { label: "Projects", href: "/projects" },
      { label: "Shop / production", href: "/projects/p1" },
      { label: "web-1" },
    ]);
  });

  it("omits the environment segment-suffix when there is none", () => {
    expect(
      resourceBreadcrumb({ ...base, projectId: "p1", projectName: "Shop", environmentName: null })[1],
    ).toEqual({ label: "Shop", href: "/projects/p1" });
  });

  it("falls back to the flat list for an unassigned resource", () => {
    expect(
      resourceBreadcrumb({ ...base, projectId: null, projectName: null, environmentName: null }),
    ).toEqual([
      { label: "Apps", href: "/apps" },
      { label: "web-1" },
    ]);
  });
});
