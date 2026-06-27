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
