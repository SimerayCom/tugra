import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { appUrl } from "../common/app-url";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];

export interface ProjectResource {
  id: string;
  name: string;
  kind: "app" | "database";
  source: string | null; // app source (IMAGE/GIT/COMPOSE); null for databases
  status: string;
  url: string | null;
  serverName: string | null;
  tags: string[];
  engine: string | null;
}

export interface EnvironmentView {
  id: string;
  name: string;
  isDefault: boolean;
  appCount: number;
  dbCount: number;
  resources?: ProjectResource[];
  createdAt: Date;
}

export interface ProjectView {
  id: string;
  teamId: string;
  name: string;
  isDefault: boolean;
  environments: EnvironmentView[];
  role: Role;
  canWrite: boolean;
  createdAt: Date;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string): Promise<ProjectView[]> {
    const roles = await this.access.roleByTeam(userId);
    const teamIds = [...roles.keys()];
    if (!teamIds.length) return [];
    const projects = await this.prisma.project.findMany({
      where: { teamId: { in: teamIds } },
      include: { environments: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    });
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
    return projects.map((p) => ({
      id: p.id,
      teamId: p.teamId,
      name: p.name,
      isDefault: p.isDefault,
      role: roles.get(p.teamId)!,
      canWrite: WRITE.includes(roles.get(p.teamId)!),
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
  }

  async get(userId: string, id: string): Promise<ProjectView> {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: { environments: { orderBy: { createdAt: "asc" } } },
    });
    if (!project) throw new NotFoundException("project not found");
    const role = await this.access.teamRole(userId, project.teamId);
    if (!role) throw new ForbiddenException("not a member of this team");
    const envIds = project.environments.map((e) => e.id);
    const [apps, dbs] = await Promise.all([
      this.prisma.application.findMany({
        where: { environmentId: { in: envIds } },
        select: { id: true, name: true, status: true, environmentId: true, source: true, domain: true, https: true, hostPort: true, tags: true, serverId: true },
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
      canWrite: WRITE.includes(role),
      environments: project.environments.map((e) => {
        const resources: ProjectResource[] = [
          ...apps.filter((a) => a.environmentId === e.id).map((a) => ({
            id: a.id, name: a.name, kind: "app" as const, source: a.source, status: a.status,
            url: appUrl({ domain: a.domain, https: a.https, hostPort: a.hostPort }, serverIp.get(a.serverId) ?? null),
            serverName: serverName.get(a.serverId) ?? null,
            tags: a.tags,
            engine: null,
          })),
          ...dbs.filter((d) => d.environmentId === e.id).map((d) => ({
            id: d.id, name: d.name, kind: "database" as const, source: null, status: d.status,
            url: null,
            serverName: serverName.get(d.serverId) ?? null,
            tags: d.tags,
            engine: d.engine,
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
    await this.access.requireRole(userId, teamId, WRITE);
    const project = await this.prisma.project.create({
      // A user-created project is not the team default, but its sole environment
      // is that project's default (every project has exactly one default env).
      data: { teamId, name, environments: { create: { name: "production", isDefault: true } } },
    });
    await this.audit.log({ actor: userId, action: "project.create", target: project.id });
    return this.get(userId, project.id);
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
  private async requireProjectWrite(userId: string, id: string) {
    const project = await this.prisma.project.findUnique({ where: { id } });
    if (!project) throw new NotFoundException("project not found");
    await this.access.requireRole(userId, project.teamId, WRITE);
    return project;
  }

  private async requireEnvWrite(userId: string, envId: string) {
    const env = await this.prisma.environment.findUnique({
      where: { id: envId },
      include: { project: true },
    });
    if (!env) throw new NotFoundException("environment not found");
    await this.access.requireRole(userId, env.project.teamId, WRITE);
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
