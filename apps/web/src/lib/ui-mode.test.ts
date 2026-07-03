import { describe, it, expect } from "vitest";
import { navForMode, uiMode, isUiMode } from "./ui-mode";

const NAV = [
  {
    group: "Monitor",
    items: [
      { key: "dashboard", home: true },
      { key: "uptime" },
    ],
  },
  {
    group: "Resources",
    items: [
      { key: "appStore", home: true },
      { key: "servers" },
      { key: "domains" },
    ],
  },
  {
    group: "Account",
    items: [{ key: "audit" }, { key: "settings", home: true }],
  },
];

describe("navForMode", () => {
  it("returns the full nav unchanged in fleet mode", () => {
    expect(navForMode(NAV, "fleet")).toBe(NAV);
  });

  it("keeps only home-flagged items in home mode", () => {
    const out = navForMode(NAV, "home");
    const keys = out.flatMap((g) => g.items.map((i) => i.key));
    expect(keys).toEqual(["dashboard", "appStore", "settings"]);
    // fleet-only items are gone
    expect(keys).not.toContain("servers");
    expect(keys).not.toContain("audit");
  });

  it("drops groups that become empty in home mode", () => {
    const fleetOnly: { group: string; items: { key: string; home?: boolean }[] }[] = [
      { group: "OnlyFleet", items: [{ key: "x" }, { key: "y" }] },
    ];
    expect(navForMode(fleetOnly, "home")).toEqual([]);
  });
});

describe("uiMode / isUiMode", () => {
  it("accepts valid modes and defaults everything else to fleet", () => {
    expect(isUiMode("home")).toBe(true);
    expect(isUiMode("tablet")).toBe(false);
    expect(uiMode("home")).toBe("home");
    expect(uiMode(undefined)).toBe("fleet");
    expect(uiMode("tablet")).toBe("fleet");
  });
});
