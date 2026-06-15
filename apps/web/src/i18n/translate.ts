export type Messages = Record<string, unknown>;

/**
 * Resolve a dotted key (e.g. "servers.title") in a nested messages object and
 * interpolate {vars}. Returns the key itself if missing (so gaps are visible).
 */
export function translate(
  dict: Messages,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const raw = key.split(".").reduce<unknown>(
    (o, k) => (o && typeof o === "object" ? (o as Messages)[k] : undefined),
    dict,
  );
  if (typeof raw !== "string") return key;
  if (!vars) return raw;
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.replaceAll(`{${k}}`, String(v)),
    raw,
  );
}
