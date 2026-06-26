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
