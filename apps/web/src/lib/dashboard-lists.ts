import type { Application, Database, DashboardDeployRow, Project, ServerView, Team } from "./types";
import type { FleetRow } from "./fleet-view";
import { DISK_PRESSURE_PCT } from "./dashboard";

/** Rows each list card shows before its "See all" link. */
export const LIST_LIMIT = 6;

export function limitRows<T>(rows: T[], limit = LIST_LIMIT): { shown: T[]; total: number } {
  return { shown: rows.slice(0, limit), total: rows.length };
}

/**
 * Servers worth a look first: offline, then pending, then online ones that are hot (CPU/RAM ≥ 90 %) or have a
 * full-ish disk, then the healthy ones. Within a tier, alphabetical so the order is stable between refreshes.
 */
export function problemRank(r: FleetRow): number {
  if (r.server.status === "OFFLINE") return 0;
  if (r.server.status === "PENDING") return 1;
  const hot = (r.cpu ?? 0) >= 90 || (r.memPct ?? 0) >= 90 || (r.diskPct ?? 0) >= DISK_PRESSURE_PCT;
  return hot ? 2 : 3;
}

export function sortServersProblemsFirst(rows: FleetRow[]): FleetRow[] {
  return [...rows].sort((a, b) => problemRank(a) - problemRank(b) || a.server.name.localeCompare(b.server.name));
}

/** Docker short/long container ids (12 or 64 hex) are not a host name; a stale agent used to report one. */
export function looksLikeContainerId(s: string | null | undefined): boolean {
  return !!s && (/^[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{64}$/i.test(s));
}

/** What to print under a server's display name: its real host name, or nothing when it is missing, the same as
 *  the display name, or a leftover container id. */
export function realHostname(s: Pick<ServerView, "name" | "hostname">): string | null {
  const h = s.hostname?.trim();
  if (!h || looksLikeContainerId(h) || h.toLowerCase() === s.name.trim().toLowerCase()) return null;
  return h;
}

/** A stable accent colour per team (teams have no colour setting): hash of the id onto the hue wheel. */
export function teamColor(teamId: string): string {
  let h = 0;
  for (let i = 0; i < teamId.length; i++) h = (h * 31 + teamId.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 50%)`;
}

export interface ProjectCardModel {
  project: Project;
  team: Team | null;
  appCount: number;
  dbCount: number;
  /** ms epoch of the newest sign of life (creation, an app/db created, a deploy) used to order by recent use. */
  lastActivity: number;
}

const ts = (iso: string | null | undefined) => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/**
 * Join projects with their team and a "last used" instant, newest first. There is no per-project last-used field,
 * so it is the newest of: the project itself, any app or database created in it, any deploy of one of its apps.
 */
export function projectCards(
  projects: Project[],
  teams: Team[],
  apps: Pick<Application, "id" | "projectId" | "createdAt">[],
  databases: Pick<Database, "projectId" | "createdAt">[],
  deploys: Pick<DashboardDeployRow, "appId" | "createdAt">[],
): ProjectCardModel[] {
  const last = new Map<string, number>();
  const bump = (projectId: string | null | undefined, t: number) => {
    if (projectId && t > (last.get(projectId) ?? 0)) last.set(projectId, t);
  };
  const projectOfApp = new Map<string, string>();
  for (const a of apps) {
    if (a.projectId) projectOfApp.set(a.id, a.projectId);
    bump(a.projectId, ts(a.createdAt));
  }
  for (const d of databases) bump(d.projectId, ts(d.createdAt));
  for (const d of deploys) bump(projectOfApp.get(d.appId), ts(d.createdAt));
  const teamById = new Map(teams.map((t) => [t.id, t]));
  return projects
    .map((project) => ({
      project,
      team: teamById.get(project.teamId) ?? null,
      appCount: project.environments.reduce((n, e) => n + e.appCount, 0),
      dbCount: project.environments.reduce((n, e) => n + e.dbCount, 0),
      lastActivity: Math.max(ts(project.createdAt), last.get(project.id) ?? 0),
    }))
    .sort((a, b) => b.lastActivity - a.lastActivity || a.project.name.localeCompare(b.project.name));
}

/**
 * Split off the projects that only exist because every team gets a default one and nothing lives in it: they
 * collapse into one summary line ("Empty default projects in 8 teams") instead of eight identical "Default" cards.
 */
export function splitEmptyDefaults(cards: ProjectCardModel[]): { visible: ProjectCardModel[]; emptyDefaults: ProjectCardModel[] } {
  const isEmptyDefault = (c: ProjectCardModel) => c.project.isDefault && c.appCount === 0 && c.dbCount === 0;
  return { visible: cards.filter((c) => !isEmptyDefault(c)), emptyDefaults: cards.filter(isEmptyDefault) };
}
