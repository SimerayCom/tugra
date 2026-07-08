import { isIpv6 } from "./observed-ip";

/**
 * The externally-openable URL for an application, or null when it isn't reachable.
 *
 * A domained app uses its domain (https or http per `app.https`) — this is the
 * primary, TLS-terminated address. A domainless app is reachable only when it
 * publishes a host port (deploy binds `-p <hostPort>:<containerPort>`, and only
 * for domainless apps — see deploy-script) AND its server has a known public IP;
 * then `http://<ip>:<hostPort>` (raw IP:port is always plain http — there is no
 * cert for a bare IP; an IPv6 literal is bracketed). Otherwise null, because a
 * synthesized port with no published binding or no reachable host is a dead link.
 */
export function appUrl(
  app: { domain: string | null; https: boolean; hostPort: number | null },
  publicIp: string | null | undefined,
): string | null {
  if (app.domain) return `${app.https ? "https" : "http"}://${app.domain}`;
  if (app.hostPort != null && publicIp) {
    const host = isIpv6(publicIp) ? `[${publicIp}]` : publicIp;
    return `http://${host}:${app.hostPort}`;
  }
  return null;
}
