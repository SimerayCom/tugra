import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import backups from "./locales/en/backups.json";
import destinations from "./locales/en/destinations.json";
import settings from "./locales/en/settings.json";

const SRC = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}
const source = walk(SRC).map((f) => readFileSync(f, "utf8")).join("\n");

function flatten(o: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));
}
const lookup = (tree: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), tree);

const NEW_DEST = ["encryptHint", "state_encrypted", "state_unencrypted", "recoveryKey_title", "recoveryKey_body", "recoveryKey_copy", "recoveryKey_copied", "recoveryKey_download", "recoveryKey_saved", "recoveryKey_done", "recoveryKey_skip", "recoveryKey_label", "recoveryKey_file", "delete_keyLoss", "delete_discardAck", "delete_confirm", "test_encryptionOk", "test_encryptionFail", "test_gpgMissing", "legacyBanner_title", "legacyBanner_body", "legacyBanner_dismiss", "optOutWarning"];
const NEW_SETTINGS = ["hubBackup_retentionDays", "hubBackup_maxSizeGb", "hubBackup_alwaysEncrypted", "keysExport_title", "keysExport_passphrase", "keysExport_confirm", "keysExport_minLength", "keysExport_mismatch", "keysExport_warning", "keysExport_download", "keysExport_done", "keysExport_undecryptable", "keysExport_failed", "keysExport_close"];

describe("G3-A backup UI i18n coverage", () => {
  it("every backups.* key used in code exists, and every backups.json key is used", () => {
    const used = new Set([...source.matchAll(/["'`](backups\.[A-Za-z0-9_.${}]+)["'`]/g)].map((m) => m[1]));
    for (const k of used) {
      if (k.includes("${")) continue; // dynamic (preset.<key>) — checked below
      expect(typeof lookup({ backups }, k), k).toBe("string");
    }
    for (const p of ["hourly", "daily", "weekly", "monthly", "custom"]) expect(typeof (backups.preset as Record<string, string>)[p]).toBe("string");
    expect(source).toContain("backups.preset.${p.key}");
    const dynamicPrefixes = ["backups.preset."];
    const unused = flatten(backups, "backups.").filter((k) => !used.has(k) && !dynamicPrefixes.some((p) => k.startsWith(p)));
    expect(unused).toEqual([]);
  });

  it("the new destinations.* and settings.* keys exist and are used", () => {
    for (const k of NEW_DEST) {
      expect(typeof (destinations as Record<string, unknown>)[k], k).toBe("string");
      expect(source, k).toContain(`destinations.${k}`);
    }
    for (const k of NEW_SETTINGS) {
      expect(typeof (settings as Record<string, unknown>)[k], k).toBe("string");
      expect(source, k).toContain(`settings.${k}`);
    }
  });
});
