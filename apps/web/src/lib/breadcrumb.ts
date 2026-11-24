export interface Crumb {
  label: string;
  href?: string;
  /** Team / project identity colour: the crumb gets a dot of this colour. */
  color?: string | null;
}

/**
 * Breadcrumb for a resource (app/database) detail page. When the resource is
 * assigned to a project environment, frame it as Projects > Project > Environment >
 * resource (the environment crumb deep-links to that environment's card on the project
 * page); otherwise fall back to the flat list. With a `team` crumb (the All-teams view of a multi-team account) the
 * trail starts at the team instead: Team > Project > Environment > resource, the team crumb leading back to the list.
 */
export function resourceBreadcrumb(opts: {
  projectId: string | null;
  projectName: string | null;
  projectColor?: string | null;
  /** The team crumb (see teamCrumb in lib/team-context); replaces the leading "Projects" crumb. */
  team?: Crumb | null;
  environmentId: string | null;
  environmentName: string | null;
  name: string;
  projectsLabel: string;
  fallbackLabel: string;
  fallbackHref: string;
}): Crumb[] {
  if (opts.projectId && opts.projectName) {
    const projectHref = `/projects/${opts.projectId}`;
    const crumbs: Crumb[] = [
      opts.team ?? { label: opts.projectsLabel, href: "/projects" },
      { label: opts.projectName, href: projectHref, color: opts.projectColor },
    ];
    if (opts.environmentName) {
      crumbs.push({
        label: opts.environmentName,
        href: opts.environmentId ? `${projectHref}#env-${opts.environmentId}` : projectHref,
        color: opts.projectColor,
      });
    }
    crumbs.push({ label: opts.name });
    return crumbs;
  }
  return [
    ...(opts.team ? [opts.team] : []),
    { label: opts.fallbackLabel, href: opts.fallbackHref },
    { label: opts.name },
  ];
}
