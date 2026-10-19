import { describe, it, expect } from "vitest";
import { filterTemplates, presentCategories, groupByCategory } from "./template-filter";
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

  it("matches the curated tagline and tags (CASA-UX-3)", () => {
    const tagged: Template[] = [
      { slug: "immich", name: "Immich", category: "media", description: "", tagline: "Google Photos alternative", tags: ["photos", "backup", "gallery"] },
      { slug: "ghost", name: "Ghost", category: "cms", description: "Publishing platform" },
    ];
    // a tag that appears in neither name nor description
    expect(filterTemplates(tagged, "gallery", "all").map((t) => t.slug)).toEqual(["immich"]);
    // a word only in the tagline
    expect(filterTemplates(tagged, "alternative", "all").map((t) => t.slug)).toEqual(["immich"]);
  });
});

describe("presentCategories", () => {
  it("returns only present categories in display order", () => {
    expect(presentCategories(list)).toEqual(["cms", "analytics", "monitoring"]);
  });
});

describe("groupByCategory", () => {
  it("groups templates by category in display order", () => {
    const groups = groupByCategory(list);
    expect(groups.map((g) => g.category)).toEqual(["cms", "analytics", "monitoring"]);
    expect(groups.find((g) => g.category === "cms")!.items.map((t) => t.slug)).toEqual(["ghost", "wikijs"]);
  });

  it("omits empty categories and every group is non-empty", () => {
    expect(groupByCategory(list).every((g) => g.items.length > 0)).toBe(true);
  });

  it("returns [] for an empty catalog", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});
