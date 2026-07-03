import { describe, it, expect } from "vitest";
import { NAV, DESTS } from "./shell";
import { navForMode } from "../lib/ui-mode";

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

describe("home mode nav", () => {
  it("shows only Home, App Store and Settings in home mode", () => {
    const keys = navForMode(NAV, "home").flatMap((g) => g.items.map((i) => i.key));
    expect(keys).toEqual(["home", "appStore", "settings"]);
  });

  it("shows the fleet command center (not the home launcher) in fleet mode", () => {
    const keys = navForMode(NAV, "fleet").flatMap((g) => g.items.map((i) => i.key));
    expect(keys).toContain("dashboard");
    expect(keys).toContain("servers");
    expect(keys).not.toContain("home");
  });
});

describe("command palette destinations", () => {
  it("still exposes Apps and Databases for ⌘K reachability", () => {
    const hrefs = DESTS.map((d) => d.href);
    expect(hrefs).toContain("/apps");
    expect(hrefs).toContain("/databases");
  });
});
