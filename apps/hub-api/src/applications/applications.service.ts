import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Application, AppStatus, Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { ProxyService } from "./proxy.service";
import {
  buildRemoveScript,
  buildRunScript,
  buildStopScript,
  type AppSpec,
} from "../deploy/deploy-script";
import type { CreateAppInput } from "./dto";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];
const DEPLOY_TIMEOUT_MS = 300_000; // builds can be slow

export interface AppView {
  id: string;
  name: string;
  source: "IMAGE" | "GIT";
  image: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  buildType: "NIXPACKS" | "DOCKERFILE";
  serverId: string;
  teamId: string;
  status: AppStatus;
  hostPort: number | null;
  containerPort: number | null;
  domain: string | null;
  https: boolean;
  url: string | null;
  role: Role;
  canWrite: boolean;
  createdAt: Date;
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly proxy: ProxyService,
  ) {}

  async create(userId: string, dto: CreateAppInput): Promise<AppView> {
    const server = await this.prisma.server.findUnique({
      where: { id: dto.serverId },
    });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requireRole(userId, server.teamId, WRITE);

    const app = await this.prisma.application.create({
      data: {
        name: dto.name,
        source: dto.source ?? "IMAGE",
        image: dto.image ?? null,
        gitUrl: dto.gitUrl ?? null,
        gitBranch: dto.gitBranch ?? "main",
        buildType: dto.buildType ?? "NIXPACKS",
        dockerfilePath: dto.dockerfilePath ?? null,
        serverId: dto.serverId,
        teamId: server.teamId,
        env: (dto.env ?? {}) as Prisma.InputJsonValue,
        hostPort: dto.hostPort ?? null,
        containerPort: dto.containerPort ?? 80,
        domain: dto.domain ?? null,
        https: dto.https ?? true,
      },
    });
    await this.audit.log({ actor: userId, action: "app.create", target: app.id });
    const role = (await this.access.teamRole(userId, server.teamId))!;
    return this.view(app, role);
  }

  async list(userId: string): Promise<AppView[]> {
    const roleByTeam = await this.access.roleByTeam(userId);
    const ids = [...roleByTeam.keys()];
    if (!ids.length) return [];
    const apps = await this.prisma.application.findMany({
      where: { teamId: { in: ids } },
      orderBy: { createdAt: "desc" },
    });
    return apps.map((a) => this.view(a, roleByTeam.get(a.teamId)!));
  }

  async get(userId: string, id: string): Promise<AppView> {
    const app = await this.require(userId, id);
    const role = (await this.access.teamRole(userId, app.teamId))!;
    return this.view(app, role);
  }

  async deploy(userId: string, id: string) {
    const app = await this.requireWrite(userId, id);
    const dep = await this.prisma.deployment.create({
      data: { appId: id, status: "RUNNING" },
    });
    try {
      if (app.domain) await this.proxy.ensureProxy(app.serverId);
      const r = await this.agentWs.sendCommand(
        app.serverId,
        buildRunScript(this.toSpec(app)),
        DEPLOY_TIMEOUT_MS,
      );
      const ok = r.exitCode === 0;
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          logs: r.output.slice(0, 65536),
          exitCode: r.exitCode,
        },
      });
      await this.prisma.application.update({
        where: { id },
        data: { status: ok ? AppStatus.RUNNING : AppStatus.FAILED },
      });
    } catch (e) {
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: { status: "FAILED", logs: e instanceof Error ? e.message : "failed" },
      });
      await this.prisma.application.update({
        where: { id },
        data: { status: AppStatus.FAILED },
      });
    }
    await this.audit.log({ actor: userId, action: "app.deploy", target: id });
    return this.prisma.deployment.findUnique({ where: { id: dep.id } });
  }

  async stop(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    await this.agentWs
      .sendCommand(app.serverId, buildStopScript(app))
      .catch(() => undefined);
    await this.prisma.application.update({
      where: { id },
      data: { status: AppStatus.STOPPED },
    });
    await this.audit.log({ actor: userId, action: "app.stop", target: id });
  }

  async remove(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    await this.agentWs
      .sendCommand(app.serverId, buildRemoveScript(app))
      .catch(() => undefined);
    await this.prisma.application.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "app.remove", target: id });
  }

  async deployments(userId: string, id: string) {
    await this.require(userId, id);
    return this.prisma.deployment.findMany({
      where: { appId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  }

  // ── helpers ──
  private toSpec(app: Application): AppSpec {
    return {
      id: app.id,
      source: app.source,
      image: app.image,
      gitUrl: app.gitUrl,
      gitBranch: app.gitBranch,
      buildType: app.buildType,
      dockerfilePath: app.dockerfilePath,
      env: (app.env as Record<string, string>) ?? {},
      hostPort: app.hostPort,
      containerPort: app.containerPort,
      domain: app.domain,
    };
  }

  private async require(userId: string, id: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id } });
    if (!app) throw new NotFoundException("application not found");
    if (!(await this.access.teamRole(userId, app.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    return app;
  }

  private async requireWrite(userId: string, id: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id } });
    if (!app) throw new NotFoundException("application not found");
    await this.access.requireRole(userId, app.teamId, WRITE);
    return app;
  }

  private view(app: Application, role: Role): AppView {
    return {
      id: app.id,
      name: app.name,
      source: app.source,
      image: app.image,
      gitUrl: app.gitUrl,
      gitBranch: app.gitBranch,
      buildType: app.buildType,
      serverId: app.serverId,
      teamId: app.teamId,
      status: app.status,
      hostPort: app.hostPort,
      containerPort: app.containerPort,
      domain: app.domain,
      https: app.https,
      url: app.domain ? `${app.https ? "https" : "http"}://${app.domain}` : null,
      role,
      canWrite: WRITE.includes(role),
      createdAt: app.createdAt,
    };
  }
}
