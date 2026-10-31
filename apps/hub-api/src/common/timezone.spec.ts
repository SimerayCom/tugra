import { isValidIana } from "./timezone";

describe("isValidIana", () => {
  it("accepts real IANA zones + UTC", () => {
    for (const tz of ["UTC", "Europe/Istanbul", "America/New_York", "Asia/Tokyo"]) {
      expect(isValidIana(tz)).toBe(true);
    }
  });
  it("rejects unknown zones, empty, and junk", () => {
    for (const tz of ["", "   ", "Not/AZone", "Europe/Atlantis", "GMT+3", "../etc"]) {
      expect(isValidIana(tz)).toBe(false);
    }
  });
});
