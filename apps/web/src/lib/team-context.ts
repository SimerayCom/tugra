import type { Crumb } from "./breadcrumb";
import { teamColor } from "./team-color";

/** The slice of a team the context helpers need. */
export interface TeamLike {
  id: string;
  name: string;
  color?: string | null;
}

/**
 * Whether a screen should name the team an item belongs to: only in the "All teams" view of an account with more than
 * one team. With one team selected (or only one team to begin with) the badge is just noise, so it is hidden.
 */
export function showTeamContext(scope: string | null, teamCount: number): boolean {
  return scope === null && teamCount > 1;
}

export interface TeamGroup<T> {
  teamId: string;
  team: TeamLike | undefined;
  /** Name used for the header and for ordering ("" teams sort last). */
  name: string;
  items: T[];
}

/**
 * Items grouped by team, in team-name order (items keep their incoming order inside a group). Items whose team is
 * unknown (not in `teams`) are kept, grouped under their id, after the named teams.
 */
export function groupByTeam<T extends { teamId: string }>(items: T[], teams: TeamLike[]): Array<TeamGroup<T>> {
  const byId = new Map(teams.map((t) => [t.id, t]));
  const groups = new Map<string, TeamGroup<T>>();
  for (const item of items) {
    let g = groups.get(item.teamId);
    if (!g) {
      const team = byId.get(item.teamId);
      g = { teamId: item.teamId, team, name: team?.name ?? "", items: [] };
      groups.set(item.teamId, g);
    }
    g.items.push(item);
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.name !== !b.name) return a.name ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** The team crumb that leads a breadcrumb ("Team › Project › environment"); it links to the list the item came from. */
export function teamCrumb(team: TeamLike | undefined, href: string): Crumb | null {
  if (!team) return null;
  return { label: team.name, href, color: teamColor(team.id, team.color) };
}
