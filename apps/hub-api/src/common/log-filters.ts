// Pure normalizers for the container-log filter query params. `since` and `search` are SIGNED fields
// (canonicalLogStart) that also reach `docker logs --since` / `grep -iF` on the agent — so a bad
// value is dropped to "" here (never thrown), which the agent verifies as the same empty string.

const SINCE_RE = /^\d+[smhd]$/; // e.g. "30s", "5m", "1h", "2d"
const SEARCH_RE = /^[a-zA-Z0-9 ._-]{0,200}$/;

/** A relative docker `--since` window, or "" (no window / "all"). Invalid input drops to "". */
export function normalizeSince(since?: string): string {
  if (!since || since === "all") return "";
  return SINCE_RE.test(since) ? since : "";
}

/** A grep -iF search term (bounded, sane charset), or "" (no filter). Invalid input drops to "". */
export function normalizeSearch(search?: string): string {
  if (!search) return "";
  return SEARCH_RE.test(search) ? search : "";
}

/** Clamp a tail line count into [1, max] (default max 2000), defaulting a non-finite value to `def`. */
export function clampTail(tail?: number, max = 2000, def = 200): number {
  const n = Number.isFinite(tail) ? (tail as number) : def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}
