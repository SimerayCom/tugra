/**
 * Hub reachability signal. `apiFetch` reports here when a request failed because the hub is restarting or
 * unreachable (network failure, or a proxy 502/503/504); the shell's connection banner subscribes, pings the
 * public status endpoint until it answers, then clears and refreshes every query.
 */
import en from "../i18n/locales/en";
import { translate } from "../i18n/translate";

/** Machine code carried on the ApiError thrown for an unreachable/restarting hub. */
export const HUB_UNREACHABLE_CODE = "hub_unreachable";

/** HTTP statuses a reverse proxy returns while the upstream (hub-api) is down or restarting. */
export function isHubDownStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

/** True when a thrown fetch error is a network failure or a timeout abort (not a deliberate caller abort). */
export function isNetworkFailure(e: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return false; // the caller cancelled on purpose (unmount, supersede) — not a hub problem
  if (e instanceof TypeError) return true; // fetch rejects with TypeError("Failed to fetch") on network errors
  return typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError";
}

/** The friendly, localised message shown instead of a raw "Failed to fetch" / "HTTP 502". */
export function hubUnreachableMessage(): string {
  return translate(en, "errors.hubUnreachable");
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeHubDown(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function reportHubDown(): void {
  for (const fn of listeners) fn();
}
