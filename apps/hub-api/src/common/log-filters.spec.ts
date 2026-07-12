import { normalizeSince, normalizeSearch, clampTail } from "./log-filters";

describe("normalizeSince", () => {
  it("accepts relative windows", () => {
    for (const s of ["30s", "5m", "1h", "2d", "120m"]) expect(normalizeSince(s)).toBe(s);
  });
  it("drops 'all', empty, and anything malformed to ''", () => {
    for (const s of [undefined, "", "all", "1", "1x", "-5m", "1h ago", "'; rm -rf", "1h; ls"]) {
      expect(normalizeSince(s)).toBe("");
    }
  });
});

describe("normalizeSearch", () => {
  it("accepts a bounded alphanumeric/._- term", () => {
    expect(normalizeSearch("Error 500")).toBe("Error 500");
    expect(normalizeSearch("db-conn_1.2")).toBe("db-conn_1.2");
  });
  it("drops shell/regex metacharacters and over-long input to ''", () => {
    for (const s of [undefined, "", "$(whoami)", "a|b", "a;b", "`id`", "a\nb", "a\ty", "x".repeat(201)]) {
      expect(normalizeSearch(s)).toBe("");
    }
  });
});

describe("clampTail", () => {
  it("clamps into [1, max] and floors", () => {
    expect(clampTail(500)).toBe(500);
    expect(clampTail(0)).toBe(1);
    expect(clampTail(99999)).toBe(2000);
    expect(clampTail(150.9)).toBe(150);
    expect(clampTail(50, 10000)).toBe(50);
    expect(clampTail(50000, 10000)).toBe(10000);
  });
  it("defaults a non-finite/missing value", () => {
    expect(clampTail(undefined)).toBe(200);
    expect(clampTail(NaN)).toBe(200);
  });
});
