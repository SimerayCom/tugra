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

export type AppLinkKind = "primary" | "alias" | "service" | "port";

/** One externally-openable address of an app. `url` is always http(s). `host` is the hostname for a domain-backed
 *  link (null for a raw IP:port); `label` is the compose service (`service`) or `service:containerPort` (`port`). */
export interface AppLink {
  kind: AppLinkKind;
  url: string;
  host: string | null;
  label: string | null;
}

/** Upper bound on links per app (a runaway alias/service list must not bloat every list response). */
export const MAX_APP_LINKS = 50;

/**
 * Every externally-openable address of an app, primary first: the primary URL, multi-domain aliases, per-service
 * compose domains, then the published host ports of a compose app. Deduped by URL (first wins) and capped.
 *
 * - `primaryUrl` is the already-computed `appUrl(...)` so `links[0].url === url` always holds.
 * - Aliases and per-service domains are always `https://` (their Traefik routers are hard-wired to `websecure`).
 * - Only `hostPort`-mode compose mappings are published on the host; a `domain`-mode mapping is reached through
 *   its domain, so it never becomes a port link. Needs a known public IP, like the primary's IP:port fallback.
 */
export function appLinks(
  app: { domain: string | null; extraDomains?: string[] | null; source?: string | null; portMappings?: unknown },
  o: { publicIp: string | null | undefined; primaryUrl: string | null; serviceDomains: { service: string; hostname: string }[] },
): AppLink[] {
  const out: AppLink[] = [];
  const seen = new Set<string>();
  const add = (link: AppLink) => {
    if (out.length >= MAX_APP_LINKS || seen.has(link.url)) return;
    seen.add(link.url);
    out.push(link);
  };

  if (o.primaryUrl) add({ kind: "primary", url: o.primaryUrl, host: app.domain ?? null, label: null });

  const base = app.domain ? app.domain.replace(/^www\./i, "").toLowerCase() : null;
  for (const raw of app.extraDomains ?? []) {
    const h = (raw ?? "").trim();
    if (!h || h === app.domain) continue;
    if (base && (h.toLowerCase() === base || h.toLowerCase() === `www.${base}`)) continue; // the canonical www/bare twin is a redirect, not an alias
    add({ kind: "alias", url: `https://${h}`, host: h, label: null });
  }

  for (const row of o.serviceDomains) {
    if (!row.hostname) continue;
    add({ kind: "service", url: `https://${row.hostname}`, host: row.hostname, label: row.service });
  }

  if (app.source === "COMPOSE" && o.publicIp && Array.isArray(app.portMappings)) {
    const ip = isIpv6(o.publicIp) ? `[${o.publicIp}]` : o.publicIp;
    for (const m of app.portMappings as { serviceName?: unknown; containerPort?: unknown; hostPort?: unknown; mode?: unknown }[]) {
      if (m?.mode !== "hostPort" || typeof m.hostPort !== "number") continue;
      const label = typeof m.serviceName === "string" && typeof m.containerPort === "number" ? `${m.serviceName}:${m.containerPort}` : null;
      add({ kind: "port", url: `http://${ip}:${m.hostPort}`, host: null, label });
    }
  }
  return out;
}
