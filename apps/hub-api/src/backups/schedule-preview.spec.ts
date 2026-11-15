import { previewSchedule, SchedulePreviewQuerySchema } from "./schedule-preview.controller";

const from = new Date("2026-11-15T12:00:00Z");

describe("previewSchedule", () => {
  it("returns the next runs, the tightest gap and the hub timezone for a valid cron", () => {
    const p = previewSchedule("0 3 * * *", undefined, from);
    expect(p.valid).toBe(true);
    expect(p.nextRuns).toHaveLength(3); // default count
    expect(p.minGapSeconds).toBe(86_400);
    expect(p.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(new Date(p.nextRuns[0]).getTime()).toBeGreaterThan(from.getTime());
  });

  it("an invalid cron is valid:false with no runs (a 200, never a 400)", () => {
    for (const bad of ["nope", "0 25 * * *", "* * * *", ""]) {
      const p = previewSchedule(bad, 3, from);
      expect(p).toMatchObject({ valid: false, nextRuns: [], minGapSeconds: null });
      expect(p.error).toBeTruthy();
    }
  });

  it("clamps count to 1..10", () => {
    expect(previewSchedule("0 * * * *", 0, from).nextRuns).toHaveLength(1);
    expect(previewSchedule("0 * * * *", 99, from).nextRuns).toHaveLength(10);
    expect(previewSchedule("0 * * * *", 5, from).nextRuns).toHaveLength(5);
  });

  it("reports a sub-hourly gap so the UI can warn", () => {
    expect(previewSchedule("*/15 * * * *", 3, from).minGapSeconds).toBe(900);
  });

  it("the query schema coerces count and requires cron", () => {
    expect(SchedulePreviewQuerySchema.parse({ cron: "0 3 * * *", count: "4" }).count).toBe(4);
    expect(SchedulePreviewQuerySchema.safeParse({}).success).toBe(false);
  });
});
