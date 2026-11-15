import { describe, it, expect } from "vitest";
import { tokenExpiry } from "./api-token-expiry";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const inDays = (d: number) => new Date(NOW + d * 86_400_000).toISOString();

describe("tokenExpiry", () => {
  it("has no state for a token without an expiry or with garbage", () => {
    expect(tokenExpiry(null, NOW)).toEqual({ state: "none" });
    expect(tokenExpiry("not-a-date", NOW)).toEqual({ state: "none" });
  });
  it("is ok beyond 14 days", () => {
    expect(tokenExpiry(inDays(15), NOW)).toEqual({ state: "ok", days: 15 });
    expect(tokenExpiry(inDays(90), NOW)).toEqual({ state: "ok", days: 90 });
  });
  it("turns soon (amber) at exactly 14 days and below, rounding partial days up", () => {
    expect(tokenExpiry(inDays(14), NOW)).toEqual({ state: "soon", days: 14 });
    expect(tokenExpiry(inDays(0.2), NOW)).toEqual({ state: "soon", days: 1 });
    expect(tokenExpiry(inDays(13.4), NOW)).toEqual({ state: "soon", days: 14 });
  });
  it("is expired once the instant has passed", () => {
    expect(tokenExpiry(inDays(-1), NOW)).toEqual({ state: "expired" });
    expect(tokenExpiry(new Date(NOW).toISOString(), NOW)).toEqual({ state: "expired" });
  });
});
