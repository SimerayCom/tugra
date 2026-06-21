import { describe, it, expect } from "vitest";
import { NAV, DESTS } from "./shell";

describe("sidebar NAV", () => {
  it("defines an icon for every nav item (no bare text entries)", () => {
    for (const group of NAV) {
      for (const item of group.items) {
        expect(item.icon, `${item.key} is missing an icon`).toBeTruthy();
      }
    }
  });

  it("is Projects-centric: Apps/Databases are not top-level nav items", () => {
    const keys = NAV.flatMap((g) => g.items.map((i) => i.key));
    expect(keys).not.toContain("apps");
    expect(keys).not.toContain("databases");
    expect(keys).toContain("projects");
  });
});

describe("command palette destinations", () => {
  it("still exposes Apps and Databases for ⌘K reachability", () => {
    const hrefs = DESTS.map((d) => d.href);
    expect(hrefs).toContain("/apps");
    expect(hrefs).toContain("/databases");
  });
});
