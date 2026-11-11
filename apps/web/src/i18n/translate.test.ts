import { describe, it, expect } from "vitest";
import en from "./locales/en";
import { translate } from "./translate";

describe("i18n translate", () => {
  it("resolves a nested namespaced key", () => {
    expect(translate(en, "nav.dashboard")).toBe("Dashboard");
    expect(translate(en, "servers.title")).toBe("Servers");
  });

  it("interpolates variables", () => {
    expect(translate(en, "servers.selected", { n: 3 })).toBe("3 selected");
  });

  it("returns the key itself when missing (gaps stay visible)", () => {
    expect(translate(en, "nope.nope")).toBe("nope.nope");
  });

  it("labels volume backups honestly (not a point-in-time snapshot, may be inconsistent)", () => {
    // Guards the RB-05 honesty copy: a volume backup tars a RUNNING volume (not a snapshot), so the UI must
    // not imply a transaction-consistent DB backup. These keys must exist and carry the caveat.
    expect(translate(en, "apps.volBackupsWarn")).toMatch(/not a point-in-time snapshot|may be inconsistent/i);
    expect(translate(en, "apps.volBackupsWarn")).toMatch(/database/i);
    expect(translate(en, "apps.volBackupsDesc")).toMatch(/not a point-in-time snapshot|file-level/i);
    // The restore confirm is the volume-specific copy, not the "overwrites the current database" one.
    expect(translate(en, "apps.volRestoreConfirm")).toMatch(/this volume/i);
    expect(translate(en, "apps.volRestoreConfirm")).not.toMatch(/the current database/i);
  });
});
