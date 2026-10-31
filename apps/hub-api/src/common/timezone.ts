/**
 * Validate an IANA timezone name (e.g. "Europe/Istanbul", "UTC") at runtime. There is no static list in
 * Node, so we ask Intl to build a formatter for the zone — an unknown zone throws a RangeError. Pure +
 * dependency-free so it is unit-testable and reusable (DTO refine + service).
 */
export function isValidIana(tz: string): boolean {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
