import type { ImportPlan } from "./types";
import { hostOfItemRef } from "./import-scope";

// The Coolify team the owner picked on the connect screen decides what the later steps show first: that team's servers and projects.
// The plan always carries every team (one agent read sees them all), so this only narrows what is LISTED; what moves is still exactly
// what is ticked (an "Everything" of the team is sent as that team's projects, never as the whole source). Pure, no React.

/** The picked Coolify team and what belongs to it. */
export interface TeamScope {
  teamRef: string;
  teamName: string;
  /** Source server refs shown for the team: its own servers plus every server its projects run on. */
  hosts: ReadonlySet<string>;
  /** Source project refs of the team. */
  projects: ReadonlySet<string>;
  /** What the rest of the Coolify adds when "Show all teams" is on. */
  hiddenHosts: number;
  hiddenProjects: number;
  /** How many other Coolify teams have servers or projects here. */
  otherTeams: number;
}

/**
 * The scope of the picked team, or null when nothing narrows: the session has no picked team (a single team, or the token path),
 * only one team has anything here, or the picked team has nothing to show (the lists must never come up empty because of a filter).
 */
export function teamScope(plan: ImportPlan | null | undefined): TeamScope | null {
  const pf = plan?.preflight;
  const ref = pf?.sourceTeamRef;
  if (!plan || !pf || !ref) return null;
  const projects = pf.projects ?? [];
  const hostRows = pf.hosts ?? [];
  const teams = new Map<string, string>();
  for (const p of projects) if (p.team) teams.set(p.team.ref, p.team.name);
  for (const h of hostRows) if (h.team) teams.set(h.team.ref, h.team.name);
  if (!teams.has(ref) || teams.size < 2) return null;

  const mine = projects.filter((p) => p.team?.ref === ref);
  const projectRefs = new Set(mine.map((p) => p.ref));
  const hosts = new Set<string>();
  for (const h of hostRows) if (h.team?.ref === ref) hosts.add(h.ref);
  for (const p of mine) for (const itemRef of p.itemRefs) hosts.add(hostOfItemRef(itemRef));
  const known = new Set(hostRows.map((h) => h.ref));
  for (const r of [...hosts]) if (!known.has(r)) hosts.delete(r); // an item on no named server is not a list row
  if (hosts.size === 0 && projectRefs.size === 0) return null;
  return {
    teamRef: ref,
    teamName: teams.get(ref) ?? "",
    hosts,
    projects: projectRefs,
    hiddenHosts: hostRows.filter((h) => !hosts.has(h.ref)).length,
    hiddenProjects: projects.filter((p) => !projectRefs.has(p.ref)).length,
    otherTeams: teams.size - 1,
  };
}

/** The scope that actually narrows right now: the team's, unless the owner asked to see every team. */
export const activeTeamScope = (plan: ImportPlan | null | undefined, showAll: boolean): TeamScope | null => (showAll ? null : teamScope(plan));
