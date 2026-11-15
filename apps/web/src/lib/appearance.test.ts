import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_APPEARANCE,
  KEYS,
  applyAppearance,
  effectiveUiScale,
  nextThemeChoice,
  readAppearance,
  readChartTimes,
  resetUnsavedAppearance,
  resolveThemeChoice,
  useAppearance,
} from "./appearance";

function mockMatchMedia(opts: { dark?: boolean; mobile?: boolean }) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("prefers-color-scheme") ? !!opts.dark : q.includes("max-width") ? !!opts.mobile : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  resetUnsavedAppearance();
  mockMatchMedia({});
  for (const a of ["data-theme", "data-ui-scale", "data-page-width", "data-nav-style", "data-ui-style"]) root().removeAttribute(a);
  root().removeAttribute("style");
});
afterEach(() => vi.unstubAllGlobals());

describe("readAppearance", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE).toMatchObject({ theme: "dark", uiScale: "100", pageWidth: "full", navStyle: "default", uiStyle: "flat", chartTimes: "local" });
  });

  it("reads stored values and ignores unknown / corrupt ones", () => {
    localStorage.setItem(KEYS.theme, "custom");
    localStorage.setItem(KEYS.uiScale, "80");
    localStorage.setItem(KEYS.pageWidth, "centered");
    localStorage.setItem(KEYS.navStyle, "floating");
    localStorage.setItem(KEYS.uiStyle, "3d");
    localStorage.setItem(KEYS.chartTimes, "localUtc");
    localStorage.setItem(KEYS.custom, JSON.stringify({ preset: "rose", accent: "#fb7185", tint: "#8b5a6b" }));
    expect(readAppearance()).toEqual({
      theme: "custom",
      custom: { preset: "rose", accent: "#fb7185", tint: "#8b5a6b" },
      uiScale: "80",
      pageWidth: "centered",
      navStyle: "floating",
      uiStyle: "3d",
      chartTimes: "localUtc",
    });
    localStorage.setItem(KEYS.theme, "neon");
    localStorage.setItem(KEYS.uiScale, "150");
    localStorage.setItem(KEYS.custom, "{not json");
    const a = readAppearance();
    expect(a.theme).toBe("dark");
    expect(a.uiScale).toBe("100");
    expect(a.custom).toEqual(DEFAULT_APPEARANCE.custom);
  });

  it("falls back to defaults when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
    expect(readChartTimes()).toBe("local");
    vi.restoreAllMocks();
  });
});

describe("pure helpers", () => {
  it("resolveThemeChoice follows the OS only for system", () => {
    expect(resolveThemeChoice("system", true)).toBe("dark");
    expect(resolveThemeChoice("system", false)).toBe("light");
    expect(resolveThemeChoice("light", true)).toBe("light");
    expect(resolveThemeChoice("custom", false)).toBe("custom");
  });

  it("nextThemeChoice cycles system → light → dark → system and re-enters from custom", () => {
    expect(nextThemeChoice("system")).toBe("light");
    expect(nextThemeChoice("light")).toBe("dark");
    expect(nextThemeChoice("dark")).toBe("system");
    expect(nextThemeChoice("custom")).toBe("system");
  });

  it("effectiveUiScale is always 100 on a phone, the chosen scale otherwise", () => {
    expect(effectiveUiScale("80", 375)).toBe("100");
    expect(effectiveUiScale("90", 767)).toBe("100");
    expect(effectiveUiScale("80", 768)).toBe("80");
    expect(effectiveUiScale("90", 1440)).toBe("90");
  });

  it("applyAppearance writes the data attributes and, for custom, the inline variables (cleared again afterwards)", () => {
    applyAppearance(root(), { ...DEFAULT_APPEARANCE, theme: "custom", uiScale: "90", pageWidth: "centered", navStyle: "floating", uiStyle: "3d" }, false);
    expect(root().getAttribute("data-theme")).toBe("custom");
    expect(root().getAttribute("data-ui-scale")).toBe("90");
    expect(root().getAttribute("data-page-width")).toBe("centered");
    expect(root().getAttribute("data-nav-style")).toBe("floating");
    expect(root().getAttribute("data-ui-style")).toBe("3d");
    expect(root().style.getPropertyValue("--c-a")).toBe("#d4af6a");
    expect(root().style.getPropertyValue("--c-on-a")).toBe("#0d0d11");
    applyAppearance(root(), { ...DEFAULT_APPEARANCE, theme: "light" }, false);
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(root().style.getPropertyValue("--c-a")).toBe("");
    applyAppearance(root(), { ...DEFAULT_APPEARANCE, theme: "system" }, true);
    expect(root().getAttribute("data-theme")).toBe("dark");
  });
});

describe("useAppearance", () => {
  it("starts on the defaults, hydrates from storage, then applies to <html>", () => {
    localStorage.setItem(KEYS.theme, "light");
    localStorage.setItem(KEYS.uiScale, "90");
    const { result } = renderHook(() => useAppearance());
    expect(result.current.loaded).toBe(true);
    expect(result.current.theme).toBe("light");
    expect(result.current.uiScale).toBe("90");
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(root().getAttribute("data-ui-scale")).toBe("90");
  });

  it("persists each change to localStorage and applies it", () => {
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.setPageWidth("centered"));
    act(() => result.current.setNavStyle("floating"));
    act(() => result.current.setUiStyle("3d"));
    act(() => result.current.setChartTimes("localUtc"));
    act(() => result.current.setUiScale("80"));
    expect(localStorage.getItem(KEYS.pageWidth)).toBe("centered");
    expect(localStorage.getItem(KEYS.navStyle)).toBe("floating");
    expect(localStorage.getItem(KEYS.uiStyle)).toBe("3d");
    expect(localStorage.getItem(KEYS.chartTimes)).toBe("localUtc");
    expect(localStorage.getItem(KEYS.uiScale)).toBe("80");
    expect(root().getAttribute("data-page-width")).toBe("centered");
    expect(root().getAttribute("data-ui-scale")).toBe("80");
    // a fresh hook instance (a reload) reads the same values back
    const again = renderHook(() => useAppearance());
    expect(again.result.current.uiStyle).toBe("3d");
    expect(again.result.current.chartTimes).toBe("localUtc");
  });

  it("reports scale 100 as effective on a phone while keeping the stored choice", () => {
    mockMatchMedia({ mobile: true });
    localStorage.setItem(KEYS.uiScale, "80");
    const { result } = renderHook(() => useAppearance());
    expect(result.current.uiScale).toBe("80");
    expect(result.current.effectiveScale).toBe("100");
  });

  it("custom theme: a preset sets both colours, stores ready-made variables for the pre-paint script", () => {
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.applyPreset("forest"));
    expect(result.current.theme).toBe("custom");
    expect(result.current.custom).toMatchObject({ preset: "forest", accent: "#4ade80" });
    expect(root().getAttribute("data-theme")).toBe("custom");
    const vars = JSON.parse(localStorage.getItem(KEYS.customVars) ?? "{}") as Record<string, string>;
    expect(vars["--c-a"]).toBe("#4ade80");
    expect(vars["--c-on-a"]).toBe("#0d0d11"); // light green accent → dark text on it
    act(() => result.current.setCustom({ accent: "#1e3a8a" }));
    expect(result.current.custom.preset).toBe("custom");
    // dark navy is lightened to stay readable on the dark surface; its fill text is then computed from that
    const v2 = JSON.parse(localStorage.getItem(KEYS.customVars) ?? "{}") as Record<string, string>;
    expect(root().style.getPropertyValue("--c-on-a")).toBe(v2["--c-on-a"]);
  });

  it("cycleTheme walks system → light → dark and leaves custom for system", () => {
    localStorage.setItem(KEYS.theme, "system");
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe("light");
    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe("dark");
    act(() => result.current.setTheme("custom"));
    act(() => result.current.cycleTheme());
    expect(result.current.theme).toBe("system");
  });

  it("keeps two hook instances in sync (header button + settings card)", () => {
    const a = renderHook(() => useAppearance());
    const b = renderHook(() => useAppearance());
    act(() => a.result.current.setTheme("light"));
    expect(b.result.current.theme).toBe("light");
  });

  it("survives storage that throws on write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useAppearance());
    act(() => result.current.setUiStyle("3d"));
    expect(result.current.uiStyle).toBe("3d");
    expect(root().getAttribute("data-ui-style")).toBe("3d");
    vi.restoreAllMocks();
  });
});

describe("globals.css appearance rules", () => {
  const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");

  it("scales via zoom and forces 100% below 640px, after the scale rules", () => {
    const scale90 = css.indexOf('html[data-ui-scale="90"] body');
    const scale80 = css.indexOf('html[data-ui-scale="80"] body');
    const phone = css.indexOf("@media (max-width: 639px) {\n  html[data-ui-scale] body");
    expect(scale90).toBeGreaterThan(-1);
    expect(scale80).toBeGreaterThan(-1);
    expect(phone).toBeGreaterThan(scale90);
    expect(phone).toBeGreaterThan(scale80);
    expect(css.slice(phone, phone + 160)).toMatch(/zoom:\s*1/);
  });

  it("styles the centered width, floating nav and 3D style hooks", () => {
    expect(css).toContain('html[data-page-width="centered"] .tg-main > *');
    expect(css).toContain('html[data-nav-style="floating"] .tg-sidebar');
    expect(css).toContain('html[data-ui-style="3d"] .tg-card');
  });
});
