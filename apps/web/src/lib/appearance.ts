"use client";

import { useCallback, useEffect, useState } from "react";
import { MOBILE_QUERY, isMobileWidth } from "./responsive";
import {
  CUSTOM_PRESETS,
  CUSTOM_VAR_NAMES,
  DEFAULT_CUSTOM,
  customThemeVars,
  isHex,
  type CustomTheme,
} from "./theme-custom";

/**
 * Per-user appearance preferences (Settings → Appearance). Browser-local: every value lives in localStorage under
 * `tugra.*` and is applied as a `data-*` attribute on <html>, which globals.css keys off. The pre-paint script in
 * lib/appearance-script.ts applies the same keys before first paint so a reload never flashes the defaults.
 */

export type ThemeChoice = "system" | "light" | "dark" | "custom";
export type UiScale = "80" | "90" | "100";
export type PageWidth = "full" | "centered";
export type NavStyle = "default" | "floating";
export type UiStyle = "flat" | "3d";
export type ChartTimes = "local" | "localUtc";

export type Appearance = {
  theme: ThemeChoice;
  custom: CustomTheme;
  uiScale: UiScale;
  pageWidth: PageWidth;
  navStyle: NavStyle;
  uiStyle: UiStyle;
  chartTimes: ChartTimes;
};

export const THEMES: readonly ThemeChoice[] = ["light", "system", "dark", "custom"];
export const UI_SCALES: readonly UiScale[] = ["80", "90", "100"];
export const PAGE_WIDTHS: readonly PageWidth[] = ["full", "centered"];
export const NAV_STYLES: readonly NavStyle[] = ["default", "floating"];
export const UI_STYLES: readonly UiStyle[] = ["flat", "3d"];
export const CHART_TIMES: readonly ChartTimes[] = ["local", "localUtc"];

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "dark",
  custom: DEFAULT_CUSTOM,
  uiScale: "100",
  pageWidth: "full",
  navStyle: "default",
  uiStyle: "flat",
  chartTimes: "local",
};

/** localStorage keys. The `theme` key predates this module (the header button wrote it first). */
export const KEYS = {
  theme: "tugra.theme",
  custom: "tugra.themeCustom",
  customVars: "tugra.themeVars",
  uiScale: "tugra.uiScale",
  pageWidth: "tugra.pageWidth",
  navStyle: "tugra.navStyle",
  uiStyle: "tugra.uiStyle",
  chartTimes: "tugra.chartTimes",
} as const;

/** Same-tab change notification (the `storage` event only fires in OTHER tabs). */
export const APPEARANCE_EVENT = "tugra:appearance";

function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Values whose write was refused (storage blocked / full): kept for this page view so a change still sticks. */
const unsaved = new Map<string, string>();

/** Forget values kept after a failed write (tests). */
export function resetUnsavedAppearance(): void {
  unsaved.clear();
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? unsaved.get(key) ?? null;
  } catch {
    return unsaved.get(key) ?? null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, value);
  }
}

function parseCustom(raw: string | null): CustomTheme {
  if (!raw) return DEFAULT_CUSTOM;
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (isHex(o.accent) && isHex(o.tint)) {
        return { preset: typeof o.preset === "string" ? o.preset : "custom", accent: o.accent, tint: o.tint };
      }
    }
  } catch {
    /* corrupt value → default */
  }
  return DEFAULT_CUSTOM;
}

/** Read every preference, falling back to the default for a missing / unknown / unreadable value. */
export function readAppearance(): Appearance {
  const d = DEFAULT_APPEARANCE;
  return {
    theme: oneOf(THEMES, safeGet(KEYS.theme), d.theme),
    custom: parseCustom(safeGet(KEYS.custom)),
    uiScale: oneOf(UI_SCALES, safeGet(KEYS.uiScale), d.uiScale),
    pageWidth: oneOf(PAGE_WIDTHS, safeGet(KEYS.pageWidth), d.pageWidth),
    navStyle: oneOf(NAV_STYLES, safeGet(KEYS.navStyle), d.navStyle),
    uiStyle: oneOf(UI_STYLES, safeGet(KEYS.uiStyle), d.uiStyle),
    chartTimes: oneOf(CHART_TIMES, safeGet(KEYS.chartTimes), d.chartTimes),
  };
}

/** The "Chart times" preference alone, for non-hook callers (formatters). SSR-safe: "local" without storage. */
export function readChartTimes(): ChartTimes {
  return oneOf(CHART_TIMES, safeGet(KEYS.chartTimes), "local");
}

/** Resolve a theme choice to the concrete value written to <html data-theme>. */
export function resolveThemeChoice(theme: ThemeChoice, prefersDark: boolean): "light" | "dark" | "custom" {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

/**
 * The UI scale that actually applies at a viewport width. Phones always render at 100 % (a shrunken UI there
 * only makes tap targets and text unreadable) — same rule as Coolify. globals.css enforces it live with a media
 * query; this mirrors it for the settings UI and tests.
 */
export function effectiveUiScale(scale: UiScale, viewportWidth: number): UiScale {
  return isMobileWidth(viewportWidth) ? "100" : scale;
}

function osPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Write the preferences onto <html>: the `data-*` attributes plus (custom theme only) the inline CSS variables. */
export function applyAppearance(root: HTMLElement, a: Appearance, prefersDark: boolean): void {
  const concrete = resolveThemeChoice(a.theme, prefersDark);
  root.setAttribute("data-theme", concrete);
  for (const name of CUSTOM_VAR_NAMES) root.style.removeProperty(name);
  if (concrete === "custom") {
    const vars = customThemeVars(a.custom);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }
  root.setAttribute("data-ui-scale", a.uiScale);
  root.setAttribute("data-page-width", a.pageWidth);
  root.setAttribute("data-nav-style", a.navStyle);
  root.setAttribute("data-ui-style", a.uiStyle);
}

function persist(a: Appearance): void {
  safeSet(KEYS.theme, a.theme);
  safeSet(KEYS.custom, JSON.stringify(a.custom));
  // The pre-paint script applies these derived variables as-is, so it needs no colour maths of its own.
  safeSet(KEYS.customVars, JSON.stringify(customThemeVars(a.custom)));
  safeSet(KEYS.uiScale, a.uiScale);
  safeSet(KEYS.pageWidth, a.pageWidth);
  safeSet(KEYS.navStyle, a.navStyle);
  safeSet(KEYS.uiStyle, a.uiStyle);
  safeSet(KEYS.chartTimes, a.chartTimes);
}

export type UseAppearance = Appearance & {
  /** True once the stored values were read (before that, the SSR defaults are shown). */
  loaded: boolean;
  /** The theme actually on screen (system resolved against the OS). */
  resolvedTheme: "light" | "dark" | "custom";
  /** The scale in effect right now (always "100" on a phone). */
  effectiveScale: UiScale;
  setTheme: (v: ThemeChoice) => void;
  setCustom: (v: Partial<CustomTheme>) => void;
  /** Pick a built-in preset (sets both colours and switches to the custom theme). */
  applyPreset: (id: string) => void;
  setUiScale: (v: UiScale) => void;
  setPageWidth: (v: PageWidth) => void;
  setNavStyle: (v: NavStyle) => void;
  setUiStyle: (v: UiStyle) => void;
  setChartTimes: (v: ChartTimes) => void;
  /** Header quick-cycle: system → light → dark → system (a custom theme is chosen on the Appearance page). */
  cycleTheme: () => void;
};

/** Cycle order for the header button; "custom" steps back into the cycle at "system". */
export function nextThemeChoice(theme: ThemeChoice): ThemeChoice {
  return theme === "system" ? "light" : theme === "light" ? "dark" : "system";
}

/**
 * Owns every appearance preference. SSR renders the defaults; after mount the stored values are read, and from
 * then on each change is persisted (try/catch) and applied to <html>. Several instances (the header button and
 * the Appearance card) stay in sync through a same-tab event and the cross-tab `storage` event.
 */
export function useAppearance(): UseAppearance {
  const [a, setA] = useState<Appearance>(DEFAULT_APPEARANCE);
  const [loaded, setLoaded] = useState(false);
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const reload = () => {
      setA(readAppearance());
      setLoaded(true);
    };
    reload();
    window.addEventListener(APPEARANCE_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(APPEARANCE_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Apply only after the stored values were read, so the SSR defaults never overwrite what the pre-paint script set.
  useEffect(() => {
    if (!loaded) return;
    applyAppearance(document.documentElement, a, osPrefersDark());
    if (a.theme !== "system" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyAppearance(document.documentElement, a, mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [a, loaded]);

  const update = useCallback((patch: Partial<Appearance>) => {
    // Merge into the freshest stored values, so two hook instances never overwrite each other with stale state.
    const next = { ...readAppearance(), ...patch };
    persist(next);
    setA(next);
    setLoaded(true);
    window.dispatchEvent(new Event(APPEARANCE_EVENT));
  }, []);

  return {
    ...a,
    loaded,
    resolvedTheme: resolveThemeChoice(a.theme, loaded && osPrefersDark()),
    effectiveScale: mobile ? "100" : a.uiScale,
    setTheme: (theme) => update({ theme }),
    setCustom: (v) => update({ custom: { ...a.custom, preset: "custom", ...v } }),
    applyPreset: (id) => {
      const p = CUSTOM_PRESETS.find((x) => x.id === id);
      if (p) update({ theme: "custom", custom: { preset: p.id, accent: p.accent, tint: p.tint } });
    },
    setUiScale: (uiScale) => update({ uiScale }),
    setPageWidth: (pageWidth) => update({ pageWidth }),
    setNavStyle: (navStyle) => update({ navStyle }),
    setUiStyle: (uiStyle) => update({ uiStyle }),
    setChartTimes: (chartTimes) => update({ chartTimes }),
    cycleTheme: () => update({ theme: nextThemeChoice(a.theme) }),
  };
}

/**
 * Just the "Chart times" preference, live — a light alternative to useAppearance() for components that only
 * format timestamps (many chart instances mount at once, and they must not each apply <html> attributes).
 */
export function useChartTimes(): ChartTimes {
  const [mode, setMode] = useState<ChartTimes>("local");
  useEffect(() => {
    const read = () => setMode(readChartTimes());
    read();
    window.addEventListener(APPEARANCE_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(APPEARANCE_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return mode;
}
