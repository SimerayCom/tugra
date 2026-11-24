import { describe, expect, it, beforeEach } from "vitest";
import { DASHBOARD_CARDS, defaultLayout, dropCard, moveCard, normalizeLayout, readLayout, toggleCard, visibleCards } from "./dashboard-layout";

describe("normalizeLayout", () => {
  it("falls back to the default for garbage", () => {
    expect(normalizeLayout(null)).toEqual(defaultLayout());
    expect(normalizeLayout("x")).toEqual(defaultLayout());
    expect(normalizeLayout(42)).toEqual(defaultLayout());
  });
  it("drops unknown and duplicate ids and appends cards added since it was saved", () => {
    const out = normalizeLayout({ order: ["servers", "nope", "servers", "attention"], hidden: ["fleet", "ghost"] });
    // the user's own relative order survives (servers stays before attention); missing cards slot in after their default predecessor
    expect(out.order.indexOf("servers")).toBeLessThan(out.order.indexOf("attention"));
    expect([...out.order].sort()).toEqual([...DASHBOARD_CARDS].sort());
    expect(new Set(out.order).size).toBe(DASHBOARD_CARDS.length);
    expect(out.hidden).toContain("fleet");
    expect(out.hidden).not.toContain("ghost");
  });
  it("keeps a card the user saved as visible even if it starts hidden by default", () => {
    const out = normalizeLayout({ order: [...DASHBOARD_CARDS], hidden: [] });
    expect(out.hidden).toEqual([]);
  });
  it("places a card that is new to the saved layout after its default predecessor and hides it if it starts hidden", () => {
    const withoutCerts = DASHBOARD_CARDS.filter((c) => c !== "certs" && c !== "migrations");
    const out = normalizeLayout({ order: withoutCerts, hidden: [] });
    expect(out.order.indexOf("certs")).toBe(out.order.indexOf("diskForecast") + 1);
    expect(out.hidden).toContain("migrations");
    expect(out.hidden).not.toContain("certs");
  });
});

describe("layout edits", () => {
  const base = { order: ["attention", "fleet", "hottest", ...DASHBOARD_CARDS.filter((c) => !["attention", "fleet", "hottest"].includes(c))], hidden: [] } as ReturnType<typeof defaultLayout>;
  it("moves a card up and down and stops at the ends", () => {
    expect(moveCard(base, "fleet", -1).order.slice(0, 3)).toEqual(["fleet", "attention", "hottest"]);
    expect(moveCard(base, "fleet", 1).order.slice(0, 3)).toEqual(["attention", "hottest", "fleet"]);
    expect(moveCard(base, "attention", -1)).toBe(base);
    expect(moveCard(base, DASHBOARD_CARDS[DASHBOARD_CARDS.length - 1], 1)).toBe(base);
  });
  it("drops a card onto another card's position, both directions", () => {
    expect(dropCard(base, "hottest", "attention").order.slice(0, 3)).toEqual(["hottest", "attention", "fleet"]);
    expect(dropCard(base, "attention", "hottest").order.slice(0, 3)).toEqual(["fleet", "hottest", "attention"]);
    expect(dropCard(base, "fleet", "fleet")).toBe(base);
  });
  it("toggles visibility and visibleCards honours both order and hidden", () => {
    const hidden = toggleCard(base, "fleet");
    expect(hidden.hidden).toEqual(["fleet"]);
    expect(visibleCards(hidden)).not.toContain("fleet");
    expect(visibleCards(toggleCard(hidden, "fleet"))).toContain("fleet");
  });
});

describe("readLayout", () => {
  beforeEach(() => localStorage.clear());
  it("reads per user and survives corrupt storage", () => {
    localStorage.setItem("tugra.dashboardLayout.u1", JSON.stringify({ order: ["servers"], hidden: ["fleet"] }));
    const saved = readLayout("u1");
    expect(saved.hidden).toContain("fleet");
    expect(saved.order.indexOf("attention")).toBeLessThan(saved.order.indexOf("servers")); // a card missing from the save lands in its default place
    expect(readLayout("u2")).toEqual(defaultLayout());
    localStorage.setItem("tugra.dashboardLayout.u3", "{not json");
    expect(readLayout("u3")).toEqual(defaultLayout());
  });
});
