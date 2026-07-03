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
 * - "home": only items flagged `home: true`.
 * - "fleet": everything except items flagged `fleet: false` (home-only items).
 * Groups left empty are dropped.
 */
export function navForMode<T extends { home?: boolean; fleet?: boolean }>(
  groups: NavGroup<T>[],
  mode: UiMode,
): NavGroup<T>[] {
  const keep = (i: T) => (mode === "home" ? i.home === true : i.fleet !== false);
  return groups
    .map((g) => ({ ...g, items: g.items.filter(keep) }))
    .filter((g) => g.items.length > 0);
}
