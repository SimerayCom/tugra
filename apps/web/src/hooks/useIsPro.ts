import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * Pro-edition state for gating Pro-only UI (secret stores, branding, SCIM, …). Reads the PUBLIC
 * GET /instance/status, so every team member can see it — do NOT gate on instance ownership.
 *
 * Tri-state: `ready` is false while the status loads. Gate controls on `!ready` (disabled, no upsell)
 * and only show the upsell when `ready && !isPro`, so a Pro user never sees an upsell flash. The
 * ["instanceStatus"] queryKey is shared with other callers (e.g. BrandingCard) so the cache is reused.
 */
export function useIsPro(): { ready: boolean; isPro: boolean } {
  const { data } = useQuery({ queryKey: ["instanceStatus"], queryFn: () => api.getInstanceStatus(), staleTime: 60_000 });
  return { ready: !!data, isPro: !!data && data.edition !== "community" };
}
