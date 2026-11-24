/** Pure helpers for the new-resource wizard (kind routing + honest back-link). */

export type ResourceKind = "app" | "service" | "database";

/** Validate the ?kind= query param; unknown values collapse to null (full catalog). */
export function parseKind(raw: string | null | undefined): ResourceKind | null {
  return raw === "app" || raw === "service" || raw === "database" ? raw : null;
}

/** Which catalog sections the Type step shows for a given kind (null = all). */
export function visibleGroups(kind: ResourceKind | null): { app: boolean; db: boolean; service: boolean } {
  if (kind === "app") return { app: true, db: false, service: false };
  if (kind === "database") return { app: false, db: true, service: false };
  if (kind === "service") return { app: false, db: false, service: true };
  return { app: true, db: true, service: true };
}

export type BackKey = "project" | "apps" | "databases" | "projects";

/**
 * Honest back-link target derived from where the user actually came from.
 * Uses the RAW ?project= URL param (not the auto-defaulted state), so the
 * generic +New / Apps / Databases entry points don't get a wrong "back to project".
 */
export function backTarget(opts: { projectParam: string | null | undefined; kind: ResourceKind | null }): {
  href: string;
  key: BackKey;
} {
  if (opts.projectParam) return { href: `/projects/${opts.projectParam}`, key: "project" };
  if (opts.kind === "database") return { href: "/databases", key: "databases" };
  if (opts.kind === "app" || opts.kind === "service") return { href: "/apps", key: "apps" };
  return { href: "/projects", key: "projects" };
}

/**
 * The project to preselect in the wizard: the team's default project (isDefault)
 * over an arbitrary first entry. Pass a team-scoped list (via scopeByTeam) so the
 * pick stays within the chosen server's team. "" when there is nothing to pick.
 */
export function defaultProjectId(projects: { id: string; isDefault: boolean }[]): string {
  return (projects.find((p) => p.isDefault) ?? projects[0])?.id ?? "";
}

/** The environment to preselect: the project's default env (isDefault) over the first. */
export function defaultEnvId(
  project: { environments: { id: string; isDefault: boolean }[] } | undefined,
): string {
  const envs = project?.environments ?? [];
  return (envs.find((e) => e.isDefault) ?? envs[0])?.id ?? "";
}

/**
 * The project the wizard should hold given the team-scoped candidate pool, the
 * current selection, and whether the user arrived with URL context
 * (?project= / ?server=). Keeps a still-valid selection; auto-picks the sole
 * candidate; defaults to the team default only when URL-scoped; otherwise ""
 * so an unscoped user with several projects must choose explicitly — no silent
 * commit to a project they never picked.
 */
export function resolveProjectId(
  pool: { id: string; isDefault: boolean }[],
  current: string,
  scoped: boolean,
): string {
  if (current && pool.some((p) => p.id === current)) return current;
  if (pool.length === 1) return pool[0].id;
  if (scoped) return defaultProjectId(pool);
  return "";
}

/**
 * The team a new resource (and any project made for it) belongs to. A pinned server wins (a resource always lives in
 * its server's team), then an explicit team choice, then the team of the project already chosen or named in the URL,
 * then the global team scope, then the only team there is. "" when it is still open (several teams, nothing decided):
 * the wizard then asks for the team first, so the project list never mixes teams.
 */
export function resolveDestTeam(opts: {
  pinnedTeam?: string | null;
  pickedTeam?: string;
  projectTeam?: string | null;
  urlProjectTeam?: string | null;
  scope: string | null;
  teams: { id: string }[];
}): string {
  const valid = (id: string | null | undefined): id is string => !!id && opts.teams.some((tm) => tm.id === id);
  for (const id of [opts.pinnedTeam, opts.pickedTeam, opts.projectTeam, opts.urlProjectTeam, opts.scope]) {
    if (valid(id)) return id;
  }
  return opts.teams.length === 1 ? opts.teams[0].id : "";
}
