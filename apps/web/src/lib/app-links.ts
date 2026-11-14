import type { AppLink } from "./types";

/** Display text for a link: its hostname, or `ip:port` for a raw address. */
export function linkLabel(link: AppLink): string {
  if (link.host) return link.host;
  try {
    return new URL(link.url).host;
  } catch {
    return link.url;
  }
}
