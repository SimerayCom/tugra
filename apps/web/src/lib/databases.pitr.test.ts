import { describe, it, expect } from "vitest";
import { pitrAvailable, pitrState } from "./databases";

describe("pitr helpers", () => {
  it("derives OFF / ARMING / ACTIVE from the two row fields (no stamp = still arming)", () => {
    expect(pitrState({ pitrEnabled: false, pitrEnabledAt: null })).toBe("OFF");
    expect(pitrState({ pitrEnabled: true, pitrEnabledAt: null })).toBe("ARMING");
    expect(pitrState({ pitrEnabled: true, pitrEnabledAt: "2026-11-13T00:00:00.000Z" })).toBe("ACTIVE");
    // a stamp without the flag is not a state the hub produces, but it must still read as OFF (flag wins)
    expect(pitrState({ pitrEnabled: false, pitrEnabledAt: "2026-11-13T00:00:00.000Z" })).toBe("OFF");
  });

  it("is available only for a backup-capable Postgres database", () => {
    expect(pitrAvailable({ engine: "POSTGRES", backupSupported: true })).toBe(true);
    expect(pitrAvailable({ engine: "POSTGRES", backupSupported: false })).toBe(false);
    expect(pitrAvailable({ engine: "MYSQL", backupSupported: true })).toBe(false);
  });
});
