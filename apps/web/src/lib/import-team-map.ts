import { coolifyTeams } from "./import-team";
import type { ImportPlan, Team } from "./types";

// The team mapping step of the Coolify import: each Coolify team goes into a Tugra team the owner chose, made on the spot, or is left
// out. Pure helpers: name matching, the recommended start, what the step still needs, and the body that is saved. No React, no network.

/** What the owner decided for one Coolify team. "none" = not decided yet (nothing is chosen for them where there is no match). */
export type TeamChoice = { kind: "use"; teamId: string } | { kind: "create" } | { kind: "skip" } | { kind: "none" };

/** A name for matching: no case, no accents, one space between words, Turkish dotted/dotless i folded ("Northwind" = "northwind" = "ÖLGÜ Bey"). */
export function normTeamName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0131/g, "i")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The teams a move can land in: the ones the person owns (a campaign needs the owner of every team it lands in). */
export const ownedTeams = (teams: readonly Team[]): Team[] => teams.filter((t) => t.role === "OWNER" && !t.clientAccess);

/**
 * The Tugra team named like a Coolify team, among the teams the person owns. A name that two owned teams share is not a match (nothing
 * is guessed). `notOwned` is set when a team of that name exists that the person does not own, so the step can say why it is not offered.
 */
export function suggestTeam(name: string, teams: readonly Team[]): { teamId: string; notOwned: boolean } {
  const key = normTeamName(name);
  if (!key) return { teamId: "", notOwned: false };
  const owned = ownedTeams(teams).filter((t) => normTeamName(t.name) === key);
  const other = teams.some((t) => normTeamName(t.name) === key && !owned.includes(t));
  return { teamId: owned.length === 1 ? owned[0].id : "", notOwned: owned.length === 0 && other };
}

/**
 * Where the step starts: what a saved mapping says (kept when it is still valid), else the recommended match by name. A Coolify team with
 * no match starts undecided: creating a team writes something, so it is never preselected.
 */
export function startingChoices(plan: ImportPlan, teams: readonly Team[]): Record<string, TeamChoice> {
  const saved = plan.preflight?.teamMap;
  const ownedIds = new Set(ownedTeams(teams).map((t) => t.id));
  const out: Record<string, TeamChoice> = {};
  for (const ct of coolifyTeams(plan)) {
    const prev = saved?.[ct.ref];
    if (prev === null) out[ct.ref] = { kind: "skip" };
    else if (prev && ownedIds.has(prev)) out[ct.ref] = { kind: "use", teamId: prev };
    else {
      const m = suggestTeam(ct.name, teams);
      out[ct.ref] = m.teamId ? { kind: "use", teamId: m.teamId } : { kind: "none" };
    }
  }
  return out;
}

export type TeamMapIssue = "undecided" | "nothing";

/** Why the mapping cannot be saved yet: a Coolify team still has no decision, or every team was left out (nothing would move). */
export function teamMapIssue(choices: Readonly<Record<string, TeamChoice>>): TeamMapIssue | null {
  const all = Object.values(choices);
  if (all.some((c) => c.kind === "none")) return "undecided";
  if (all.every((c) => c.kind === "skip")) return "nothing";
  return null;
}

/** How many teams Continue will create (each one is named like its Coolify team). */
export const createCount = (choices: Readonly<Record<string, TeamChoice>>): number => Object.values(choices).filter((c) => c.kind === "create").length;

/** The rows to save. `created` maps a Coolify team ref to the id of the team just made for it. A team still marked "create" with no id is never sent. */
export function mapBody(choices: Readonly<Record<string, TeamChoice>>, created: Readonly<Record<string, string>> = {}): Array<{ sourceTeamRef: string; teamId: string | null }> {
  const out: Array<{ sourceTeamRef: string; teamId: string | null }> = [];
  for (const [ref, c] of Object.entries(choices).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (c.kind === "use") out.push({ sourceTeamRef: ref, teamId: c.teamId });
    else if (c.kind === "skip") out.push({ sourceTeamRef: ref, teamId: null });
    else if (c.kind === "create" && created[ref]) out.push({ sourceTeamRef: ref, teamId: created[ref] });
  }
  return out;
}

/** The name a made-on-the-spot team gets: the Coolify team's name, cut to what a team name allows. */
export const newTeamName = (coolifyName: string): string => coolifyName.trim().slice(0, 80);

/**
 * The team mapping as a plain-name list for the one-line summary, in the order of the Coolify teams: "Northwind → Northwind".
 * Teams left out are not listed.
 */
export function mappingSummary(plan: ImportPlan, teams: readonly Team[]): Array<{ coolify: string; tugra: string }> {
  const m = plan.preflight?.teamMap;
  if (!m) return [];
  const name = new Map(teams.map((t) => [t.id, t.name] as const));
  return coolifyTeams(plan).flatMap((ct) => (m[ct.ref] ? [{ coolify: ct.name, tugra: name.get(m[ct.ref] as string) ?? "" }] : []));
}
