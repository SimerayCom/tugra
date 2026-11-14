export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Breadcrumb for a resource (app/database) detail page. When the resource is
 * assigned to a project environment, frame it as Projects > Project > Environment >
 * resource (the environment crumb deep-links to that environment's card on the project
 * page); otherwise fall back to the flat list.
 */
export function resourceBreadcrumb(opts: {
  projectId: string | null;
  projectName: string | null;
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
      { label: opts.projectsLabel, href: "/projects" },
      { label: opts.projectName, href: projectHref },
    ];
    if (opts.environmentName) {
      crumbs.push({
        label: opts.environmentName,
        href: opts.environmentId ? `${projectHref}#env-${opts.environmentId}` : projectHref,
      });
    }
    crumbs.push({ label: opts.name });
    return crumbs;
  }
  return [
    { label: opts.fallbackLabel, href: opts.fallbackHref },
    { label: opts.name },
  ];
}
