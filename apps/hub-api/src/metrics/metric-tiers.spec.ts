import { metricTiers, tierFor, HOUR_MS, DAY_MS } from "./metric-tiers";

describe("metric tiers", () => {
  it("defaults: host raw 26 h, container raw 6 h, 1-minute 48 h, 5-minute 28 d", () => {
    expect(metricTiers({})).toEqual({ hostRawMs: 26 * HOUR_MS, containerRawMs: 6 * HOUR_MS, rollup1mMs: 48 * HOUR_MS, rollup5mMs: 28 * DAY_MS });
  });

  it("takes overrides and ignores garbage", () => {
    const t = metricTiers({ METRICS_RAW_RETENTION_HOURS: "48", METRICS_CONTAINER_RAW_RETENTION_HOURS: "x", METRICS_ROLLUP_1M_RETENTION_HOURS: 0, METRICS_ROLLUP_RETENTION_DAYS: "14" });
    expect(t.hostRawMs).toBe(48 * HOUR_MS);
    expect(t.containerRawMs).toBe(6 * HOUR_MS);
    expect(t.rollup1mMs).toBe(48 * HOUR_MS);
    expect(t.rollup5mMs).toBe(14 * DAY_MS);
  });

  it("serves each chart range from exactly one tier (container)", () => {
    const t = metricTiers({});
    expect(tierFor("container", HOUR_MS, t)).toBe("raw");
    expect(tierFor("container", 6 * HOUR_MS, t)).toBe("raw");
    expect(tierFor("container", 24 * HOUR_MS, t)).toBe("1m");
    expect(tierFor("container", 48 * HOUR_MS, t)).toBe("1m");
    expect(tierFor("container", 7 * DAY_MS, t)).toBe("5m");
    expect(tierFor("container", 30 * DAY_MS, t)).toBe("5m");
  });

  it("host: 24 h is still raw (26 h retained), 7 d is the 5-minute tier", () => {
    const t = metricTiers({});
    expect(tierFor("host", 24 * HOUR_MS, t)).toBe("raw");
    expect(tierFor("host", 7 * DAY_MS, t)).toBe("5m");
  });

  it("a raw retention configured longer than the 1-minute tier is never skipped over", () => {
    const t = metricTiers({ METRICS_RAW_RETENTION_HOURS: 72 });
    expect(tierFor("host", 60 * HOUR_MS, t)).toBe("raw");
    expect(tierFor("host", 80 * HOUR_MS, t)).toBe("5m");
  });
});
