import type { Team } from "./types";

/** The teams where the caller is a Client (customer portal). */
export function clientTeams(teams: Team[]): Team[] {
  return teams.filter((t) => !!t.clientAccess);
}

export function hasClientTeam(teams: Team[]): boolean {
  return clientTeams(teams).length > 0;
}

/**
 * A portal-only account: a Client of at least one team and nothing else of its own. Every account gets a personal
 * team at sign-up, so "nothing else" means every non-client team is that solo team (one member). Such an account
 * lands on the portal and the sidebar shows the portal only; anyone who manages a real team keeps the full app.
 */
export function isPortalOnly(teams: Team[]): boolean {
  if (!hasClientTeam(teams)) return false;
  return teams.filter((t) => !t.clientAccess).every((t) => (t.memberCount ?? 1) <= 1);
}

/** Routes a portal-only account may open (the portal and its own account settings); the rest redirect to /portal. */
export const PORTAL_ROUTES = ["/portal", "/settings"];

export function isPortalAllowed(pathname: string): boolean {
  return PORTAL_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}
