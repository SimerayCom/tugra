import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { z } from "zod";
import { Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService, canAccessProject } from "../common/team-access.service";
import { appUrl } from "../common/app-url";
import { filterByQuery } from "../common/query-filter";
import { validatePngIcon } from "../common/png-icon";
import { TemplateCatalogService } from "../catalog/template-catalog.service";
import { ApplicationsService } from "../applications/applications.service";
import { DatabasesService } from "../databases/databases.service";

export const CloneEnvironmentResultSchema = z.object({
  environmentId: z.string(),
  projectId: z.string(),
  apps: z.object({ cloned: z.number(), failed: z.array(z.string()) }),
  databases: z.object({ cloned: z.number(), failed: z.array(z.string()) }),
  // App→managed-DB links re-created between the cloned pairs (so the new environment keeps its wiring).
  relinked: z.number(),
});
export type CloneEnvironmentResult = z.infer<typeof CloneEnvironmentResultSchema>;

export const ProjectResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["app", "database"]),
  source: z.string().nullable(), // app source (IMAGE/GIT/COMPOSE); null for databases
  status: z.string(),
  url: z.string().nullable(),
  serverName: z.string().nullable(),
  tags: z.array(z.string()),
  engine: z.string().nullable(),
  // App icon inputs so the resource list shows the SAME icon as the app list/detail (AppLogo's single source
  // of truth): a custom upload (iconUpdatedAt → icon endpoint), else the catalog brand logo, else source icon.
  iconUpdatedAt: z.date().nullable(),
  templateSlug: z.string().nullable(),
  templateLogo: z.string().nullable(), // catalog logo filename resolved from templateSlug (null for databases)
});
export type ProjectResource = z.infer<typeof ProjectResourceSchema>;

export const EnvironmentViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  appCount: z.number(),
  dbCount: z.number(),
  resources: z.array(ProjectResourceSchema).optional(),
  createdAt: z.date(),
});
export type EnvironmentView = z.infer<typeof EnvironmentViewSchema>;

export const ProjectViewSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
  environments: z.array(EnvironmentViewSchema),
  role: z.nativeEnum(Role),
  canWrite: z.boolean(),
  iconUpdatedAt: z.date().nullable(), // set when a custom icon was uploaded (list-view cache-bust marker)
  createdAt: z.date(),
});
export type ProjectView = z.infer<typeof ProjectViewSchema>;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly catalog: TemplateCatalogService,
    private readonly apps: ApplicationsService,
    private readonly databases: DatabasesService,
  ) {}

  async list(userId: string, q?: string): Promise<ProjectView[]> {
    const access = await this.access.accessByTeam(userId);
    const perms = await this.access.permissionsByTeam(userId);
    const teamIds = [...access.keys()];
    if (!teamIds.length) return [];
    const allProjects = await this.prisma.project.findMany({
      where: { teamId: { in: teamIds } },
      include: { environments: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    });
    // Per-resource scoping: a restricted member only sees the projects they're granted.
    const projects = allProjects.filter((p) => canAccessProject(access.get(p.teamId), p.id));
    const [apps, dbs] = await Promise.all([
      this.prisma.application.findMany({
        where: { teamId: { in: teamIds } },
        select: { id: true, environmentId: true },
      }),
      this.prisma.database.findMany({
        where: { teamId: { in: teamIds } },
        select: { id: true, environmentId: true },
      }),
    ]);
    const appByEnv = countBy(apps);
    const dbByEnv = countBy(dbs);
    const views = projects.map((p) => ({
      id: p.id,
      teamId: p.teamId,
      name: p.name,
      isDefault: p.isDefault,
      role: access.get(p.teamId)!.role,
      canWrite: perms.get(p.teamId)?.has("projects") ?? false,
      iconUpdatedAt: p.iconUpdatedAt,
      environments: p.environments.map((e) => ({
        id: e.id,
        name: e.name,
        isDefault: e.isDefault,
        appCount: appByEnv.get(e.id) ?? 0,
        dbCount: dbByEnv.get(e.id) ?? 0,
        createdAt: e.createdAt,
      })),
      createdAt: p.createdAt,
    }));
    return filterByQuery(views, q, (p) => [p.name, ...p.environments.map((e) => e.name)]);
  }

  async get(userId: string, id: string): Promise<ProjectView> {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: { environments: { orderBy: { createdAt: "asc" } } },
    });
    if (!project) throw new NotFoundException("project not found");
    const role = await this.access.teamRole(userId, project.teamId);
    if (!role) throw new ForbiddenException("not a member of this team");
    await this.access.requireProjectAccess(userId, project.teamId, project.id);
    const perms = await this.access.permissionsByTeam(userId);
    const canWrite = perms.get(project.teamId)?.has("projects") ?? false;
    const envIds = project.environments.map((e) => e.id);
    const [apps, dbs] = await Promise.all([
      this.prisma.application.findMany({
        where: { environmentId: { in: envIds } },
        select: { id: true, name: true, status: true, environmentId: true, source: true, domain: true, https: true, hostPort: true, tags: true, serverId: true, iconUpdatedAt: true, templateSlug: true },
      }),
      this.prisma.database.findMany({
        where: { environmentId: { in: envIds } },
        select: { id: true, name: true, status: true, environmentId: true, engine: true, tags: true, serverId: true },
      }),
    ]);
    // Resolve server names for the "Server: <name>" labels, and public IPs so a
    // domainless app can still surface a reachable http://<ip>:<hostPort> URL.
    const serverIds = [...new Set([...apps.map((a) => a.serverId), ...dbs.map((d) => d.serverId)])];
    const servers = await this.prisma.server.findMany({
      where: { id: { in: serverIds } },
      select: { id: true, name: true, publicIp: true, publicIpv6: true },
    });
    const serverName = new Map(servers.map((s) => [s.id, s.name]));
    const serverIp = new Map(servers.map((s) => [s.id, s.publicIp ?? s.publicIpv6]));
    return {
      id: project.id,
      teamId: project.teamId,
      name: project.name,
      isDefault: project.isDefault,
      role,
      canWrite,
      iconUpdatedAt: project.iconUpdatedAt,
      environments: project.environments.map((e) => {
        const resources: ProjectResource[] = [
          ...apps.filter((a) => a.environmentId === e.id).map((a) => ({
            id: a.id, name: a.name, kind: "app" as const, source: a.source, status: a.status,
            url: appUrl({ domain: a.domain, https: a.https, hostPort: a.hostPort }, serverIp.get(a.serverId) ?? null),
            serverName: serverName.get(a.serverId) ?? null,
            tags: a.tags,
            engine: null,
            iconUpdatedAt: a.iconUpdatedAt,
            templateSlug: a.templateSlug,
            // Resolve the catalog logo exactly like applications.service, so the icon matches the app view.
            templateLogo: a.templateSlug ? (this.catalog.get(a.templateSlug)?.logo ?? a.templateSlug) : null,
          })),
          ...dbs.filter((d) => d.environmentId === e.id).map((d) => ({
            id: d.id, name: d.name, kind: "database" as const, source: null, status: d.status,
            url: null,
            serverName: serverName.get(d.serverId) ?? null,
            tags: d.tags,
            engine: d.engine,
            iconUpdatedAt: null,
            templateSlug: null,
            templateLogo: null,
          })),
        ];
        return {
          id: e.id,
          name: e.name,
          isDefault: e.isDefault,
          appCount: resources.filter((r) => r.kind === "app").length,
          dbCount: resources.filter((r) => r.kind === "database").length,
          resources,
          createdAt: e.createdAt,
        };
      }),
      createdAt: project.createdAt,
    };
  }

  async create(userId: string, teamId: string, name: string): Promise<ProjectView> {
    await this.access.requirePermission(userId, teamId, "projects");
    const project = await this.prisma.project.create({
      // A user-created project is not the team default, but its sole environment
      // is that project's default (every project has exactly one default env).
      data: { teamId, name, environments: { create: { name: "production", isDefault: true } } },
    });
    // Grant-on-create: the creator retains access to what they made even if later restricted
    // (Dokploy addNewProject parity). A no-op for OWNER/ADMIN, who bypass scoping anyway.
    await this.access.grantProjectAccess(userId, teamId, project.id);
    await this.audit.log({ actor: userId, action: "project.create", target: project.id });
    return this.get(userId, project.id);
  }

  /**
   * Idempotent find-or-create for the importer: ensure a Project named `spec.name` exists on `teamId`, with an
   * Environment for every `spec.environments` name, and return the target ids. Safe to call twice — a second
   * call REUSES the project/environments (matched by name) and creates nothing. Rules:
   *  - A project is matched by (teamId, name), oldest first; it is created with isDefault=false, and an existing
   *    project's isDefault is NEVER touched, so the team default project is never stolen or duplicated.
   *  - description is filled only when the project has none (a re-import never overwrites an operator's edit);
   *    tags are unioned.
   *  - An environment is matched by (projectId, name). A new one is the project default only when the source
   *    flags it AND the project has no default yet; if no environment ends up default, the oldest is promoted
   *    (every project keeps exactly one default env). A project with no source environments gets "production".
   * A pg advisory lock keyed on (team, project name) serializes concurrent imports so they cannot both create it
   * (there is no unique constraint on Project.name). Requires the `projects` permission on the team and grants
   * the caller access to a project it created (same as {@link create}).
   */
  async findOrCreateForImport(
    userId: string,
    teamId: string,
    spec: { name: string; description?: string; tags?: string[]; environments: Array<{ name: string; isDefault?: boolean }> },
  ): Promise<{ projectId: string; created: boolean; environments: Record<string, string>; createdEnvironments: string[] }> {
    await this.access.requirePermission(userId, teamId, "projects");
    const name = spec.name.trim().slice(0, 80) || "imported";
    const description = spec.description?.trim() || undefined;
    const tags = [...new Set((spec.tags ?? []).map((t) => t.trim()).filter(Boolean))];
    const wanted: Array<{ name: string; isDefault: boolean }> = [];
    for (const e of spec.environments) {
      const en = e.name.trim().slice(0, 80);
      if (en && !wanted.some((w) => w.name === en)) wanted.push({ name: en, isDefault: e.isDefault === true });
    }
    if (!wanted.length) wanted.push({ name: "production", isDefault: true });

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`import-project:${teamId}:${name}`}))`;
      let project = await tx.project.findFirst({
        where: { teamId, name },
        orderBy: { createdAt: "asc" },
        include: { environments: { orderBy: { createdAt: "asc" } } },
      });
      let created = false;
      if (!project) {
        project = await tx.project.create({
          data: { teamId, name, description: description ?? null, tags },
          include: { environments: { orderBy: { createdAt: "asc" } } },
        });
        created = true;
      } else {
        const mergedTags = [...new Set([...(project.tags ?? []), ...tags])];
        const data: { description?: string; tags?: string[] } = {};
        if (description && !project.description) data.description = description;
        if (mergedTags.length !== (project.tags ?? []).length) data.tags = mergedTags;
        if (Object.keys(data).length) await tx.project.update({ where: { id: project.id }, data });
      }

      const envs = [...project.environments];
      let hasDefault = envs.some((e) => e.isDefault);
      const ids: Record<string, string> = {};
      const createdEnvironments: string[] = [];
      for (const w of wanted) {
        const existing = envs.find((e) => e.name === w.name);
        if (existing) {
          ids[w.name] = existing.id;
          continue;
        }
        const isDefault = !hasDefault && w.isDefault;
        const env = await tx.environment.create({ data: { projectId: project.id, name: w.name, isDefault } });
        if (isDefault) hasDefault = true;
        envs.push(env);
        ids[w.name] = env.id;
        createdEnvironments.push(w.name);
      }
      if (!hasDefault && envs.length) await tx.environment.update({ where: { id: envs[0].id }, data: { isDefault: true } });
      return { projectId: project.id, created, environments: ids, createdEnvironments };
    });

    if (result.created) {
      // Grant-on-create (as in create()): the importer keeps access to the project it made if later restricted.
      await this.access.grantProjectAccess(userId, teamId, result.projectId);
      await this.audit.log({ actor: userId, action: "project.create", target: result.projectId, meta: { via: "import" } }).catch(() => undefined);
    }
    return result;
  }

  async rename(userId: string, id: string, name: string): Promise<ProjectView> {
    const project = await this.requireProjectWrite(userId, id);
    await this.prisma.project.update({ where: { id: project.id }, data: { name } });
    await this.audit.log({ actor: userId, action: "project.rename", target: id });
    return this.get(userId, id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const project = await this.requireProjectWrite(userId, id);
    const envIds = (
      await this.prisma.environment.findMany({ where: { projectId: project.id }, select: { id: true } })
    ).map((e) => e.id);
    if (await this.envsHaveResources(envIds)) {
      throw new ConflictException("project has resources; move or remove them first");
    }
    await this.prisma.project.delete({ where: { id: project.id } }); // environments cascade
    await this.audit.log({ actor: userId, action: "project.remove", target: id });
  }

  async addEnvironment(userId: string, projectId: string, name: string): Promise<ProjectView> {
    await this.requireProjectWrite(userId, projectId);
    await this.prisma.environment.create({ data: { projectId, name } });
    await this.audit.log({ actor: userId, action: "environment.create", target: projectId });
    return this.get(userId, projectId);
  }

  /**
   * Clone an environment into a NEW environment in the SAME project, copying every app and database in it
   * (config only, never data — each reuses the app/db clone, which resets domains/host-ports/webhooks and
   * mints fresh credentials). Resources keep their names (they live in a separate environment). Best-effort:
   * a resource that fails to clone is reported in `failed`, and the new environment keeps what succeeded, so
   * the operator can retry or delete it. The caller needs the resource-type permissions up front, so a
   * missing one is a clean 403 instead of a half-cloned environment.
   */
  async cloneEnvironment(userId: string, envId: string, opts: { name?: string }): Promise<CloneEnvironmentResult> {
    const env = await this.requireEnvWrite(userId, envId); // 'projects' permission (creates the environment)
    const teamId = env.project.teamId;
    const [apps, dbs] = await Promise.all([
      this.prisma.application.findMany({ where: { environmentId: envId, isPreview: false }, select: { id: true, name: true } }),
      this.prisma.database.findMany({ where: { environmentId: envId }, select: { id: true, name: true } }),
    ]);
    // Gate the resource-type permissions up front (clone would enforce them per call, but that leaves a
    // half-cloned environment on the first denial).
    if (apps.length) await this.access.requirePermission(userId, teamId, "apps:config");
    if (dbs.length) await this.access.requirePermission(userId, teamId, "databases");

    // Keep the " (copy)" suffix within the 80-char environment-name cap (truncate the base, not the suffix).
    const suffix = " (copy)";
    const base = env.name.length > 80 - suffix.length ? env.name.slice(0, 80 - suffix.length) : env.name;
    const name = (opts.name?.trim() || `${base}${suffix}`).slice(0, 80);
    const newEnv = await this.prisma.environment.create({ data: { projectId: env.projectId, name } });

    // Keep a source-id → clone-id map per kind so we can re-wire the app→managed-DB links afterwards.
    const appIdMap = new Map<string, string>();
    const appRes = { cloned: 0, failed: [] as string[] };
    for (const a of apps) {
      try {
        const r = await this.apps.clone(userId, a.id, { name: a.name, environmentId: newEnv.id });
        appIdMap.set(a.id, r.app.id);
        appRes.cloned++;
      } catch {
        appRes.failed.push(a.name);
      }
    }
    const dbIdMap = new Map<string, string>();
    const dbRes = { cloned: 0, failed: [] as string[] };
    for (const d of dbs) {
      try {
        const r = await this.databases.clone(userId, d.id, { name: d.name, environmentId: newEnv.id });
        dbIdMap.set(d.id, r.id);
        dbRes.cloned++;
      } catch {
        dbRes.failed.push(d.name);
      }
    }

    // Re-link the clones: for every source app→managed-DB link where BOTH ends were cloned, recreate the
    // link between the clone pair (same env var). The cloned app keeps the source's dbNetwork opt-in (a
    // same-server clone), so the injected connection URI reaches the cloned DB — otherwise a prod→staging
    // clone would start the staging app with no DATABASE_URL. Links to a DB outside this env are left out.
    let relinked = 0;
    const srcAppIds = [...appIdMap.keys()];
    if (srcAppIds.length) {
      const links = await this.prisma.appDatabaseLink.findMany({ where: { appId: { in: srcAppIds } } });
      for (const link of links) {
        const cloneAppId = appIdMap.get(link.appId);
        const cloneDbId = dbIdMap.get(link.databaseId);
        if (!cloneAppId || !cloneDbId) continue; // the linked DB wasn't in this environment / didn't clone
        try {
          await this.prisma.appDatabaseLink.create({ data: { appId: cloneAppId, databaseId: cloneDbId, envVar: link.envVar, createdBy: userId } });
          relinked++;
        } catch {
          // a unique-constraint race or a missing clone — skip; the app still deploys, just unlinked
        }
      }
    }

    // Audit must not fail the clone after resources were created — the env + its clones already exist.
    await this.audit
      .log({
        actor: userId,
        action: "environment.clone",
        target: env.projectId,
        meta: {
          from: envId,
          to: newEnv.id,
          apps: appRes.cloned,
          databases: dbRes.cloned,
          relinked,
          failed: [...appRes.failed, ...dbRes.failed],
        },
      })
      .catch(() => undefined);
    return { environmentId: newEnv.id, projectId: env.projectId, apps: appRes, databases: dbRes, relinked };
  }

  async renameEnvironment(userId: string, envId: string, name: string): Promise<void> {
    const env = await this.requireEnvWrite(userId, envId);
    await this.prisma.environment.update({ where: { id: env.id }, data: { name } });
    await this.audit.log({ actor: userId, action: "environment.rename", target: env.projectId });
  }

  async removeEnvironment(userId: string, envId: string): Promise<void> {
    const env = await this.requireEnvWrite(userId, envId);
    if (await this.envsHaveResources([env.id])) {
      throw new ConflictException("environment has resources; move or remove them first");
    }
    await this.prisma.environment.delete({ where: { id: env.id } });
    // Keep the "exactly one default env per project" invariant: if we removed the
    // default and siblings remain, promote the oldest survivor.
    if (env.isDefault) {
      const next = await this.prisma.environment.findFirst({
        where: { projectId: env.projectId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (next) {
        await this.prisma.environment.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }
    await this.audit.log({ actor: userId, action: "environment.remove", target: env.projectId });
  }

  // ── helpers ──
  /** Raw icon bytes for the GET endpoint (read-authorized). 404 when the project has no custom icon. */
  async getIcon(userId: string, id: string): Promise<{ mime: string; data: Buffer }> {
    const project = await this.prisma.project.findUnique({ where: { id }, select: { teamId: true } });
    if (!project) throw new NotFoundException("project not found");
    if (!(await this.access.teamRole(userId, project.teamId))) throw new ForbiddenException("not a member of this team");
    await this.access.requireProjectAccess(userId, project.teamId, id);
    const icon = await this.prisma.projectIcon.findUnique({ where: { projectId: id } });
    if (!icon) throw new NotFoundException("no icon");
    return { mime: icon.mime, data: Buffer.from(icon.data) };
  }

  /** Store (or replace) the project's custom icon from a base64-encoded PNG. Write-authorized + validated. */
  async setIcon(userId: string, id: string, pngBase64: string): Promise<void> {
    const project = await this.requireProjectWrite(userId, id);
    const buf = Buffer.from(pngBase64, "base64"); // tolerant decode; the PNG check below is the real gate
    if (buf.length === 0) throw new BadRequestException("icon is empty");
    validatePngIcon(buf);
    await this.prisma.$transaction([
      this.prisma.projectIcon.upsert({
        where: { projectId: id },
        create: { projectId: id, mime: "image/png", data: buf, sizeBytes: buf.length },
        update: { mime: "image/png", data: buf, sizeBytes: buf.length },
      }),
      this.prisma.project.update({ where: { id }, data: { iconUpdatedAt: new Date() } }),
    ]);
    await this.audit.log({ actor: userId, action: "project.icon.set", target: project.id, meta: { sizeBytes: buf.length } });
  }

  /** Remove the project's custom icon (idempotent — a no-op when none is set). Write-authorized. */
  async deleteIcon(userId: string, id: string): Promise<void> {
    const project = await this.requireProjectWrite(userId, id);
    await this.prisma.$transaction([
      this.prisma.projectIcon.deleteMany({ where: { projectId: id } }), // deleteMany: removing a missing icon is a no-op
      this.prisma.project.update({ where: { id }, data: { iconUpdatedAt: null } }),
    ]);
    await this.audit.log({ actor: userId, action: "project.icon.delete", target: project.id });
  }

  private async requireProjectWrite(userId: string, id: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException("project not found");
    await this.access.requirePermission(userId, project.teamId, "projects");
    return project;
  }

  private async requireEnvWrite(userId: string, envId: string) {
    const env = await this.prisma.environment.findUnique({
      where: { id: envId },
      include: { project: true },
    });
    if (!env) throw new NotFoundException("environment not found");
    await this.access.requirePermission(userId, env.project.teamId, "projects");
    return env;
  }

  private async envsHaveResources(envIds: string[]): Promise<boolean> {
    if (!envIds.length) return false;
    const [apps, dbs] = await Promise.all([
      this.prisma.application.count({ where: { environmentId: { in: envIds } } }),
      this.prisma.database.count({ where: { environmentId: { in: envIds } } }),
    ]);
    return apps + dbs > 0;
  }
}

function countBy(rows: { environmentId: string | null }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!r.environmentId) continue;
    m.set(r.environmentId, (m.get(r.environmentId) ?? 0) + 1);
  }
  return m;
}
