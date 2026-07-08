import { PrismaService } from "../prisma/prisma.service";

/** Project/environment context for a resource detail view (breadcrumb). */
export interface ResourceProjectCtx {
  projectId: string | null;
  projectName: string | null;
  environmentName: string | null;
}

const EMPTY: ResourceProjectCtx = { projectId: null, projectName: null, environmentName: null };

/** Resolve the owning project + environment name for a resource's environmentId. */
export async function loadProjectCtx(
  prisma: PrismaService,
  environmentId: string | null,
): Promise<ResourceProjectCtx> {
  if (!environmentId) return EMPTY;
  const env = await prisma.environment.findUnique({
    where: { id: environmentId },
    include: { project: true },
  });
  if (!env) return EMPTY;
  return { projectId: env.project.id, projectName: env.project.name, environmentName: env.name };
}

/**
 * Batched project/environment context for a list of resources — resolves every
 * environmentId in ONE query (no N+1). Returns a Map keyed by environmentId;
 * a missing id is simply absent (the caller falls back to an empty context).
 */
export async function loadProjectCtxMany(
  prisma: PrismaService,
  environmentIds: string[],
): Promise<Map<string, ResourceProjectCtx>> {
  const ids = [...new Set(environmentIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const envs = await prisma.environment.findMany({
    where: { id: { in: ids } },
    include: { project: true },
  });
  return new Map(
    envs.map((e) => [
      e.id,
      { projectId: e.project.id, projectName: e.project.name, environmentName: e.name },
    ]),
  );
}
