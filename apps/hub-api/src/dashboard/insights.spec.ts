import { forecastDisk, rankBackups, FORECAST_MIN_POINTS, type BackupDigestRow, type DiskPoint } from "./insights";

const GB = 1_000_000_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const series = (n: number, used: (i: number) => number): DiskPoint[] => Array.from({ length: n }, (_, i) => ({ ts: 1_700_000_000_000 + i * HOUR, used: used(i) }));

describe("forecastDisk", () => {
  it("projects the days until full from a steady growth trend", () => {
    // 100 GB disk, 40 GB used, growing 2 GB per day for 3 days → 60 GB left → 30 days
    const pts = series(72, (i) => 40 * GB + (2 * GB * i) / 24);
    const f = forecastDisk(pts, 100 * GB)!;
    expect(f.growthBytesPerDay).toBeCloseTo(2 * GB, -6);
    // last point is ~ 40 + 2*(71/24) = 45.9 GB → (100-45.9)/2 ≈ 27 days
    expect(f.daysToFull).toBeGreaterThan(26);
    expect(f.daysToFull).toBeLessThan(28);
  });

  it("returns null with too little history", () => {
    expect(forecastDisk(series(FORECAST_MIN_POINTS - 1, (i) => i * GB), 100 * GB)).toBeNull();
    // enough points but all inside a couple of hours: span too short
    const dense = Array.from({ length: 20 }, (_, i) => ({ ts: 1_700_000_000_000 + i * 60_000, used: i * GB }));
    expect(forecastDisk(dense, 100 * GB)).toBeNull();
  });

  it("returns null for an unknown capacity or garbage points", () => {
    expect(forecastDisk(series(48, (i) => i * GB), 0)).toBeNull();
    expect(forecastDisk(series(48, () => NaN), 100 * GB)).toBeNull();
  });

  it("reports no days-to-full when the disk is flat or shrinking", () => {
    expect(forecastDisk(series(48, () => 30 * GB), 100 * GB)).toEqual({ growthBytesPerDay: 0, daysToFull: null });
    const shrinking = forecastDisk(series(48, (i) => 60 * GB - i * GB * 0.1), 100 * GB)!;
    expect(shrinking.daysToFull).toBeNull();
    expect(shrinking.growthBytesPerDay).toBeLessThan(0);
  });

  it("ignores a noisy series whose trend fits poorly (cleanup cycles are not a forecast)", () => {
    const noisy = series(48, (i) => (i % 2 === 0 ? 40 * GB : 60 * GB) + i * 1000);
    expect(forecastDisk(noisy, 100 * GB)!.daysToFull).toBeNull();
  });

  it("says 0 days when the disk is already full", () => {
    expect(forecastDisk(series(48, (i) => 99 * GB + i * 0.03 * GB), 100 * GB)!.daysToFull).toBe(0);
  });

  it("drops forecasts further than a year out", () => {
    // +1 MB per day on a huge free area
    expect(forecastDisk(series(72, (i) => 10 * GB + (1_000_000 * i) / 24), 1000 * GB)!.daysToFull).toBeNull();
  });

  it("does not depend on input order", () => {
    const pts = series(48, (i) => 10 * GB + i * GB * 0.05);
    expect(forecastDisk([...pts].reverse(), 100 * GB)).toEqual(forecastDisk(pts, 100 * GB));
    expect(forecastDisk(pts, 100 * GB)!.daysToFull).toBeGreaterThan(0);
    expect(DAY).toBe(24 * HOUR);
  });
});

describe("rankBackups", () => {
  const b = (id: string, status: BackupDigestRow["status"], at: string): BackupDigestRow => ({ id, kind: "database", resourceId: "d", resourceName: "db", status, createdAt: at, sizeBytes: null });
  it("puts failures first, then the rest newest first, capped", () => {
    const out = rankBackups(
      [b("ok-new", "SUCCESS", "2026-11-24T10:00:00Z"), b("fail-old", "FAILED", "2026-11-20T10:00:00Z"), b("ok-old", "SUCCESS", "2026-11-22T10:00:00Z"), b("fail-new", "FAILED", "2026-11-23T10:00:00Z")],
      3,
    );
    expect(out.map((r) => r.id)).toEqual(["fail-new", "fail-old", "ok-new"]);
  });
  it("handles an empty list and a zero limit", () => {
    expect(rankBackups([], 5)).toEqual([]);
    expect(rankBackups([b("x", "SUCCESS", "2026-11-24T10:00:00Z")], 0)).toEqual([]);
  });
});
