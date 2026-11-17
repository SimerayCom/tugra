import { describe, it, expect } from "vitest";
import {
  REBOOT_MAX_LEAD_MS,
  REBOOT_MIN_LEAD_MS,
  confirmationMatches,
  defaultScheduleValue,
  formatUtc,
  fromLocalInputValue,
  rebootPhase,
  rebootSteps,
  reportProblems,
  scheduleProblem,
  toLocalInputValue,
} from "./reboot";
import type { RebootReport } from "./types";

describe("rebootPhase / rebootSteps", () => {
  it("maps every live state to a phase; DONE is not live", () => {
    expect(rebootPhase("SCHEDULED")).toBe("scheduled");
    expect(rebootPhase("STARTING")).toBe("rebooting");
    expect(rebootPhase("REBOOTING")).toBe("rebooting");
    expect(rebootPhase("WAITING_AGENT")).toBe("waiting");
    expect(rebootPhase("VERIFYING")).toBe("verifying");
    expect(rebootPhase("DONE")).toBeNull();
    expect(rebootPhase(undefined)).toBeNull();
  });
  it("only a scheduled reboot has a 'scheduled' step", () => {
    expect(rebootSteps({ mode: "scheduled" })).toEqual(["scheduled", "rebooting", "waiting", "verifying"]);
    expect(rebootSteps({ mode: "now" })).toEqual(["rebooting", "waiting", "verifying"]);
  });
});

describe("schedule inputs (local time in, UTC out)", () => {
  it("round-trips a local picker value through the UTC instant", () => {
    const local = "2026-11-27T15:30";
    const iso = fromLocalInputValue(local)!;
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    expect(toLocalInputValue(new Date(iso))).toBe(local);
  });
  it("rejects values that are not a date-time", () => {
    for (const v of ["", "tomorrow", "2026-11-27", "2026-13-45T99:99"]) expect(fromLocalInputValue(v), v).toBeNull();
  });
  it("formats the stored instant as UTC", () => {
    expect(formatUtc("2026-11-27T12:30:45.000Z")).toBe("2026-11-27 12:30 UTC");
    expect(formatUtc("nope")).toBe("");
  });
  it("defaults to about an hour ahead, on a 5-minute mark, and is itself valid", () => {
    const now = new Date("2026-11-27T12:01:10").getTime();
    const v = defaultScheduleValue(now);
    expect(v).toBe("2026-11-27T13:05");
    expect(scheduleProblem(v, now)).toBeNull();
  });
  it("enforces a minute to 7 days ahead, like the hub", () => {
    const now = new Date("2026-11-27T12:00:00").getTime();
    const at = (ms: number) => toLocalInputValue(new Date(now + ms));
    expect(scheduleProblem(at(-3600_000), now)).toBe("past");
    expect(scheduleProblem(at(REBOOT_MIN_LEAD_MS - 60_000), now)).toBe("past");
    expect(scheduleProblem(at(REBOOT_MIN_LEAD_MS + 60_000), now)).toBeNull();
    expect(scheduleProblem(at(REBOOT_MAX_LEAD_MS - 60_000), now)).toBeNull();
    expect(scheduleProblem(at(REBOOT_MAX_LEAD_MS + 3600_000), now)).toBe("tooFar");
    expect(scheduleProblem("", now)).toBe("invalid");
  });
});

describe("confirmationMatches", () => {
  it("is exact: same case, no padding, never for an empty name", () => {
    expect(confirmationMatches("prod-1", "prod-1")).toBe(true);
    expect(confirmationMatches("Prod-1", "prod-1")).toBe(false);
    expect(confirmationMatches("prod-1 ", "prod-1")).toBe(false);
    expect(confirmationMatches("", "")).toBe(false);
  });
});

describe("reportProblems", () => {
  it("lists what did not come back (missing, unhealthy, still pending), not skipped or ok ones", () => {
    const r = {
      containers: [
        { name: "a", verdict: "ok" },
        { name: "b", verdict: "missing" },
        { name: "c", verdict: "unhealthy" },
        { name: "d", verdict: "skipped" },
        { name: "e", verdict: "pending" },
      ],
      domains: [
        { host: "x", verdict: "ok" },
        { host: "y", verdict: "not_answering" },
        { host: "z", verdict: "unverified" },
      ],
    } as unknown as RebootReport;
    expect(reportProblems(r)).toEqual({ containers: ["b", "c", "e"], domains: ["y"] });
  });
});
