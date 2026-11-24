import { describe, it, expect } from "vitest";
import { draftFromPolicy, policyBadges, policyFromDraft } from "./notification-policy";

describe("draftFromPolicy", () => {
  it("defaults to quiet hours off, 22:00 to 07:00 in the given zone", () => {
    expect(draftFromPolicy(undefined, "Europe/Istanbul")).toEqual({
      quietOn: false, from: "22:00", to: "07:00", tz: "Europe/Istanbul", allowCritical: true, rate: "", window: "",
    });
  });
  it("reads a saved policy", () => {
    const d = draftFromPolicy({ quietHours: { from: "23:00", to: "06:30", tz: "UTC", allowCritical: false }, rateLimitPerMin: 10, dedupeWindowSec: 0 });
    expect(d).toMatchObject({ quietOn: true, from: "23:00", to: "06:30", allowCritical: false, rate: "10", window: "0" });
  });
});

describe("policyFromDraft", () => {
  const base = draftFromPolicy(undefined, "UTC");
  it("an untouched draft clears everything back to defaults", () => {
    expect(policyFromDraft(base)).toEqual({ body: { quietHours: null, rateLimitPerMin: null, dedupeWindowSec: null }, problems: [] });
  });
  it("builds the body", () => {
    const r = policyFromDraft({ ...base, quietOn: true, rate: "20", window: "600" });
    expect(r.body).toEqual({ quietHours: { from: "22:00", to: "07:00", tz: "UTC", allowCritical: true }, rateLimitPerMin: 20, dedupeWindowSec: 600 });
    expect(r.problems).toEqual([]);
  });
  it("0 turns the repeat window off (not the default)", () => {
    expect(policyFromDraft({ ...base, window: "0" }).body.dedupeWindowSec).toBe(0);
  });
  it("reports what to fix", () => {
    expect(policyFromDraft({ ...base, rate: "0" }).problems).toEqual(["rate"]);
    expect(policyFromDraft({ ...base, rate: "601" }).problems).toEqual(["rate"]);
    expect(policyFromDraft({ ...base, rate: "1.5" }).problems).toEqual(["rate"]);
    expect(policyFromDraft({ ...base, quietOn: true, from: "07:00", to: "07:00" }).problems).toEqual(["quiet"]);
    expect(policyFromDraft({ ...base, quietOn: true, from: "25:00" }).problems).toEqual(["quiet"]);
    expect(policyFromDraft({ ...base, quietOn: true, tz: " " }).problems).toEqual(["tz"]);
  });
  it("ignores the quiet fields while quiet hours are off", () => {
    expect(policyFromDraft({ ...base, quietOn: false, from: "bad" }).problems).toEqual([]);
  });
});

describe("policyBadges", () => {
  it("lists only the rules that are set", () => {
    expect(policyBadges({})).toEqual([]);
    expect(policyBadges({ rateLimitPerMin: 5, dedupeWindowSec: 0 })).toEqual(["rate", "repeat"]);
  });
});
