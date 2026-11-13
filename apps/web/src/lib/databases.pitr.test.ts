import { describe, it, expect } from "vitest";
import { fromDatetimeLocal, pitrAvailable, pitrPickerBounds, pitrState, toDatetimeLocal } from "./databases";

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

  it("round-trips a datetime-local value in LOCAL time with second precision", () => {
    const d = new Date(2026, 10, 13, 10, 30, 45); // local
    expect(toDatetimeLocal(d)).toBe("2026-11-13T10:30:45");
    expect(fromDatetimeLocal("2026-11-13T10:30:45")!.getTime()).toBe(d.getTime());
    expect(fromDatetimeLocal("")).toBeNull();
    expect(fromDatetimeLocal("junk")).toBeNull();
  });

  it("derives picker bounds: min rounded UP to a whole second, max floored, default a minute before the end", () => {
    const w = { earliest: "2026-11-13T09:02:00.700Z", latest: "2026-11-13T12:00:00.900Z" };
    const b = pitrPickerBounds(w)!;
    expect(b.min).toBe(toDatetimeLocal(new Date("2026-11-13T09:02:01.000Z"))); // never an instant before the real earliest
    expect(b.max).toBe(toDatetimeLocal(new Date("2026-11-13T12:00:00.000Z")));
    expect(b.initial).toBe(toDatetimeLocal(new Date("2026-11-13T11:59:00.000Z"))); // the end is the riskiest moment
    expect(pitrPickerBounds({ earliest: null, latest: null })).toBeNull();
    expect(pitrPickerBounds({ earliest: w.latest, latest: w.earliest })).toBeNull();
  });

  it("a window narrower than a minute still defaults inside it; a sub-second window has no selectable instant", () => {
    const b = pitrPickerBounds({ earliest: "2026-11-13T09:02:00.000Z", latest: "2026-11-13T09:02:30.000Z" })!;
    expect(b.initial).toBe(b.min);
    expect(pitrPickerBounds({ earliest: "2026-11-13T09:02:00.200Z", latest: "2026-11-13T09:02:00.800Z" })).toBeNull();
  });
});
