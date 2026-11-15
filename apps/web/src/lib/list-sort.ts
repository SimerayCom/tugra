import type { Application, Project } from "./types";
import type { SortDir } from "./fleet";

export type SortState<K extends string> = { key: K; dir: SortDir } | null;

/** Click on a sort control: same key flips the direction, a new key starts at its default direction. */
export function toggleSort<K extends string>(prev: SortState<K>, key: K, defaultDir: SortDir = "asc"): { key: K; dir: SortDir } {
  return prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir };
}

const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/** Stable sort with an explicit index tiebreak; `cmp` already carries the direction sign. */
function stableSort<T>(items: T[], cmp: (a: T, b: T) => number): T[] {
  return items
    .map((v, i) => ({ v, i }))
    .sort((a, b) => cmp(a.v, b.v) || a.i - b.i)
    .map((x) => x.v);
}

export type AppSortKey = "name" | "status" | "project";

// Problems first when ascending: an operator scanning the list wants FAILED before RUNNING.
const APP_STATUS_RANK: Record<string, number> = { FAILED: 0, NEW: 1, STOPPED: 2, RUNNING: 3 };

export function defaultAppSortDir(_key: AppSortKey): SortDir {
  return "asc";
}

export function sortApps<T extends Pick<Application, "name" | "status" | "projectName" | "environmentName">>(apps: T[], key: AppSortKey, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return stableSort(apps, (a, b) => {
    if (key === "name") return text(a.name, b.name) * sign;
    if (key === "status") return ((APP_STATUS_RANK[a.status] ?? 9) - (APP_STATUS_RANK[b.status] ?? 9)) * sign;
    // Apps without a project always sink, whatever the direction.
    const pa = a.projectName ? `${a.projectName} / ${a.environmentName ?? ""}` : null;
    const pb = b.projectName ? `${b.projectName} / ${b.environmentName ?? ""}` : null;
    if (pa == null || pb == null) return pa == null && pb == null ? 0 : pa == null ? 1 : -1;
    return text(pa, pb) * sign;
  });
}

export type ProjectSortKey = "name" | "resources" | "created";

/** Counts read best biggest/newest-first; the name reads A→Z. */
export function defaultProjectSortDir(key: ProjectSortKey): SortDir {
  return key === "name" ? "asc" : "desc";
}

export function projectResourceCount(p: Pick<Project, "environments">): number {
  return p.environments.reduce((n, e) => n + e.appCount + e.dbCount, 0);
}

export function sortProjects<T extends Pick<Project, "name" | "createdAt" | "environments">>(projects: T[], key: ProjectSortKey, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return stableSort(projects, (a, b) => {
    if (key === "name") return text(a.name, b.name) * sign;
    if (key === "resources") return (projectResourceCount(a) - projectResourceCount(b)) * sign;
    return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * sign;
  });
}
