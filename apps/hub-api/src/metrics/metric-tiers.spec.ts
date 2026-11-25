import { legacyRetentionNotes, metricTiers, tierFor, HOUR_MS, DAY_MS } from "./metric-tiers";

describe("metric tiers", () => {
  it("defaults: host raw 26 h, container raw 6 h, 1-minute 48 h, 5-minute 28 d", () => {
    expect(metricTiers({})).toEqual({ hostRawMs: 26 * HOUR_MS, containerRawMs: 6 * HOUR_MS, rollup1mMs: 48 * HOUR_MS, rollup5mMs: 28 * DAY_MS });
  });

  it("takes overrides and ignores garbage", () => {
    const t = metricTiers({ METRICS_RAW_RETENTION_HOURS: "48", METRICS_CONTAINER_RAW_RETENTION_HOURS: "x", METRICS_ROLLUP_1M_RETENTION_HOURS: 0, METRICS_ROLLUP_RETENTION_DAYS: "14" });
    expect(t.hostRawMs).toBe(48 * HOUR_MS);
    expect(t.containerRawMs).toBe(48 * HOUR_MS); // garbage -> the fallback, which follows an explicit host value
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

  it("an explicit METRICS_RAW_RETENTION_HOURS keeps covering container raw rows until the container variable is set", () => {
    expect(metricTiers({ METRICS_RAW_RETENTION_HOURS: 168 }).containerRawMs).toBe(168 * HOUR_MS);
    expect(metricTiers({ METRICS_RAW_RETENTION_HOURS: 168, METRICS_CONTAINER_RAW_RETENTION_HOURS: 6 }).containerRawMs).toBe(6 * HOUR_MS);
    expect(metricTiers({ METRICS_RAW_RETENTION_HOURS: "", METRICS_CONTAINER_RAW_RETENTION_HOURS: undefined }).containerRawMs).toBe(6 * HOUR_MS);
  });

  it("boot notes: silent on defaults, one line per legacy variable that was set explicitly", () => {
    expect(legacyRetentionNotes({})).toEqual([]);
    expect(legacyRetentionNotes({ METRICS_RAW_RETENTION_HOURS: "168" })).toEqual([expect.stringContaining("METRICS_CONTAINER_RAW_RETENTION_HOURS")]);
    expect(legacyRetentionNotes({ METRICS_RAW_RETENTION_HOURS: "168", METRICS_CONTAINER_RAW_RETENTION_HOURS: "6" })).toEqual([]);
    const both = legacyRetentionNotes({ METRICS_ROLLUP_RETENTION_DAYS: "90" });
    expect(both).toHaveLength(1);
    expect(both[0]).toContain("5-minute");
  });
});
