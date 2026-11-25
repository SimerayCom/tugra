import type { ScanReport } from "./types";

export type Platform = "coolify" | "dokploy";

/**
 * What a server scan means for moving things, counted so every line of "Next steps" is true: apps a platform deployed (their settings
 * live in that platform, not on this server), the platform's own containers (they stay), Swarm services, compose stacks Tugra can adopt
 * whole, and standalone containers.
 */
export interface ScanSteps {
  /** Containers a platform deployed (not its own stack), per platform. */
  platformApps: Record<Platform, number>;
  /** The platform's own containers, per platform. */
  platformInfra: Record<Platform, number>;
  /** Docker Swarm service tasks that no platform label explains. */
  swarm: number;
  /** Compose projects with no platform and no Swarm in them: one adopted app each. */
  stacks: string[];
  /** Containers that can be adopted one by one. */
  standalone: number;
}

const INFRA_NAME: Record<Platform, RegExp> = { coolify: /^coolify([-_]|$)/, dokploy: /^dokploy([-_]|$)/ };

export function scanSteps(report: ScanReport): ScanSteps {
  const out: ScanSteps = { platformApps: { coolify: 0, dokploy: 0 }, platformInfra: { coolify: 0, dokploy: 0 }, swarm: 0, stacks: [], standalone: 0 };
  const byProject = new Map<string, { plain: boolean }>();
  for (const c of report.containers) {
    if (c.managedBy) {
      // A report stored before the hub marked infra says false for everything: the platform's own names still tell.
      if (c.platformInfra || INFRA_NAME[c.managedBy].test(c.name)) out.platformInfra[c.managedBy] += 1;
      else out.platformApps[c.managedBy] += 1;
    } else if (c.swarm) {
      out.swarm += 1;
    }
    if (c.adoptable) out.standalone += 1;
    if (c.project) {
      const e = byProject.get(c.project) ?? { plain: true };
      if (c.managedBy || c.swarm) e.plain = false;
      byProject.set(c.project, e);
    }
  }
  out.stacks = [...byProject.entries()].filter(([, e]) => e.plain).map(([name]) => name).sort();
  return out;
}

/** True when a report has nothing deployed by a platform but does run the platform's own containers (the server hosts Coolify itself). */
export const runsPlatformItself = (s: ScanSteps, p: Platform): boolean => s.platformInfra[p] > 0;
