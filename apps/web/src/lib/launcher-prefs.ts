import type { LauncherTile } from "./launcher";

// Per-browser launcher preferences. Pins are a convenience (which apps float to the top), so localStorage is
// the right home: they don't need to roam or be read back by the server. Every access is wrapped — a private
// window or blocked storage must not break the launcher.
const PINS_KEY = "tugra.launcher.pins";

export function loadPins(): Set<string> {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    // Validate the shape — a corrupted/foreign value (e.g. the string "abc") must not become new Set("abc").
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function savePins(pins: Set<string>): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify([...pins]));
  } catch {
    /* storage unavailable (private window / blocked) — pins just don't persist this session */
  }
}

/** Add or remove an id, returning a NEW set (so React state updates trigger a re-render). */
export function togglePin(pins: Set<string>, id: string): Set<string> {
  const next = new Set(pins);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Case-insensitive name filter for the launcher search box. */
export function filterTiles(tiles: LauncherTile[], q: string): LauncherTile[] {
  const needle = q.trim().toLowerCase();
  return needle ? tiles.filter((t) => t.name.toLowerCase().includes(needle)) : tiles;
}

/** Stable re-sort putting pinned tiles first while preserving the incoming order within each group
 *  (launcherTiles already orders by running/openable then name). */
export function sortByPins(tiles: LauncherTile[], pinned: Set<string>): LauncherTile[] {
  return [...tiles].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
}
