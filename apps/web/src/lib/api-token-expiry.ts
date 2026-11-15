const DAY_MS = 86_400_000;

/** A token flips to the amber "N days left" badge at or below this many days. */
export const TOKEN_EXPIRY_WARN_DAYS = 14;

export type TokenExpiry =
  | { state: "none" }
  | { state: "ok"; days: number }
  | { state: "soon"; days: number }
  | { state: "expired" };

/** Whole days until `expiresAt` (rounded up, so 'later today' is 1), classified for the badge. Pure. */
export function tokenExpiry(expiresAt: string | null, now: number = Date.now()): TokenExpiry {
  if (!expiresAt) return { state: "none" };
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return { state: "none" };
  if (ts <= now) return { state: "expired" };
  const days = Math.ceil((ts - now) / DAY_MS);
  return { state: days <= TOKEN_EXPIRY_WARN_DAYS ? "soon" : "ok", days };
}
