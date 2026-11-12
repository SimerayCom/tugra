import { isValidCron, minCronGapMs } from "./cron";

describe("isValidCron", () => {
  it("accepts valid 5-field expressions (including steps, ranges and names)", () => {
    for (const ok of ["0 3 * * *", "*/5 * * * *", "0 0 1 * *", "15 2 * * MON", "0 9-17 * * 1-5"]) {
      expect(isValidCron(ok)).toBe(true);
    }
  });

  it("rejects out-of-range fields that pass a shape check but crash BullMQ's parser", () => {
    for (const bad of ["0 25 * * *", "60 * * * *", "* * 32 * *", "* * * 13 *", "foo bar baz qux quux"]) {
      expect(isValidCron(bad)).toBe(false);
    }
  });

  it("does not throw on empty or garbage input", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("   ")).toBe(false);
  });
});

describe("minCronGapMs", () => {
  const H = 3_600_000;
  const from = new Date("2026-11-02T00:00:00Z"); // a Monday, fixed so DST does not perturb the samples
  it("returns the SMALLEST gap between consecutive fires (not the average or the max)", () => {
    expect(minCronGapMs("* * * * *", 24, from)).toBe(60_000); // every minute
    expect(minCronGapMs("0 */6 * * *", 24, from)).toBe(6 * H); // every 6h
    expect(minCronGapMs("0 */12 * * *", 24, from)).toBe(12 * H); // every 12h
    expect(minCronGapMs("0 4 * * 0", 8, from)).toBe(7 * 24 * H); // weekly
  });
  it("uses the shortest gap of an irregular schedule (so a burst cron is floored by its tightest spacing)", () => {
    // 03:00 and 03:30 daily → the min gap is 30 minutes, not ~23.5h.
    expect(minCronGapMs("0,30 3 * * *", 24, from)).toBe(30 * 60_000);
  });
  it("returns null for an unparsable expression", () => {
    expect(minCronGapMs("0 25 * * *", 24, from)).toBeNull();
  });
});
