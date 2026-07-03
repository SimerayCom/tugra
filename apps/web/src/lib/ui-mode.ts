// The UI persona a user is in. "fleet" is the full PaaS/ops surface (default);
// "home" is the simplified launcher-style surface (CasaOS-like) that hides
// fleet-only chrome and navigation.
export type UiMode = "fleet" | "home";

export const UI_MODES: UiMode[] = ["fleet", "home"];

export function isUiMode(v: unknown): v is UiMode {
  return v === "fleet" || v === "home";
}

/** Normalize any stored/unknown value to a valid UiMode (defaults to "fleet"). */
export function uiMode(v: unknown): UiMode {
  return isUiMode(v) ? v : "fleet";
}

type NavGroup<T> = { group: string; items: T[] };

/**
 * Filter navigation groups for the active UI mode.
 * - "fleet": the full nav, unchanged.
 * - "home": only items flagged `home: true`; groups left empty are dropped.
 */
export function navForMode<T extends { home?: boolean }>(
  groups: NavGroup<T>[],
  mode: UiMode,
): NavGroup<T>[] {
  if (mode !== "home") return groups;
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => i.home === true) }))
    .filter((g) => g.items.length > 0);
}
