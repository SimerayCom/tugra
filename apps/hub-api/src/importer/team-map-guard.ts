import type { ForeignFleet } from "./foreign-fleet";
import { ns } from "./import-planner";

/** The owner's Coolify team to Tugra team mapping on a session, read back defensively (ids only; anything malformed is dropped). */
export type TeamMap = Record<string, string | null>;
type TeamMapOf = Readonly<TeamMap>;
const MAX_TEAM_MAP = 100;
export function parseTeamMap(raw: unknown): TeamMap | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: TeamMap = {};
  for (const [ref, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(ref) || Object.keys(out).length >= MAX_TEAM_MAP) continue;
    if (v === null || (typeof v === "string" && v.length > 0 && v.length <= 60)) out[ref] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export interface TeamMapViolations {
  /** Items of a Coolify team the owner left out ("Nothing of this Coolify team is moved"). */
  leftOut: string[];
  /** Items of a mapped Coolify team that would land in another Tugra team than the one it was mapped to. */
  wrongTeam: string[];
}

/**
 * Which of the items an apply is about to create break the owner's team mapping. An item's Coolify team is its project's team, else the
 * team of the server it runs on (the one agent read sees them all). An item whose team the read does not tell is not judged (no mapping
 * is made up for it). `include` says whether an item is created at all: what the review excluded or a service skipped places nothing.
 */
export function teamMapViolations(fleet: ForeignFleet, teamMap: TeamMapOf | undefined, targetTeamId: string, include: (itemRef: string) => boolean): TeamMapViolations {
  const out: TeamMapViolations = { leftOut: [], wrongTeam: [] };
  if (!teamMap || Object.keys(teamMap).length === 0) return out;
  const projectTeam = new Map((fleet.projects ?? []).map((p) => [p.ref, p.team?.ref] as const));
  const serverTeam = new Map(fleet.servers.map((s) => [s.ref, s.team?.ref] as const));
  const judge = (itemRef: string, projectRef: string | undefined, serverRef: string | undefined): void => {
    if (!include(itemRef)) return;
    const ref = (projectRef ? projectTeam.get(projectRef) : undefined) ?? (serverRef ? serverTeam.get(serverRef) : undefined);
    if (!ref || !(ref in teamMap)) return;
    const mapped = teamMap[ref];
    if (mapped === null) out.leftOut.push(itemRef);
    else if (mapped !== targetTeamId) out.wrongTeam.push(itemRef);
  };
  for (const a of fleet.apps) judge(`app:${a.serverRef ?? "_"}:${a.sourceRef}`, a.projectRef, a.serverRef);
  for (const d of fleet.databases) judge(`database:${d.serverRef ?? "_"}:${d.sourceRef}`, d.projectRef, d.serverRef);
  for (const s of fleet.services) judge(ns("service", s.serverRef, s.sourceRef), s.projectRef, s.serverRef);
  return out;
}
