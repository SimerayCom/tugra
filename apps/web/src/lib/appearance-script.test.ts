import { describe, it, expect, beforeEach } from "vitest";
import { APPEARANCE_PREPAINT } from "./appearance-script";
import { CHART_TIMES, KEYS, NAV_STYLES, PAGE_WIDTHS, UI_SCALES, UI_STYLES } from "./appearance";
import { customThemeVars, DEFAULT_CUSTOM } from "./theme-custom";

const run = () => new Function(APPEARANCE_PREPAINT)();
const root = () => document.documentElement;

beforeEach(() => {
  localStorage.clear();
  for (const a of ["data-theme", "data-ui-scale", "data-page-width", "data-nav-style", "data-ui-style"]) root().removeAttribute(a);
  root().removeAttribute("style");
});

describe("APPEARANCE_PREPAINT", () => {
  it("is tiny, self-contained and wrapped so it can never throw", () => {
    expect(APPEARANCE_PREPAINT.length).toBeLessThan(1100);
    expect(APPEARANCE_PREPAINT.startsWith("try{")).toBe(true);
    expect(APPEARANCE_PREPAINT.endsWith("catch(e){}")).toBe(true);
    expect(APPEARANCE_PREPAINT).not.toMatch(/\bimport\b|\brequire\b/);
  });

  it("uses the same storage keys and value lists as lib/appearance.ts", () => {
    for (const k of ["theme", "themeVars"]) expect(APPEARANCE_PREPAINT).toContain(`'${k}'`);
    for (const k of ["uiScale", "pageWidth", "navStyle", "uiStyle"]) {
      expect(APPEARANCE_PREPAINT).toContain(`${k}:[`);
      expect(KEYS[k as keyof typeof KEYS]).toBe(`tugra.${k}`);
    }
    expect(KEYS.theme).toBe("tugra.theme");
    expect(KEYS.customVars).toBe("tugra.themeVars");
    expect(Object.values(KEYS).every((v) => v.startsWith("tugra."))).toBe(true);
    for (const list of [UI_SCALES, PAGE_WIDTHS, NAV_STYLES, UI_STYLES]) {
      for (const v of list) expect(APPEARANCE_PREPAINT).toContain(`'${v}'`);
    }
    // chartTimes is a pure formatting preference, not something to paint
    expect(CHART_TIMES.length).toBe(2);
    expect(APPEARANCE_PREPAINT).not.toContain("chartTimes");
  });

  it("applies stored scale, width, nav and style attributes", () => {
    localStorage.setItem(KEYS.theme, "light");
    localStorage.setItem(KEYS.uiScale, "90");
    localStorage.setItem(KEYS.pageWidth, "centered");
    localStorage.setItem(KEYS.navStyle, "floating");
    localStorage.setItem(KEYS.uiStyle, "3d");
    run();
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(root().getAttribute("data-ui-scale")).toBe("90");
    expect(root().getAttribute("data-page-width")).toBe("centered");
    expect(root().getAttribute("data-nav-style")).toBe("floating");
    expect(root().getAttribute("data-ui-style")).toBe("3d");
  });

  it("ignores unknown values and defaults to dark", () => {
    localStorage.setItem(KEYS.uiScale, "150");
    localStorage.setItem(KEYS.navStyle, "wild");
    run();
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(root().hasAttribute("data-ui-scale")).toBe(false);
    expect(root().hasAttribute("data-nav-style")).toBe(false);
  });

  it("resolves system against the OS", () => {
    localStorage.setItem(KEYS.theme, "system");
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("dark"), media: q })) as unknown as typeof window.matchMedia;
    run();
    expect(root().getAttribute("data-theme")).toBe("dark");
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
    run();
    expect(root().getAttribute("data-theme")).toBe("light");
    window.matchMedia = mm;
  });

  it("custom theme: sets data-theme=custom and the stored variables inline", () => {
    const vars = customThemeVars(DEFAULT_CUSTOM);
    localStorage.setItem(KEYS.theme, "custom");
    localStorage.setItem(KEYS.customVars, JSON.stringify(vars));
    run();
    expect(root().getAttribute("data-theme")).toBe("custom");
    expect(root().style.getPropertyValue("--c-a")).toBe(vars["--c-a"]);
    expect(root().style.getPropertyValue("--c-on-a")).toBe(vars["--c-on-a"]);
  });

  it("custom theme without stored variables falls back to dark", () => {
    localStorage.setItem(KEYS.theme, "custom");
    run();
    expect(root().getAttribute("data-theme")).toBe("dark");
  });
});
