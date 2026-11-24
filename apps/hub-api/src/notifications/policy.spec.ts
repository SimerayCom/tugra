import { buildSummaryCtx, inQuietHours, msUntilQuietEnds, parsePolicy, rateLimitFor, summaryLevel, SERVICE_RATE_LIMITS, type HeldEntry } from "./policy";

const q = (over = {}) => ({ from: "22:00", to: "07:00", tz: "UTC", allowCritical: true, ...over });

describe("parsePolicy", () => {
  it("reads a valid policy", () => {
    expect(parsePolicy({ quietHours: q(), rateLimitPerMin: 10, dedupeWindowSec: 600 })).toEqual({ quietHours: q(), rateLimitPerMin: 10, dedupeWindowSec: 600 });
  });
  it("drops anything malformed instead of throwing", () => {
    expect(parsePolicy(null)).toEqual({});
    expect(parsePolicy("x")).toEqual({});
    expect(parsePolicy({ quietHours: q({ from: "25:00" }), rateLimitPerMin: 0, dedupeWindowSec: -1 })).toEqual({});
    expect(parsePolicy({ quietHours: q({ tz: "Mars/Base" }) })).toEqual({});
    expect(parsePolicy({ quietHours: q({ from: "07:00", to: "07:00" }) })).toEqual({});
  });
  it("allowCritical defaults to true and is only false when set to false", () => {
    expect(parsePolicy({ quietHours: { from: "22:00", to: "07:00", tz: "UTC" } }).quietHours?.allowCritical).toBe(true);
    expect(parsePolicy({ quietHours: q({ allowCritical: false }) }).quietHours?.allowCritical).toBe(false);
  });
});

describe("inQuietHours", () => {
  const at = (iso: string) => new Date(iso);
  it("handles an overnight window", () => {
    expect(inQuietHours(q(), at("2026-11-24T23:30:00Z"))).toBe(true);
    expect(inQuietHours(q(), at("2026-11-25T03:00:00Z"))).toBe(true);
    expect(inQuietHours(q(), at("2026-11-25T07:00:00Z"))).toBe(false); // end is exclusive
    expect(inQuietHours(q(), at("2026-11-25T12:00:00Z"))).toBe(false);
    expect(inQuietHours(q(), at("2026-11-25T22:00:00Z"))).toBe(true); // start is inclusive
  });
  it("handles a same-day window", () => {
    const day = q({ from: "13:00", to: "14:00" });
    expect(inQuietHours(day, at("2026-11-24T13:30:00Z"))).toBe(true);
    expect(inQuietHours(day, at("2026-11-24T14:00:00Z"))).toBe(false);
  });
  it("reads the clock in the channel's zone", () => {
    // 21:00 UTC is midnight in Istanbul (UTC+3, no DST)
    const ist = q({ tz: "Europe/Istanbul" });
    expect(inQuietHours(ist, at("2026-11-24T21:00:00Z"))).toBe(true);
    expect(inQuietHours(ist, at("2026-11-24T12:00:00Z"))).toBe(false);
  });
});

describe("msUntilQuietEnds", () => {
  it("is the time left to the end of the window", () => {
    expect(msUntilQuietEnds(q(), new Date("2026-11-25T05:30:00Z"))).toBe(90 * 60_000);
    expect(msUntilQuietEnds(q(), new Date("2026-11-24T23:00:00Z"))).toBe(8 * 3_600_000);
  });
});

describe("rateLimitFor", () => {
  it("uses the channel override, then the service default, then a fallback", () => {
    expect(rateLimitFor("telegram", { rateLimitPerMin: 5 })).toBe(5);
    expect(rateLimitFor("telegram", {})).toBe(SERVICE_RATE_LIMITS.telegram);
    expect(rateLimitFor("sms", {})).toBeLessThan(rateLimitFor("webhook", {}));
    expect(rateLimitFor("something-new", {})).toBe(60);
  });
});

describe("buildSummaryCtx", () => {
  const e = (title: string, level: HeldEntry["level"]): HeldEntry => ({ type: "x", title, level, at: "2026-11-24T00:00:00Z" });
  it("counts identical titles, worst first", () => {
    const ctx = buildSummaryCtx("quiet", [e("Backup ok", "success"), e("Deploy failed", "failure"), e("Backup ok", "success"), e("Deploy failed", "failure"), e("Deploy failed", "failure")], 5, 0);
    expect(ctx.items).toEqual([
      { title: "Deploy failed", count: 3, level: "failure" },
      { title: "Backup ok", count: 2, level: "success" },
    ]);
    expect(ctx.total).toBe(5);
  });
  it("caps the list and reports how many lines were left out", () => {
    const entries = Array.from({ length: 12 }, (_, i) => e(`t${i}`, "info"));
    const ctx = buildSummaryCtx("rate", entries, 12, 60);
    expect(ctx.items).toHaveLength(8);
    expect(ctx.more).toBe(4);
  });
  it("summaryLevel picks the worst", () => {
    expect(summaryLevel([{ title: "a", count: 1, level: "info" }, { title: "b", count: 1, level: "warning" }])).toBe("warning");
    expect(summaryLevel([])).toBe("success");
  });
});
