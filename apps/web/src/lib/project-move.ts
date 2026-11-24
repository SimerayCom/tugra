import type { Team } from "./types";

/**
 * The teams a project can move to: every other team the user can manage (owner or admin). The hub re-checks the
 * `projects` permission on both teams, so this only keeps obviously-refused choices out of the list.
 */
export function moveTargets(teams: Team[], currentTeamId: string): Team[] {
  return teams.filter((tm) => tm.id !== currentTeamId && (tm.role === "OWNER" || tm.role === "ADMIN"));
}
