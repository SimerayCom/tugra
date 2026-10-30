import { describe, it, expect } from "vitest";
import { fuzzyMatch, scoreItem, searchPalette, flatten, highlightParts, buildResourceItems, type PaletteItem } from "./command-search";
import type { Application, ServerView, Database, DomainView } from "./types";

const item = (over: Partial<PaletteItem>): PaletteItem => ({ id: "x", group: "apps", label: "x", href: "/x", ...over });

describe("fuzzyMatch", () => {
  it("empty query matches with score 0; non-subsequence is null", () => {
    expect(fuzzyMatch("", "Apps")).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch("xyz", "Apps")).toBeNull();
    expect(fuzzyMatch("appss", "Apps")).toBeNull(); // longer than text
  });
  it("is case-insensitive and whitespace in the query is ignored", () => {
    expect(fuzzyMatch("AP", "apps")).not.toBeNull();
    expect(fuzzyMatch("a p", "apps")).not.toBeNull();
  });
  it("picks word-start characters for an acronym ('ghb' → GitHub blog at 0,3,7)", () => {
    expect(fuzzyMatch("ghb", "GitHub blog")!.indices).toEqual([0, 3, 7]);
  });
  it("prefix outranks a mid-word match", () => {
    expect(fuzzyMatch("app", "Apps")!.score).toBeGreaterThan(fuzzyMatch("app", "Happy pap")!.score);
  });
  it("consecutive outranks scattered (no word-start confound)", () => {
    expect(fuzzyMatch("abc", "abcxx")!.score).toBeGreaterThan(fuzzyMatch("abc", "axbxc")!.score);
  });
  it("exact-case + exact match beat a case-differing one", () => {
    expect(fuzzyMatch("Apps", "Apps")!.score).toBeGreaterThan(fuzzyMatch("apps", "Apps")!.score);
  });
});

describe("scoreItem + searchPalette", () => {
  it("a label match outranks a secondary-only match of the same text", () => {
    const onLabel = scoreItem(item({ label: "postgres" }), "postgres")!.score;
    const onSecondary = scoreItem(item({ label: "shop", secondary: "postgres" }), "postgres")!.score;
    expect(onLabel).toBeGreaterThan(onSecondary);
  });
  it("multi-term AND: every term must match label or secondary", () => {
    const it1 = item({ label: "orders", secondary: "prod postgres 16" });
    expect(scoreItem(it1, "prod pg")).not.toBeNull(); // prod→secondary, pg→postgres(secondary)
    expect(scoreItem(it1, "prod zzz")).toBeNull(); // zzz matches nothing
  });
  it("drops non-matches and omits empty groups", () => {
    const groups = searchPalette([item({ id: "a", label: "Apache" }), item({ id: "b", group: "servers", label: "box" })], "apa");
    expect(groups).toHaveLength(1);
    expect(groups[0].group).toBe("apps");
  });
  it("caps a group at 6 and reports the pre-cap total", () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ id: "a" + i, label: "app" + i }));
    const g = searchPalette(many, "app")[0];
    expect(g.items).toHaveLength(6);
    expect(g.total).toBe(9);
  });
  it("empty query → original order, nav/actions uncapped, resources capped at 3", () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => item({ id: "n" + i, group: "navigate", label: "Nav" + i })),
      ...Array.from({ length: 5 }, (_, i) => item({ id: "a" + i, group: "apps", label: "App" + i })),
    ];
    const groups = searchPalette(items, "");
    expect(groups.find((g) => g.group === "navigate")!.items).toHaveLength(5);
    expect(groups.find((g) => g.group === "apps")!.items).toHaveLength(3);
  });
  it("actions/navigate get a tie-boost over resources", () => {
    const groups = searchPalette([item({ id: "r", group: "apps", label: "new" }), item({ id: "a", group: "actions", label: "new" })], "new");
    expect(flatten(groups)[0].item.id).toBe("a"); // action first
  });
});

describe("flatten + highlightParts", () => {
  it("flatten order equals render order", () => {
    const groups = searchPalette([item({ id: "a", group: "actions", label: "New" }), item({ id: "p", group: "apps", label: "New app" })], "new");
    const flat = flatten(groups);
    expect(flat.map((r) => r.item.id)).toEqual(["a", "p"]);
  });
  it("merges adjacent matched indices into runs", () => {
    expect(highlightParts("Apps", [0, 1])).toEqual([{ s: "Ap", hit: true }, { s: "ps", hit: false }]);
    expect(highlightParts("Apps", [])).toEqual([{ s: "Apps", hit: false }]);
  });
});

describe("buildResourceItems", () => {
  const apps = [{ id: "a1", name: "Shop", teamId: "t1", status: "RUNNING", domain: "shop.io", projectName: "store", environmentName: "prod" }] as unknown as Application[];
  const servers = [{ id: "s1", name: "box", teamId: "t1", status: "ONLINE", hostname: "h", publicIp: "1.2.3.4", clusterName: null }] as unknown as ServerView[];
  const databases = [{ id: "d1", name: "pg", teamId: "t2", status: "RUNNING", engine: "POSTGRES", version: "16", projectName: null, environmentName: null }] as unknown as Database[];
  const domains = [{ id: "dm1", appId: "a1", teamId: "t1", name: "Shop", domain: "www.shop.io" }] as unknown as DomainView[];

  it("deep-links each type and gives unique ids", () => {
    const items = buildResourceItems({ apps, servers, databases, domains }, null);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId["app:a1"].href).toBe("/apps/a1");
    expect(byId["srv:s1"].href).toBe("/servers/s1");
    expect(byId["db:d1"].href).toBe("/databases/d1");
    expect(byId["dom:dm1"].href).toBe("/apps/a1"); // domain → its app
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
  it("honours team scope (null = all teams)", () => {
    expect(buildResourceItems({ apps, servers, databases, domains }, "t1").some((i) => i.id === "db:d1")).toBe(false); // d1 is team t2
    expect(buildResourceItems({ apps, servers, databases, domains }, null).some((i) => i.id === "db:d1")).toBe(true);
  });
});
