import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Application, AppStatus, Prisma, Role } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService } from "../common/team-access.service";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import { CryptoService } from "../crypto/crypto.service";
import { ProxyService } from "./proxy.service";
import {
  buildImageRemoveScript,
  buildRemoveScript,
  buildRunScript,
  buildStopScript,
  runTag,
  type AppSpec,
} from "../deploy/deploy-script";
import {
  buildComposeDownScript,
  buildComposeStopScript,
  buildComposeUpScript,
} from "../deploy/compose-script";
import {
  generateWebhookSecret,
  generateWebhookToken,
} from "../webhooks/webhook-verify";
import type { CreateAppInput } from "./dto";

const WRITE: Role[] = [Role.OWNER, Role.ADMIN];
const DEPLOY_TIMEOUT_MS = 300_000; // builds can be slow
const DEPLOY_IMAGE_KEEP = 5; // versioned images retained for rollback

export interface AppView {
  id: string;
  name: string;
  source: "IMAGE" | "GIT" | "COMPOSE";
  image: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  buildType: "NIXPACKS" | "DOCKERFILE";
  composeFile: string | null;
  healthCmd: string | null;
  memoryMb: number | null;
  cpus: number | null;
  serverId: string;
  teamId: string;
  status: AppStatus;
  hostPort: number | null;
  containerPort: number | null;
  domain: string | null;
  https: boolean;
  url: string | null;
  webhookToken: string | null;
  webhookSecret: string | null;
  envCount: number;
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
    private readonly deployLogs: DeployLogHub,
    private readonly proxy: ProxyService,
    private readonly crypto: CryptoService,
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
        composeFile: dto.composeFile ?? null,
        serverId: dto.serverId,
        teamId: server.teamId,
        env: {} as Prisma.InputJsonValue,
        envEnc: this.crypto.encrypt(JSON.stringify(dto.env ?? {})),
        hostPort: dto.hostPort ?? null,
        containerPort: dto.containerPort ?? 80,
        domain: dto.domain ?? null,
        https: dto.https ?? true,
        webhookToken: generateWebhookToken(),
        webhookSecret: this.crypto.encrypt(generateWebhookSecret()),
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
    await this.ensureNoActiveDeploy(id);
    return this.runDeploy(app, userId);
  }

  /** One deploy per app at a time — keeps the live-log stream unambiguous. */
  private async ensureNoActiveDeploy(appId: string): Promise<void> {
    const running = await this.prisma.deployment.findFirst({
      where: { appId, status: "RUNNING" },
    });
    if (running) throw new ConflictException("a deployment is already running");
  }

  /**
   * Deploy triggered by a verified git webhook — no interactive user, so the
   * role check is skipped (the webhook secret is the authorization). Fire this
   * without awaiting; builds can take minutes.
   */
  async deployFromWebhook(appId: string) {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    return this.runDeploy(app, "webhook");
  }

  /** Core deploy: build/run on the agent and record the Deployment. */
  private async runDeploy(app: Application, actor: string) {
    const dep = await this.prisma.deployment.create({
      data: { appId: app.id, status: "RUNNING" },
    });
    this.deployLogs.begin(app.id);
    try {
      const isCompose = app.source === "COMPOSE";
      if (app.domain && !isCompose) await this.proxy.ensureProxy(app.serverId);
      const spec = this.toSpec(app);
      spec.env = await this.resolvedEnv(app); // team shared vars + app env (app wins)
      const command = isCompose
        ? buildComposeUpScript(spec)
        : buildRunScript(spec, dep.id, true);
      const r = await this.agentWs.sendCommand(
        app.serverId,
        command,
        DEPLOY_TIMEOUT_MS,
        (chunk) => this.deployLogs.push(app.id, chunk),
      );
      const ok = r.exitCode === 0;
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          logs: r.output.slice(0, 65536),
          exitCode: r.exitCode,
          // Compose stacks are multi-image → no single rollback tag.
          imageTag: ok && !isCompose ? runTag(app, dep.id) : null,
        },
      });
      await this.prisma.application.update({
        where: { id: app.id },
        data: { status: ok ? AppStatus.RUNNING : AppStatus.FAILED },
      });
      this.deployLogs.finish(app.id, {
        status: ok ? "SUCCESS" : "FAILED",
        exitCode: r.exitCode,
        deploymentId: dep.id,
      });
      if (ok && !isCompose) await this.pruneImages(app);
    } catch (e) {
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: { status: "FAILED", logs: e instanceof Error ? e.message : "failed" },
      });
      await this.prisma.application.update({
        where: { id: app.id },
        data: { status: AppStatus.FAILED },
      });
      this.deployLogs.finish(app.id, { status: "FAILED", exitCode: -1, deploymentId: dep.id });
    }
    await this.audit.log({ actor, action: "app.deploy", target: app.id });
    return this.prisma.deployment.findUnique({ where: { id: dep.id } });
  }

  /** Re-run a previous successful deployment's image without rebuilding/pulling. */
  async rollback(userId: string, id: string, targetDeploymentId: string) {
    const app = await this.requireWrite(userId, id);
    if (app.source === "COMPOSE") {
      throw new BadRequestException("rollback not supported for compose apps");
    }
    const target = await this.prisma.deployment.findFirst({
      where: { id: targetDeploymentId, appId: id, status: "SUCCESS" },
    });
    if (!target || !target.imageTag) {
      throw new NotFoundException("no rollbackable deployment with that id");
    }
    const dep = await this.prisma.deployment.create({
      data: { appId: app.id, status: "RUNNING" },
    });
    this.deployLogs.begin(app.id);
    try {
      if (app.domain) await this.proxy.ensureProxy(app.serverId);
      const spec = this.toSpec(app);
      spec.env = await this.resolvedEnv(app);
      const r = await this.agentWs.sendCommand(
        app.serverId,
        buildRunScript(spec, target.id, false),
        DEPLOY_TIMEOUT_MS,
        (chunk) => this.deployLogs.push(app.id, chunk),
      );
      const ok = r.exitCode === 0;
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          logs: `rolled back to ${target.id}\n${r.output.slice(0, 65000)}`,
          exitCode: r.exitCode,
          imageTag: ok ? target.imageTag : null,
        },
      });
      await this.prisma.application.update({
        where: { id: app.id },
        data: { status: ok ? AppStatus.RUNNING : AppStatus.FAILED },
      });
      this.deployLogs.finish(app.id, {
        status: ok ? "SUCCESS" : "FAILED",
        exitCode: r.exitCode,
        deploymentId: dep.id,
      });
    } catch (e) {
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: { status: "FAILED", logs: e instanceof Error ? e.message : "failed" },
      });
      await this.prisma.application.update({
        where: { id: app.id },
        data: { status: AppStatus.FAILED },
      });
      this.deployLogs.finish(app.id, { status: "FAILED", exitCode: -1, deploymentId: dep.id });
    }
    await this.audit.log({
      actor: userId,
      action: "app.rollback",
      target: id,
      meta: { targetDeploymentId },
    });
    return this.prisma.deployment.findUnique({ where: { id: dep.id } });
  }

  /** Keep the newest DEPLOY_IMAGE_KEEP rollback images; remove older ones. */
  private async pruneImages(app: Application): Promise<void> {
    const kept = await this.prisma.deployment.findMany({
      where: { appId: app.id, status: "SUCCESS", imageTag: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    for (const d of kept.slice(DEPLOY_IMAGE_KEEP)) {
      await this.agentWs
        .sendCommand(app.serverId, buildImageRemoveScript(app, d.id))
        .catch(() => undefined);
      await this.prisma.deployment.update({
        where: { id: d.id },
        data: { imageTag: null },
      });
    }
  }

  async regenerateWebhook(userId: string, id: string): Promise<AppView> {
    const app = await this.requireWrite(userId, id);
    const updated = await this.prisma.application.update({
      where: { id },
      data: {
        webhookToken: generateWebhookToken(),
        webhookSecret: this.crypto.encrypt(generateWebhookSecret()),
      },
    });
    await this.audit.log({
      actor: userId,
      action: "app.webhook.regenerate",
      target: id,
    });
    const role = (await this.access.teamRole(userId, app.teamId))!;
    return this.view(updated, role);
  }

  async stop(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    const cmd =
      app.source === "COMPOSE"
        ? buildComposeStopScript(this.toSpec(app))
        : buildStopScript(app);
    await this.agentWs.sendCommand(app.serverId, cmd).catch(() => undefined);
    await this.prisma.application.update({
      where: { id },
      data: { status: AppStatus.STOPPED },
    });
    await this.audit.log({ actor: userId, action: "app.stop", target: id });
  }

  async remove(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    const cmd =
      app.source === "COMPOSE"
        ? buildComposeDownScript(this.toSpec(app), { volumes: true })
        : buildRemoveScript(app);
    await this.agentWs.sendCommand(app.serverId, cmd).catch(() => undefined);
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

  /**
   * Live build-log stream for the app's active deploy (replay-so-far + live).
   * Returns null when there's no active stream → caller falls back to the
   * persisted logs served by deployments().
   */
  async streamLogs(userId: string, id: string) {
    await this.require(userId, id);
    return this.deployLogs.subscribe(id);
  }

  /** Environment variables — sensitive, so writer-only. */
  async getEnv(userId: string, id: string): Promise<Record<string, string>> {
    const app = await this.requireWrite(userId, id);
    return this.appEnv(app);
  }

  async setEnv(userId: string, id: string, env: Record<string, string>): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: { envEnc: this.crypto.encrypt(JSON.stringify(env)) },
    });
    await this.audit.log({ actor: userId, action: "app.env.update", target: id });
  }

  async setLimits(
    userId: string,
    id: string,
    limits: { healthCmd?: string | null; memoryMb?: number | null; cpus?: number | null },
  ): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: {
        healthCmd: limits.healthCmd ?? null,
        memoryMb: limits.memoryMb ?? null,
        cpus: limits.cpus ?? null,
      },
    });
    await this.audit.log({ actor: userId, action: "app.limits.update", target: id });
  }

  // ── helpers ──
  private appEnv(app: Application): Record<string, string> {
    if (app.envEnc) {
      try {
        return JSON.parse(this.crypto.decrypt(app.envEnc)) as Record<string, string>;
      } catch {
        return {};
      }
    }
    return (app.env as Record<string, string>) ?? {};
  }

  /** Env injected at deploy: team shared variables overlaid by app-specific ones. */
  private async resolvedEnv(app: Application): Promise<Record<string, string>> {
    const shared = await this.prisma.sharedVariable.findMany({
      where: { teamId: app.teamId },
    });
    const merged: Record<string, string> = {};
    for (const v of shared) {
      try {
        merged[v.key] = this.crypto.decrypt(v.valueEnc);
      } catch {
        /* skip unreadable */
      }
    }
    return { ...merged, ...this.appEnv(app) }; // app-specific wins
  }

  private toSpec(app: Application): AppSpec {
    return {
      id: app.id,
      source: app.source,
      image: app.image,
      gitUrl: app.gitUrl,
      gitBranch: app.gitBranch,
      buildType: app.buildType,
      dockerfilePath: app.dockerfilePath,
      composeFile: app.composeFile,
      healthCmd: app.healthCmd,
      memoryMb: app.memoryMb,
      cpus: app.cpus,
      env: this.appEnv(app),
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
    const canWrite = WRITE.includes(role);
    return {
      id: app.id,
      name: app.name,
      source: app.source,
      image: app.image,
      gitUrl: app.gitUrl,
      gitBranch: app.gitBranch,
      buildType: app.buildType,
      composeFile: canWrite ? app.composeFile : null,
      healthCmd: app.healthCmd,
      memoryMb: app.memoryMb,
      cpus: app.cpus,
      serverId: app.serverId,
      teamId: app.teamId,
      status: app.status,
      hostPort: app.hostPort,
      containerPort: app.containerPort,
      domain: app.domain,
      https: app.https,
      url: app.domain ? `${app.https ? "https" : "http"}://${app.domain}` : null,
      // Webhook credentials are only exposed to members who can deploy.
      webhookToken: canWrite ? app.webhookToken : null,
      webhookSecret:
        canWrite && app.webhookSecret ? this.crypto.decrypt(app.webhookSecret) : null,
      envCount: Object.keys(this.appEnv(app)).length,
      role,
      canWrite,
      createdAt: app.createdAt,
    };
  }
}
