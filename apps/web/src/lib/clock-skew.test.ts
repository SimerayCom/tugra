import { describe, it, expect, beforeEach } from "vitest";
import { getClockSkewMs, hubNow, observeServerDate, resetClockSkew } from "./clock-skew";

beforeEach(resetClockSkew);

describe("clock skew", () => {
  it("is zero until measured", () => {
    expect(getClockSkewMs()).toBe(0);
    expect(hubNow(1000)).toBe(1000);
  });

  it("measures a browser that runs behind the hub", () => {
    // hub time 12:00:10 (+0.5 s mid-second); the browser sent at ...00 and received at ...00 + 100 ms, on a clock 5 s behind
    const hub = Date.UTC(2026, 10, 24, 12, 0, 10);
    const sent = hub - 5000 + 0;
    observeServerDate(new Date(hub).toUTCString(), sent, sent + 100);
    expect(getClockSkewMs()).toBeGreaterThan(5400);
    expect(getClockSkewMs()).toBeLessThan(5600);
    expect(hubNow(sent)).toBeGreaterThan(hub);
  });

  it("keeps the first sample and only replaces it with a tighter round trip", () => {
    const hub = Date.UTC(2026, 10, 24, 12, 0, 0);
    expect(observeServerDate(new Date(hub).toUTCString(), 1000, 1200)).toBe(true);
    const first = getClockSkewMs();
    expect(observeServerDate(new Date(hub + 60_000).toUTCString(), 1000, 1900)).toBe(false);
    expect(getClockSkewMs()).toBe(first);
    expect(observeServerDate(new Date(hub).toUTCString(), 1000, 1050)).toBe(true);
  });

  it("ignores a missing or unparsable header and cached (Age) responses", () => {
    expect(observeServerDate(null, 0, 10)).toBe(false);
    expect(observeServerDate("not a date", 0, 10)).toBe(false);
    expect(observeServerDate(new Date().toUTCString(), 0, 10, "30")).toBe(false);
    expect(getClockSkewMs()).toBe(0);
  });
});
