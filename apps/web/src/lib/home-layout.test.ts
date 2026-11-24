import { describe, it, expect, afterEach } from "vitest";
import { DEFAULT_LAYOUT, effectiveGroupMode, loadLayout, sanitizeLayout, saveLayout } from "./home-layout";

afterEach(() => localStorage.clear());

describe("sanitizeLayout", () => {
  it("returns defaults for junk", () => {
    expect(sanitizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout("abc")).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout(42)).toEqual(DEFAULT_LAYOUT);
  });
  it("keeps valid fields and drops invalid ones", () => {
    const l = sanitizeLayout({
      order: ["a", 1, "b"],
      folders: [{ id: "f", name: "Media", tileIds: ["a", 2] }, { id: 5 }, null],
      groupMode: "team",
      wallpaper: "nope",
      widgets: { servers: false, storage: "yes" },
      gaugeServerId: 9,
      fleetHintDismissed: true,
    });
    expect(l.order).toEqual(["a", "b"]);
    expect(l.folders).toEqual([{ id: "f", name: "Media", tileIds: ["a"] }]);
    expect(l.groupMode).toBe("team");
    expect(l.wallpaper).toBe("none");
    expect(l.widgets).toEqual({ servers: false, storage: true, backups: true, uptime: true });
    expect(l.gaugeServerId).toBeNull();
    expect(l.fleetHintDismissed).toBe(true);
  });
});

describe("load/save", () => {
  it("round-trips and survives corrupt storage", () => {
    saveLayout({ ...DEFAULT_LAYOUT, order: ["x"], wallpaper: "ocean" });
    expect(loadLayout().order).toEqual(["x"]);
    expect(loadLayout().wallpaper).toBe("ocean");
    localStorage.setItem("tugra.home.layout", "{not json");
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

describe("effectiveGroupMode", () => {
  it("auto groups by team once there are several, by folders when they exist, else none", () => {
    expect(effectiveGroupMode({ groupMode: "auto", folders: [] }, 8)).toBe("team");
    expect(effectiveGroupMode({ groupMode: "auto", folders: [] }, 1)).toBe("none");
    expect(effectiveGroupMode({ groupMode: "auto", folders: [{ id: "f", name: "F", tileIds: [] }] }, 1)).toBe("folders");
  });
  it("an explicit choice wins", () => {
    expect(effectiveGroupMode({ groupMode: "none", folders: [] }, 8)).toBe("none");
  });
});
