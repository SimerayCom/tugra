import { matchesQuery, filterByQuery } from "./query-filter";

describe("query-filter", () => {
  describe("matchesQuery", () => {
    it("matches a case-insensitive substring in any field", () => {
      expect(matchesQuery("API", ["my-api-server", null])).toBe(true);
      expect(matchesQuery("api", ["other", "Prod API"])).toBe(true);
    });
    it("does not match when no field contains the needle", () => {
      expect(matchesQuery("redis", ["postgres-db", "mysql", null, undefined])).toBe(false);
    });
    it("blank/whitespace q matches everything (no filter)", () => {
      expect(matchesQuery("", ["anything"])).toBe(true);
      expect(matchesQuery("   ", ["anything"])).toBe(true);
    });
    it("ignores null/undefined/non-string fields safely", () => {
      expect(matchesQuery("x", [null, undefined])).toBe(false);
      expect(matchesQuery("x", [])).toBe(false);
    });
    it("trims the needle before matching", () => {
      expect(matchesQuery("  web  ", ["my-web-app"])).toBe(true);
    });
  });

  describe("filterByQuery", () => {
    const items = [
      { name: "web", image: "nginx" },
      { name: "db", image: "postgres" },
      { name: "cache", image: "redis" },
    ];
    const pick = (i: { name: string; image: string }) => [i.name, i.image];

    it("returns the array UNCHANGED (same reference) when q is undefined — non-breaking", () => {
      expect(filterByQuery(items, undefined, pick)).toBe(items);
    });
    it("returns the array unchanged when q is blank", () => {
      expect(filterByQuery(items, "   ", pick)).toBe(items);
    });
    it("filters by substring across the picked fields", () => {
      expect(filterByQuery(items, "post", pick).map((i) => i.name)).toEqual(["db"]);
      expect(filterByQuery(items, "redis", pick).map((i) => i.name)).toEqual(["cache"]);
      // matches on EITHER field: "s" appears in postgres + redis images → db + cache.
      expect(filterByQuery(items, "s", pick).map((i) => i.name)).toEqual(["db", "cache"]);
    });
    it("returns [] when nothing matches", () => {
      expect(filterByQuery(items, "zzz", pick)).toEqual([]);
    });
    it("treats a non-string q (array/object from Express) as no-filter — never throws a 500", () => {
      // `?q=a&q=b` → ["a","b"]; `?q[x]=1` → {x:"1"}. Must not crash on `.trim()`.
      expect(filterByQuery(items, ["a", "b"] as unknown, pick)).toBe(items);
      expect(filterByQuery(items, { x: "1" } as unknown, pick)).toBe(items);
      expect(filterByQuery(items, 123 as unknown, pick)).toBe(items);
    });
  });
});
