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

/**
 * The effective host port to build a domainless app's URL from. A COMPOSE/template app always stores
 * `hostPort: null` — its real published ports live in `portMappings` — so `appUrl` would call it
 * unreachable even though the stack listens on an allocated host port. Prefer the scalar `hostPort`
 * (docker-run apps); else, for a COMPOSE app, the PRIMARY web service's published port (the one the
 * domain would route to), falling back to the first published mapping. Null when nothing is published.
 */
export function primaryHostPort(
  app: { hostPort: number | null; source?: string | null; portMappings?: unknown },
  web: { service: string; port: number } | null,
): number | null {
  if (app.hostPort != null) return app.hostPort;
  if (app.source !== "COMPOSE" || !Array.isArray(app.portMappings)) return null; // Prisma JsonValue guard
  const maps = app.portMappings as { serviceName?: string; containerPort?: number; hostPort?: number }[];
  if (maps.length === 0) return null;
  const match = web ? maps.find((m) => m.serviceName === web.service && m.containerPort === web.port) : undefined;
  const hp = (match ?? maps[0])?.hostPort;
  return typeof hp === "number" ? hp : null;
}
