import { describe, it, expect } from "vitest";
import { filterTemplates, presentCategories } from "./template-filter";
import type { Template } from "./types";

const T = (slug: string, name: string, category: string, description = ""): Template => ({
  slug,
  name,
  category,
  description,
});

const list: Template[] = [
  T("ghost", "Ghost", "cms", "Publishing platform"),
  T("wikijs", "Wiki.js", "cms", "Modern wiki"),
  T("grafana", "Grafana", "monitoring", "Dashboards"),
  T("umami", "Umami", "analytics", "Privacy-friendly analytics"),
];

describe("filterTemplates", () => {
  it("returns everything for empty query and 'all'", () => {
    expect(filterTemplates(list, "", "all")).toHaveLength(4);
  });

  it("filters by category", () => {
    expect(filterTemplates(list, "", "cms").map((t) => t.slug)).toEqual(["ghost", "wikijs"]);
  });

  it("matches name, description or category, case-insensitively", () => {
    expect(filterTemplates(list, "GHOST", "all").map((t) => t.slug)).toEqual(["ghost"]);
    expect(filterTemplates(list, "privacy", "all").map((t) => t.slug)).toEqual(["umami"]);
    expect(filterTemplates(list, "monitoring", "all").map((t) => t.slug)).toEqual(["grafana"]);
  });

  it("combines query and category", () => {
    expect(filterTemplates(list, "wiki", "cms").map((t) => t.slug)).toEqual(["wikijs"]);
    expect(filterTemplates(list, "grafana", "cms")).toHaveLength(0);
  });
});

describe("presentCategories", () => {
  it("returns only present categories in display order", () => {
    expect(presentCategories(list)).toEqual(["cms", "analytics", "monitoring"]);
  });
});
