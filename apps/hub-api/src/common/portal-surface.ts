import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The customer-portal surface. A member whose custom role is a portal preset ("Client", TeamRole.portal) may only
 * reach the routes below: their team's apps, uptime and backups (read), plus deploying an app (still gated by the
 * role's `apps:deploy` permission). On every other route the hub answers as if that membership did not exist (a
 * list comes back without the team, a by-id read is a 403), so no team-wide read — servers, members, channels,
 * variables, audit, git sources, … — is reachable through a Client account, whatever the endpoint.
 *
 * Paths are relative to the global `/api/v1` prefix. Resource ids are one path segment.
 */
const SEG = "[^/]+";
const PORTAL_GET: RegExp[] = [
  /^\/teams$/,
  new RegExp(`^/teams/(?!invitations$)${SEG}$`),
  new RegExp(`^/teams/${SEG}/icon$`),
  /^\/apps$/,
  new RegExp(`^/apps/(?!templates$|domains$)${SEG}$`),
  new RegExp(`^/apps/${SEG}/(deployments|runtime-state|icon|volume-backups)$`),
  new RegExp(`^/apps/${SEG}/deployments/${SEG}$`),
  /^\/databases$/,
  new RegExp(`^/databases/${SEG}$`),
  new RegExp(`^/databases/${SEG}/(backups|backup-usage|icon)$`),
  /^\/monitors$/,
  new RegExp(`^/monitors/${SEG}$`),
  new RegExp(`^/monitors/${SEG}/(heartbeats|uptime)$`),
  /^\/projects$/,
  new RegExp(`^/projects/(?!empty-defaults$)${SEG}$`),
  new RegExp(`^/projects/${SEG}/icon$`),
];
const PORTAL_POST: RegExp[] = [new RegExp(`^/apps/${SEG}/deploy$`)];

/** Strip the query string, the `/api/v1` prefix and any trailing slash. */
export function normalizeApiPath(raw: string): string {
  const p = String(raw ?? "").split("?")[0].replace(/\/+$/, "").replace(/^\/api\/v1(?=\/|$)/, "");
  return p === "" ? "/" : p;
}

/** True when a portal (Client) member may call this route. */
export function isPortalRoute(method: string, rawPath: string): boolean {
  const path = normalizeApiPath(rawPath);
  const m = String(method ?? "GET").toUpperCase();
  if (m === "GET") return PORTAL_GET.some((re) => re.test(path));
  if (m === "POST") return PORTAL_POST.some((re) => re.test(path));
  return false;
}

interface PortalStore {
  /** True when the current request is on the portal surface (portal memberships count as memberships). */
  surface: boolean;
}

export const portalContext = new AsyncLocalStorage<PortalStore>();

/** True while serving an HTTP request that is OFF the portal surface: portal memberships must be treated as absent.
 *  Outside a request (jobs, tests, other transports) nothing is hidden. */
export function portalMembershipsHidden(): boolean {
  return portalContext.getStore()?.surface === false;
}
