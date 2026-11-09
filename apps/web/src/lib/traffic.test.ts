import { describe, it, expect } from "vitest";
import { bucketIntervalMs, countryName, countryShares, errorRatePct, humanizeBytesSeries, trafficIsEmpty } from "./traffic";
import type { TrafficSummary } from "./types";

const summary = (over: Partial<TrafficSummary> = {}): TrafficSummary => ({
  range: "24h", stepSec: 300, times: [], requests: [], s2xx: [], s3xx: [], s4xx: [], s5xx: [], bytes: [],
  totals: { requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 0 },
  ...over,
});

describe("countryShares", () => {
  it("divides by the SUM of the returned countries, not by any total request count", () => {
    const out = countryShares([{ country: "US", requests: 60 }, { country: "DE", requests: 30 }, { country: "ZZ", requests: 10 }]);
    expect(out.map((r) => r.pct)).toEqual([60, 30, 10]);
    expect(out.reduce((n, r) => n + r.pct, 0)).toBeCloseTo(100);
  });
  it("never yields NaN for an empty / all-zero set", () => {
    expect(countryShares([])).toEqual([]);
    expect(countryShares([{ country: "US", requests: 0 }])).toEqual([]);
  });
});

describe("countryName", () => {
  it("resolves a valid code to a localized name", () => {
    expect(countryName("US", "en")).toBe("United States");
    expect(countryName("de", "en")).toBe("Germany");
  });
  it("returns null (never throws) for ZZ, malformed and unknown codes or a bad locale", () => {
    expect(countryName("ZZ", "en")).toBeNull();
    expect(countryName("", "en")).toBeNull();
    expect(countryName("USA", "en")).toBeNull();
    expect(countryName("1!", "en")).toBeNull();
    expect(countryName("US", "not a locale!!")).toBeNull();
  });
});

describe("humanizeBytesSeries", () => {
  it("scales by the peak into one unit", () => {
    expect(humanizeBytesSeries([0, 1024 * 1024, 2 * 1024 * 1024])).toEqual({ data: [0, 1, 2], unit: "MB" });
  });
  it("keeps an idle or empty series in bytes", () => {
    expect(humanizeBytesSeries([5, 10])).toEqual({ data: [5, 10], unit: "B" });
    expect(humanizeBytesSeries([]).unit).toBe("B");
  });
});

describe("misc", () => {
  it("bucketIntervalMs converts stepSec and ignores bad input", () => {
    expect(bucketIntervalMs(summary())).toBe(300_000);
    expect(bucketIntervalMs(summary({ stepSec: 0 }))).toBeUndefined();
    expect(bucketIntervalMs(undefined)).toBeUndefined();
  });
  it("errorRatePct is 0 without requests", () => {
    expect(errorRatePct({ requests: 0, s4xx: 0, s5xx: 0 })).toBe(0);
    expect(errorRatePct({ requests: 200, s4xx: 10, s5xx: 10 })).toBe(10);
  });
  it("trafficIsEmpty only when nothing at all is returned", () => {
    expect(trafficIsEmpty(summary(), { paths: [], other: { requests: 0 } }, { countries: [] })).toBe(true);
    expect(trafficIsEmpty(undefined, undefined, undefined)).toBe(true);
    expect(trafficIsEmpty(summary({ totals: { requests: 3, s2xx: 3, s3xx: 0, s4xx: 0, s5xx: 0, bytes: 1 } }), undefined, undefined)).toBe(false);
    expect(trafficIsEmpty(summary(), { paths: [{}], other: { requests: 0 } }, { countries: [] })).toBe(false);
  });
});
