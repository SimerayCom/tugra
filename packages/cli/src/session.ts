import { getActiveProfile } from "./config";
import { TugraClient } from "./client";

/** Trim a trailing slash and reject anything that isn't an http(s) URL. */
export function normalizeHub(hub: string): string {
  const h = hub.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(h)) throw new Error("hub URL must start with http:// or https://");
  return h;
}

/** Build a client for the active profile, or fail with a friendly hint if not logged in. */
export function activeClient(): { client: TugraClient; name: string; hub: string } {
  const active = getActiveProfile();
  if (!active) throw new Error("not logged in — run `tugra login --hub <url>` first");
  return { client: new TugraClient(active.profile), name: active.name, hub: active.profile.hub };
}

/** Mask a token for display so it never leaks in `ctx` output: tugra_pat_1234…. */
export function maskToken(token: string): string {
  if (token.length <= 14) return "****";
  return `${token.slice(0, 14)}…`;
}
