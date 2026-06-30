import { describe, it, expect } from "vitest";
import { BULK_PRESETS } from "./bulk-presets";

describe("BULK_PRESETS", () => {
  it("has unique keys", () => {
    const keys = BULK_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every preset has a non-empty command and label key", () => {
    expect(BULK_PRESETS.length).toBeGreaterThan(0);
    for (const p of BULK_PRESETS) {
      expect(p.command.trim().length).toBeGreaterThan(0);
      expect(p.labelKey.length).toBeGreaterThan(0);
    }
  });
});
