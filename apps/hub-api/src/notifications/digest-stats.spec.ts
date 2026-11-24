import { buildSuggestions, DIGEST_GRACE_MS, isDigestDue, lastDueAt, localParts, type WeekStats } from "./digest-stats";

describe("lastDueAt", () => {
  it("is the most recent Monday 08:00 in the zone", () => {
    // Wed 2026-11-25 10:00 UTC → Mon 2026-11-23 08:00 UTC
    expect(lastDueAt(new Date("2026-11-25T10:00:00Z"), "UTC").toISOString()).toBe("2026-11-23T08:00:00.000Z");
  });
  it("on Monday before the send hour it is still last week's Monday", () => {
    expect(lastDueAt(new Date("2026-11-23T07:59:00Z"), "UTC").toISOString()).toBe("2026-11-16T08:00:00.000Z");
    expect(lastDueAt(new Date("2026-11-23T08:00:00Z"), "UTC").toISOString()).toBe("2026-11-23T08:00:00.000Z");
  });
  it("uses the hub's wall clock, not UTC", () => {
    // Istanbul is UTC+3: Monday 08:00 there is 05:00 UTC
    expect(lastDueAt(new Date("2026-11-23T06:00:00Z"), "Europe/Istanbul").toISOString()).toBe("2026-11-23T05:00:00.000Z");
    // Sunday evening UTC is already Monday in Auckland (UTC+13 in Nov)
    const p = localParts(new Date("2026-11-22T20:00:00Z"), "Pacific/Auckland");
    expect(p.weekday).toBe(1);
  });
  it("keeps 08:00 local across a DST change", () => {
    // US clocks went back on 2026-11-01; Monday 2026-11-02 08:00 EST = 13:00 UTC
    expect(lastDueAt(new Date("2026-11-03T12:00:00Z"), "America/New_York").toISOString()).toBe("2026-11-02T13:00:00.000Z");
    // Monday before the change was EDT: 2026-10-26 08:00 EDT = 12:00 UTC
    expect(lastDueAt(new Date("2026-10-28T12:00:00Z"), "America/New_York").toISOString()).toBe("2026-10-26T12:00:00.000Z");
  });
});

describe("isDigestDue", () => {
  const tz = "UTC";
  it("is due on Monday morning when nothing was sent this week", () => {
    expect(isDigestDue(new Date("2026-11-23T08:10:00Z"), null, tz)).toBe(true);
    expect(isDigestDue(new Date("2026-11-23T08:10:00Z"), new Date("2026-11-16T08:05:00Z"), tz)).toBe(true);
  });
  it("is not due before 08:00, or once this week's was claimed", () => {
    expect(isDigestDue(new Date("2026-11-23T07:00:00Z"), new Date("2026-11-16T08:05:00Z"), tz)).toBe(false);
    expect(isDigestDue(new Date("2026-11-23T09:00:00Z"), new Date("2026-11-23T08:05:00Z"), tz)).toBe(false);
  });
  it("catches up a missed Monday for a day, then gives up until next week", () => {
    expect(isDigestDue(new Date("2026-11-24T07:00:00Z"), null, tz)).toBe(true);
    expect(isDigestDue(new Date(new Date("2026-11-23T08:00:00Z").getTime() + DIGEST_GRACE_MS + 60_000), null, tz)).toBe(false);
    expect(isDigestDue(new Date("2026-11-27T12:00:00Z"), null, tz)).toBe(false);
  });
});

describe("buildSuggestions", () => {
  const calm: WeekStats = {
    deploys: { total: 5, failed: 0 },
    worstApp: null,
    backups: { total: 7, failed: 0 },
    databasesWithoutBackup: 0,
    incidents: 0,
    busiestServer: { name: "web-1", cpuPct: 20 },
    fullestDisk: { name: "web-1", pct: 40 },
  };
  it("a calm week has no suggestions", () => {
    expect(buildSuggestions(calm)).toEqual([]);
  });
  it("orders by urgency and caps at three", () => {
    const s = buildSuggestions({
      ...calm,
      backups: { total: 7, failed: 2 },
      worstApp: { name: "Acme API", failed: 3 },
      fullestDisk: { name: "web-1", pct: 91.4 },
      databasesWithoutBackup: 1,
      incidents: 5,
      busiestServer: { name: "web-1", cpuPct: 90 },
    });
    expect(s.map((x) => x.code)).toEqual(["failing_backups", "failing_deploys", "disk_high"]);
    expect(s[2].params).toEqual({ name: "web-1", pct: 91 });
  });
  it("a single failed deploy is not worth a suggestion", () => {
    expect(buildSuggestions({ ...calm, worstApp: { name: "Acme API", failed: 1 } })).toEqual([]);
  });
});
