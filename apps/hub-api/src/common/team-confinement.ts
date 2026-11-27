import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Team confinement for a token that was granted to ONE team (an MCP OAuth grant). While a call runs inside
 * `teamConfinement.run({ teamId }, ...)`, every membership read answers as if the user belonged to that team
 * only, so each team-scoped service (which resolves access through the user's memberships) stays inside the
 * team the owner picked on the consent screen. Outside such a call nothing is hidden.
 */
export const teamConfinement = new AsyncLocalStorage<{ teamId: string }>();

/** True when the current call is confined to a team other than `teamId`. */
export function teamHiddenByConfinement(teamId: string): boolean {
  const s = teamConfinement.getStore();
  return !!s && s.teamId !== teamId;
}
