import type { ImportPlan } from "./types";
import { hostOfItemRef } from "./import-scope";

// The Coolify team the owner picked on the connect screen decides what the later steps show first: that team's servers and projects.
// The plan always carries every team (one agent read sees them all), so this only narrows what is LISTED; what moves is still exactly
// what is ticked (an "Everything" of the team is sent as that team's projects, never as the whole source). Pure, no React.

/** The picked Coolify team(s) and what belongs to them. */
export interface TeamScope {
  /** The one team in view (or the first of several): its ref and name. */
  teamRef: string;
  teamName: string;
  /** Every Coolify team in view: one team the owner switched to, or all the teams mapped to a Tugra team. */
  teamRefs: readonly string[];
  /** The teams the owner can switch between (the mapped ones), with what each holds. */
  teams: ReadonlyArray<{ ref: string; name: string; items: number }>;
  /** Source server refs shown: the teams' own servers plus every server their projects run on. */
  hosts: ReadonlySet<string>;
  /** Source project refs of the teams. */
  projects: ReadonlySet<string>;
  /** What the rest of the Coolify adds when "Show all teams" is on. */
  hiddenHosts: number;
  hiddenProjects: number;
  /** How many other Coolify teams have servers or projects here. */
  otherTeams: number;
  /** Apps, databases and services of the teams in view, and of the whole read. */
  shownItems: number;
  totalItems: number;
}

const PLACEABLE = new Set(["app", "database", "service"]);

/** Every Coolify team of a read (the ones with a project or a server) and what each holds, in name order. */
export function coolifyTeams(plan: ImportPlan | null | undefined): Array<{ ref: string; name: string; items: number; projects: number; hosts: number }> {
  const pf = plan?.preflight;
  if (!plan || !pf) return [];
  const kindOf = new Map(plan.items.map((i) => [i.itemRef, i.kind] as const));
  const out = new Map<string, { ref: string; name: string; items: number; projects: number; hosts: number }>();
  const row = (ref: string, name: string) => {
    const r = out.get(ref) ?? { ref, name, items: 0, projects: 0, hosts: 0 };
    out.set(ref, r);
    return r;
  };
  for (const tm of pf.teams ?? []) row(tm.ref, tm.name);
  for (const p of pf.projects ?? []) {
    if (!p.team) continue;
    const r = row(p.team.ref, p.team.name);
    r.projects += 1;
    r.items += p.itemRefs.filter((x) => PLACEABLE.has(kindOf.get(x) ?? "")).length;
  }
  for (const h of pf.hosts ?? []) if (h.team) row(h.team.ref, h.team.name).hosts += 1;
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref));
}

/** The Coolify teams the owner mapped to a Tugra team (the left-out ones are not here). Empty until a mapping is saved. */
export function mappedTeamRefs(plan: ImportPlan | null | undefined): string[] {
  const m = plan?.preflight?.teamMap;
  return m ? Object.entries(m).filter(([, v]) => !!v).map(([k]) => k) : [];
}

/**
 * The scope of the team(s) in view, or null when nothing narrows: the session has no team (a single team, or the token path), only
 * one team has anything here, or the team has nothing to show (the lists must never come up empty because of a filter).
 * With a saved team mapping the teams in view are the mapped ones (`view` picks one of them); without one it is the team the owner
 * picked on the connect screen.
 */
export function teamScope(plan: ImportPlan | null | undefined, view?: string | null): TeamScope | null {
  const pf = plan?.preflight;
  if (!plan || !pf) return null;
  const projects = pf.projects ?? [];
  const hostRows = pf.hosts ?? [];
  const names = new Map<string, string>();
  for (const p of projects) if (p.team) names.set(p.team.ref, p.team.name);
  for (const h of hostRows) if (h.team) names.set(h.team.ref, h.team.name);
  const mapped = mappedTeamRefs(plan).filter((r) => names.has(r));
  let refs: string[];
  if (pf.teamMap) {
    if (mapped.length === 0) return null;
    refs = view && mapped.includes(view) ? [view] : mapped;
  } else {
    const ref = pf.sourceTeamRef;
    if (!ref || !names.has(ref) || names.size < 2) return null;
    refs = [ref];
  }
  const inView = new Set(refs);
  const kindOf = new Map(plan.items.map((i) => [i.itemRef, i.kind] as const));
  const mine = projects.filter((p) => p.team && inView.has(p.team.ref));
  const projectRefs = new Set(mine.map((p) => p.ref));
  const hosts = new Set<string>();
  for (const h of hostRows) if (h.team && inView.has(h.team.ref)) hosts.add(h.ref);
  for (const p of mine) for (const itemRef of p.itemRefs) hosts.add(hostOfItemRef(itemRef));
  const known = new Set(hostRows.map((h) => h.ref));
  for (const r of [...hosts]) if (!known.has(r)) hosts.delete(r); // an item on no named server is not a list row
  if (hosts.size === 0 && projectRefs.size === 0) return null;
  const shown = new Set(mine.flatMap((p) => p.itemRefs.filter((x) => PLACEABLE.has(kindOf.get(x) ?? ""))));
  const all = coolifyTeams(plan);
  return {
    teamRef: refs[0],
    teamName: refs.length === 1 ? (names.get(refs[0]) ?? "") : refs.map((r) => names.get(r) ?? r).join(", "),
    teamRefs: refs,
    teams: pf.teamMap ? all.filter((t) => mapped.includes(t.ref)).map((t) => ({ ref: t.ref, name: t.name, items: t.items })) : [],
    hosts,
    projects: projectRefs,
    hiddenHosts: hostRows.filter((h) => !hosts.has(h.ref)).length,
    hiddenProjects: projects.filter((p) => !projectRefs.has(p.ref)).length,
    otherTeams: names.size - refs.length,
    shownItems: shown.size,
    totalItems: plan.items.filter((i) => PLACEABLE.has(i.kind)).length,
  };
}

/** The scope that actually narrows right now: the team's, unless the owner asked to see every team. */
export const activeTeamScope = (plan: ImportPlan | null | undefined, showAll: boolean, view?: string | null): TeamScope | null => (showAll ? null : teamScope(plan, view));

/** The Tugra team a source server must land in: the one its Coolify team was mapped to. Undefined when there is no mapping for it. */
export function hostTugraTeam(plan: ImportPlan | null | undefined, hostRef: string): string | undefined {
  const m = plan?.preflight?.teamMap;
  const ref = plan?.preflight?.hosts?.find((h) => h.ref === hostRef)?.team?.ref;
  const id = m && ref ? m[ref] : undefined;
  return id || undefined;
}

/**
 * Where the settings of the picked Coolify team go (notification channels, shared variables, storages, tags, member invitations): the Tugra team
 * that Coolify team was mapped to. `undefined` = no mapping says (the older rule applies); `null` = that Coolify team was left out, so its settings go nowhere.
 */
export function settingsTeamOf(plan: ImportPlan | null | undefined): string | null | undefined {
  const pf = plan?.preflight;
  if (!pf?.teamMap || !pf.sourceTeamRef) return undefined;
  const v = pf.teamMap[pf.sourceTeamRef];
  return v === undefined ? undefined : v;
}
