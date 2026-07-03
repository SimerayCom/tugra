import { describe, it, expect } from "vitest";
import { navForMode, uiMode, isUiMode } from "./ui-mode";

const NAV: { group: string; items: { key: string; home?: boolean; fleet?: boolean }[] }[] = [
  {
    group: "Monitor",
    items: [
      { key: "home", home: true, fleet: false }, // home-only launcher
      { key: "dashboard" }, // fleet-only command center
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

const keysOf = (groups: typeof NAV) => groups.flatMap((g) => g.items.map((i) => i.key));

describe("navForMode", () => {
  it("keeps everything except home-only items in fleet mode", () => {
    const keys = keysOf(navForMode(NAV, "fleet"));
    expect(keys).toContain("dashboard");
    expect(keys).toContain("servers");
    expect(keys).not.toContain("home"); // home-only, hidden in fleet
  });

  it("keeps only home-flagged items in home mode", () => {
    const keys = keysOf(navForMode(NAV, "home"));
    expect(keys).toEqual(["home", "appStore", "settings"]);
    expect(keys).not.toContain("dashboard");
    expect(keys).not.toContain("servers");
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
