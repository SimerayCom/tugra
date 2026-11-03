import { isValidCron } from "./cron";

describe("isValidCron", () => {
  it("accepts valid 5-field expressions (including steps, ranges and names)", () => {
    for (const ok of ["0 3 * * *", "*/5 * * * *", "0 0 1 * *", "15 2 * * MON", "0 9-17 * * 1-5"]) {
      expect(isValidCron(ok)).toBe(true);
    }
  });

  it("rejects out-of-range fields that pass a shape check but crash BullMQ's parser", () => {
    for (const bad of ["0 25 * * *", "60 * * * *", "* * 32 * *", "* * * 13 *", "foo bar baz qux quux"]) {
      expect(isValidCron(bad)).toBe(false);
    }
  });

  it("does not throw on empty or garbage input", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("   ")).toBe(false);
  });
});
