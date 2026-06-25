import { describe, it, expect } from "vitest";
import { isMobileWidth, MOBILE_MAX } from "./responsive";

describe("isMobileWidth", () => {
  it("treats narrow viewports (≤767) as mobile", () => {
    expect(isMobileWidth(320)).toBe(true);
    expect(isMobileWidth(375)).toBe(true);
    expect(isMobileWidth(MOBILE_MAX)).toBe(true);
  });
  it("treats ≥768 as desktop", () => {
    expect(isMobileWidth(768)).toBe(false);
    expect(isMobileWidth(1280)).toBe(false);
  });
});
