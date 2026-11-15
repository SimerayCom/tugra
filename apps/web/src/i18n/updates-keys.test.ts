import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import settings from "./locales/en/settings.json";

const card = readFileSync(path.resolve(__dirname, "../app/(app)/settings/updates-card.tsx"), "utf8");
const dict = settings as Record<string, unknown>;

describe("D-UPD update-card i18n coverage", () => {
  it("every settings.* key referenced by updates-card.tsx exists in settings.json", () => {
    const used = [...card.matchAll(/["'`]settings\.([A-Za-z0-9_]+)["'`]/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    for (const k of used) expect(typeof dict[k], k).toBe("string");
  });

  it("the new channel/check keys exist, are used, and keep their placeholders", () => {
    const keys: Record<string, string | null> = {
      channelAuto: "{channel}",
      channelAutoHint: null,
      updateAutoHint: null,
      updateLastChecked: "{when}",
      updateLastCheckFailed: "{reason}",
      updateChecksDisabled: null,
      updateChecksEvery: "{minutes}",
    };
    for (const [k, ph] of Object.entries(keys)) {
      expect(typeof dict[k], k).toBe("string");
      expect(card, k).toContain(`settings.${k}`);
      if (ph) expect(dict[k] as string, k).toContain(ph);
    }
  });
});
