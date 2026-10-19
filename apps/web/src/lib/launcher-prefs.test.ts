import { describe, it, expect } from "vitest";
import { togglePin, filterTiles, sortByPins } from "./launcher-prefs";
import type { LauncherTile } from "./launcher";

const tile = (id: string, name = id): LauncherTile =>
  ({ id, name, url: null, status: "RUNNING", phase: "running", linkKind: "none", source: "IMAGE", templateSlug: null, templateLogo: null, exposeMode: "magic", domain: null, tunnelExposed: false, canWrite: true });

describe("togglePin", () => {
  it("adds, then removes, returning a new set each time", () => {
    const a = togglePin(new Set<string>(), "x");
    expect([...a]).toEqual(["x"]);
    const b = togglePin(a, "x");
    expect([...b]).toEqual([]);
    expect(b).not.toBe(a); // new reference → triggers a re-render
  });
});

describe("filterTiles", () => {
  it("filters by name case-insensitively; empty query returns all", () => {
    const list = [tile("a", "Ghost"), tile("b", "Immich"), tile("c", "Nextcloud")];
    expect(filterTiles(list, "GHO").map((t) => t.id)).toEqual(["a"]);
    expect(filterTiles(list, "  ").map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

describe("sortByPins", () => {
  it("floats pinned tiles to the top, preserving order within each group", () => {
    const list = [tile("a"), tile("b"), tile("c"), tile("d")];
    const out = sortByPins(list, new Set(["c", "b"]));
    // pinned (b, c — kept in their original relative order), then the rest (a, d)
    expect(out.map((t) => t.id)).toEqual(["b", "c", "a", "d"]);
  });
  it("is a no-op when nothing is pinned", () => {
    const list = [tile("a"), tile("b")];
    expect(sortByPins(list, new Set()).map((t) => t.id)).toEqual(["a", "b"]);
  });
});
