/** Resolve the active detail-page tab from a ?tab= value, validated against the
 * currently-available tabs (falls back so a stale/forbidden deep-link is never blank). */
export function resolveTab(raw: string | null | undefined, validKeys: string[], fallback: string): string {
  return raw && validKeys.includes(raw) ? raw : fallback;
}
