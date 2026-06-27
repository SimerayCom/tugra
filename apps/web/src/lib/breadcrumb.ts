export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Breadcrumb for a resource (app/database) detail page. When the resource is
 * assigned to a project environment, frame it under its project (matching the
 * project-centric IA); otherwise fall back to the flat list.
 */
export function resourceBreadcrumb(opts: {
  projectId: string | null;
  projectName: string | null;
  environmentName: string | null;
  name: string;
  projectsLabel: string;
  fallbackLabel: string;
  fallbackHref: string;
}): Crumb[] {
  if (opts.projectId && opts.projectName) {
    const where = opts.environmentName ? `${opts.projectName} / ${opts.environmentName}` : opts.projectName;
    return [
      { label: opts.projectsLabel, href: "/projects" },
      { label: where, href: `/projects/${opts.projectId}` },
      { label: opts.name },
    ];
  }
  return [
    { label: opts.fallbackLabel, href: opts.fallbackHref },
    { label: opts.name },
  ];
}
