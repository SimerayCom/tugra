import { ServerStatus } from "@prisma/client";
import {
  DEFAULT_CLEANUP_DATA,
  planCleanupSchedule,
  reclaimedNothing,
  shouldTriggerThresholdCleanup,
  THRESHOLD_SAMPLE_MAX_AGE_MS,
  type ThresholdInput,
} from "./cleanup-defaults";

const now = new Date("2026-11-26T12:00:00Z");
const sample = (pct: number, ageMs = 60_000) => ({ ts: new Date(now.getTime() - ageMs), diskUsed: BigInt(pct), diskTotal: 100n });
const base = (over: Partial<ThresholdInput> = {}): ThresholdInput => ({
  enabled: true,
  status: ServerStatus.ONLINE,
  thresholdPct: 80,
  sample: sample(85),
  now,
  ...over,
});

describe("cleanup defaults", () => {
  it("are on, daily 03:00, 80% threshold", () => {
    expect(DEFAULT_CLEANUP_DATA).toEqual({ cleanupEnabled: true, cleanupCron: "0 3 * * *", cleanupThresholdPct: 80 });
  });
});

describe("shouldTriggerThresholdCleanup", () => {
  it("fires when usage is at or above the threshold", () => {
    expect(shouldTriggerThresholdCleanup(base({ sample: sample(80) }))).toBe(true);
    expect(shouldTriggerThresholdCleanup(base({ sample: sample(99) }))).toBe(true);
  });
  it("does not fire below the threshold", () => {
    expect(shouldTriggerThresholdCleanup(base({ sample: sample(79) }))).toBe(false);
  });
  it("does not fire when cleanup is off (explicit-off is respected), no threshold, or no sample", () => {
    expect(shouldTriggerThresholdCleanup(base({ enabled: false }))).toBe(false);
    expect(shouldTriggerThresholdCleanup(base({ thresholdPct: null }))).toBe(false);
    expect(shouldTriggerThresholdCleanup(base({ sample: null }))).toBe(false);
  });
  it("does not fire for a server that is not ONLINE", () => {
    expect(shouldTriggerThresholdCleanup(base({ status: ServerStatus.OFFLINE }))).toBe(false);
    expect(shouldTriggerThresholdCleanup(base({ status: ServerStatus.PENDING }))).toBe(false);
  });
  it("ignores a stale sample (agent stalled) and a zero total", () => {
    expect(shouldTriggerThresholdCleanup(base({ sample: sample(95, THRESHOLD_SAMPLE_MAX_AGE_MS + 1000) }))).toBe(false);
    expect(shouldTriggerThresholdCleanup(base({ sample: { ts: now, diskUsed: 5n, diskTotal: 0n } }))).toBe(false);
  });
});

describe("planCleanupSchedule", () => {
  it("cron wins over interval, and carries the server timezone", () => {
    expect(planCleanupSchedule({ cleanupCron: "0 4 * * *", cleanupIntervalHours: 6, timezone: "Europe/Istanbul" })).toEqual({ kind: "cron", cron: "0 4 * * *", tz: "Europe/Istanbul" });
  });
  it("interval when no cron", () => {
    expect(planCleanupSchedule({ cleanupCron: null, cleanupIntervalHours: 6, timezone: null })).toEqual({ kind: "interval", intervalSec: 21600 });
  });
  it("enabled with neither gets the default daily cron", () => {
    expect(planCleanupSchedule({ cleanupCron: null, cleanupIntervalHours: null, timezone: null })).toEqual({ kind: "cron", cron: "0 3 * * *" });
  });
});

describe("reclaimedNothing", () => {
  it("is true only for a completed run that freed nothing", () => {
    expect(reclaimedNothing({ ok: true, reclaimed: "0B", output: "x" })).toBe(true);
    expect(reclaimedNothing({ ok: true, reclaimed: "", output: "x" })).toBe(true);
    expect(reclaimedNothing({ ok: true, reclaimed: "1.2GB", output: "x" })).toBe(false);
    expect(reclaimedNothing({ ok: true, reclaimed: "", output: "skipped: 1 deploy(s) running" })).toBe(false);
    expect(reclaimedNothing({ ok: false, reclaimed: "", output: "boom" })).toBe(false);
  });
});
