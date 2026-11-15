import { describe, it, expect } from "vitest";
import { formatClock, formatDateTime, formatUtc, withUtc } from "./format-time";
import { KEYS } from "./appearance";

const T = Date.UTC(2026, 10, 15, 14, 5, 9);

describe("format-time", () => {
  it("formatUtc renders the instant in UTC", () => {
    expect(formatUtc(T)).toBe("2026-11-15 14:05 UTC");
    expect(formatUtc(T, { seconds: true })).toBe("2026-11-15 14:05:09 UTC");
    expect(formatUtc(new Date(T).toISOString(), { dateOnly: true })).toBe("2026-11-15 UTC");
    expect(formatUtc("not a date")).toBe("");
  });

  it("withUtc only suffixes in localUtc mode", () => {
    expect(withUtc("14:05", T, "local")).toBe("14:05");
    expect(withUtc("14:05", T, "localUtc")).toBe("14:05 · 2026-11-15 14:05 UTC");
    expect(withUtc("x", "bad", "localUtc")).toBe("x");
  });

  it("formatDateTime / formatClock follow the stored preference by default", () => {
    localStorage.clear();
    expect(formatDateTime(T)).toBe(new Date(T).toLocaleString());
    expect(formatClock(T)).toBe(new Date(T).toLocaleTimeString());
    localStorage.setItem(KEYS.chartTimes, "localUtc");
    expect(formatDateTime(T)).toBe(`${new Date(T).toLocaleString()} · 2026-11-15 14:05:09 UTC`);
    expect(formatClock(T)).toContain("UTC");
    // an explicit mode wins over storage
    expect(formatDateTime(T, "local")).toBe(new Date(T).toLocaleString());
    localStorage.clear();
  });
});
