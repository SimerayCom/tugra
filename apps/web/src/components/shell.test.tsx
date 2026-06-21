import { describe, it, expect } from "vitest";
import { NAV } from "./shell";

describe("sidebar NAV", () => {
  it("defines an icon for every nav item (no bare text entries)", () => {
    for (const group of NAV) {
      for (const item of group.items) {
        expect(item.icon, `${item.key} is missing an icon`).toBeTruthy();
      }
    }
  });
});
