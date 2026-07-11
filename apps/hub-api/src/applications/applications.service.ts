import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { Application, AppStatus, Prisma, Role } from "@prisma/client";
import type { TeamPermission } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TeamAccessService, canAccessResource } from "../common/team-access.service";
import { loadProjectCtx, loadProjectCtxMany, type ResourceProjectCtx } from "../common/resource-project";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import { LogStreamService, type LogStreamEvent } from "../agent-gateway/log-stream.service";
import { CryptoService } from "../crypto/crypto.service";
import { ProxyService } from "./proxy.service";
import { MonitorsService } from "../monitors/monitors.service";
import { NotificationsService } from "../notifications/notifications.service";
import { GitSourcesService } from "../git-sources/git-sources.service";
import {
  buildImageRemoveScript,
  buildImageRemoveScriptForTag,
  buildRemoveScript,
  buildRestartScript,
  buildRunScript,
  buildBuildOnlyScript,
  buildRollingDeployScript,
  buildRecreateDeployScript,
  resolveHealthProbe,
  buildStartScript,
  buildStopScript,
  runTag,
  registryImageRef,
  containerName,
  type AppSpec,
  type AppVolume,
  type RegistryAuth,
} from "../deploy/deploy-script";
import {
  buildConfigSnapshot,
  diffSnapshots,
  type ConfigSnapshot,
} from "../deploy/config-snapshot";
import {
  buildComposeDownScript,
  buildComposeRestartScript,
  buildComposeStartScript,
  buildComposeStopScript,
  buildComposeUpScript,
  buildContainersScript,
  buildLogsScript,
  composeProject,
  parseContainers,
} from "../deploy/compose-script";
import {
  generateWebhookSecret,
  generateWebhookToken,
} from "../webhooks/webhook-verify";
import {
  TEMPLATES,
  buildTemplateEnv,
  templateMetaList,
  type TemplateMeta,
} from "../templates/catalog";
import { probeSsl, type SslStatus } from "./ssl-probe";
import { AiService } from "./ai.service";
import { TeamDefaultsService } from "../teams/team-defaults.service";
import { normalizeTags } from "../common/tags";
import { appUrl } from "../common/app-url";
import { magicDomain } from "./magic-domain";
import { inferComposeWeb } from "../deploy/compose-web";
import type { CreateAppInput } from "./dto";

const DEPLOY_TIMEOUT_MS = 300_000; // builds can be slow
const DEPLOY_IMAGE_KEEP = 5; // versioned images retained for rollback
// Default rolling health-gate timing (Slice 4 will make these per-app configurable).
const ROLLING_GATE = { retries: 20, intervalSec: 3, startPeriodSec: 5 };
// Raw docker flags that make two overlapping containers impossible (port map, own
// network/name/ip) → the app can't roll, so we fall back to hard cutover.
const RISKY_DOCKER_OPTS = /(^|\s)(--ip6?|-p|--publish|--network|--name)(\s|=|$)/;

export interface AppView {
  id: string;
  name: string;
  source: "IMAGE" | "GIT" | "COMPOSE";
  image: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  buildType: "NIXPACKS" | "DOCKERFILE" | "STATIC" | "RAILPACK" | "HEROKU";
  buildCommand: string | null;
  outputDir: string | null;
  composeFile: string | null;
  healthCmd: string | null;
  healthCheckType: string | null;
  healthCheckPath: string | null;
  healthCheckPort: number | null;
  memoryMb: number | null;
  cpus: number | null;
  deployTimeoutSec: number | null;
  dockerOptions: string | null;
  volumes: AppVolume[];
  hasGitToken: boolean;
  registryUrl: string | null;
  registryUser: string | null;
  registryId: string | null;
  pushToRegistry: boolean;
  buildServerId: string | null;
  deployStrategy: string;
  rollbackOnFailure: boolean;
  zeroDowntime: boolean;
  templateSlug: string | null;
  templateLogo: string | null;
  environmentId: string | null;
  projectId: string | null;
  projectName: string | null;
  environmentName: string | null;
  serverId: string;
  teamId: string;
  status: AppStatus;
  hostPort: number | null;
  containerPort: number | null;
  domain: string | null;
  domainRedirect: string | null;
  securityHeaders: boolean;
  forwardAuth: string | null;
  https: boolean;
  domainKind: string;
  exposeMode: string;
  certType: string;
  url: string | null;
  webhookToken: string | null;
  webhookSecret: string | null;
  isPreview: boolean;
  previewEnabled: boolean;
  prNumber: number | null;
  parentAppId: string | null;
  tags: string[];
  volumeBackupEnabled: boolean;
  volumeBackupIntervalHours: number | null;
  volumeBackupRetention: number;
  volumeBackupDestinationId: string | null;
  envCount: number;
  canWrite: boolean;
  createdAt: Date;
}

export interface DomainView {
  id: string;
  appId: string;
  appStatus: AppStatus;
  teamId: string;
  name: string;
  domain: string;
  https: boolean;
  url: string | null;
  domainRedirect: string | null;
  securityHeaders: boolean;
  ssl: SslStatus;
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TeamAccessService,
    private readonly audit: AuditService,
    private readonly agentWs: AgentWsServer,
    private readonly deployLogs: DeployLogHub,
    private readonly logStream: LogStreamService,
    private readonly proxy: ProxyService,
    private readonly crypto: CryptoService,
    private readonly monitors: MonitorsService,
    private readonly notifications: NotificationsService,
    private readonly gitSources: GitSourcesService,
    private readonly ai: AiService,
    private readonly teamDefaults: TeamDefaultsService,
  ) {}

  /**
   * Resolve a new app's initial exposure. A user-provided domain is "custom" and
   * served over HTTPS (Let's Encrypt) as today. Otherwise, with the default
   * exposeMode "magic" on a non-COMPOSE app, generate a sslip.io magic domain from
   * the server's public IP — served over plain HTTP (certType "http") so it's
   * reachable the instant the app is created. If no public IP is available (or
   * exposeMode isn't magic), leave it domainless and fall back to the host:port URL.
   */
  /** The primary web service + container port of a COMPOSE app: an explicit template
   *  `web` override, else inferred from the compose file. Null when undeterminable. */
  private composeWeb(app: {
    templateSlug?: string | null;
    composeFile?: string | null;
  }): { service: string; port: number } | null {
    const override = app.templateSlug ? TEMPLATES[app.templateSlug]?.web : undefined;
    return override ?? inferComposeWeb(app.composeFile ?? null);
  }

  private resolveExpose(
    input: { name: string; domain?: string | null; exposeMode?: string; https?: boolean },
    server: {
      publicIp: string | null;
      publicIpv6: string | null;
      wildcardDomain: string | null;
      magicSuffix: string | null;
      certMode: string;
    },
    source: string,
    // For a COMPOSE app, the resolved web service (or null) — magic is only offered
    // when we know which service to route, otherwise the domain would be unreachable.
    composeWebService?: string | null,
  ): { domain: string | null; https: boolean; exposeMode: string; domainKind: string; certType: string } {
    const exposeMode = input.exposeMode ?? "magic";
    if (input.domain) {
      // A user domain is custom + HTTPS (Let's Encrypt). Force https:true so the
      // stored scheme matches certType le-http (mirrors setDomain) — otherwise a
      // caller passing https:false would show http:// while Traefik serves HTTPS.
      return { domain: input.domain, https: true, exposeMode: "custom", domainKind: "custom", certType: "le-http" };
    }
    if (exposeMode === "magic" && (source !== "COMPOSE" || !!composeWebService)) {
      const suffix = server.magicSuffix ?? process.env.MAGIC_DOMAIN_SUFFIX ?? "sslip.io";
      const magic = magicDomain({
        name: input.name,
        publicIp: server.publicIp,
        publicIpv6: server.publicIpv6,
        wildcardDomain: server.wildcardDomain,
        suffix,
      });
      if (magic) {
        // A wildcard DNS-01 cert (le-dns) gives every magic app on the server HTTPS
        // under one cert; otherwise magic stays plain HTTP.
        return server.certMode === "le-dns" && server.wildcardDomain
          ? { domain: magic, https: true, exposeMode, domainKind: "magic", certType: "le-dns" }
          : { domain: magic, https: false, exposeMode, domainKind: "magic", certType: "http" };
      }
    }
    return { domain: null, https: input.https ?? true, exposeMode, domainKind: "none", certType: "http" };
  }

  /**
   * Recompute magic domains for every magic app on a server after its IP / wildcard
   * changed, preserving each app's existing subdomain label so its URL stays stable
   * (only the IP/suffix part moves). Best-effort; skips apps whose domain is
   * unchanged or whose server can no longer produce a magic domain. Preview apps are
   * excluded — they derive their domain from the parent on the next PR sync. The new
   * domain applies to Traefik on the next deploy (DB + AppView.url update immediately).
   */
  async regenerateMagicForServer(serverId: string): Promise<void> {
    const server = await this.prisma.server
      .findUnique({
        where: { id: serverId },
        select: { publicIp: true, publicIpv6: true, wildcardDomain: true, magicSuffix: true },
      })
      .catch(() => null);
    if (!server) return;
    const apps = await this.prisma.application
      .findMany({ where: { serverId, domainKind: "magic", isPreview: false } })
      .catch(() => [] as Application[]);
    const suffix = server.magicSuffix ?? process.env.MAGIC_DOMAIN_SUFFIX ?? "sslip.io";
    for (const app of apps) {
      const label = (app.domain ?? "").split(".")[0]; // {slug}-{hash} — keep the URL stable
      const next = magicDomain({
        name: app.name,
        label,
        publicIp: server.publicIp,
        publicIpv6: server.publicIpv6,
        wildcardDomain: server.wildcardDomain,
        suffix,
      });
      if (next && next !== app.domain) {
        await this.prisma.application.update({ where: { id: app.id }, data: { domain: next } }).catch(() => undefined);
        await this.syncMonitor(app.id).catch(() => undefined);
      }
    }
  }

  /**
   * Re-sync the auto uptime monitor after an app's domain changes. There is no
   * updateForApp, so remove then recreate — createForApp no-ops for domainless or
   * preview apps, making this self-correcting.
   */
  private async syncMonitor(appId: string): Promise<void> {
    await this.monitors.removeForApp(appId);
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (app) await this.monitors.createForApp(app);
  }

  async create(userId: string, dto: CreateAppInput): Promise<AppView> {
    const server = await this.prisma.server.findUnique({
      where: { id: dto.serverId },
    });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
    if (dto.environmentId) await this.assertEnvInTeam(dto.environmentId, server.teamId);
    // Never orphan: fall back to the team's default environment when none is chosen.
    const environmentId =
      dto.environmentId ?? (await this.teamDefaults.resolveDefaultEnvironmentId(server.teamId));
    if (dto.gitSourceId) {
      const gs = await this.prisma.gitSource.findUnique({ where: { id: dto.gitSourceId } });
      if (!gs || gs.teamId !== server.teamId) throw new BadRequestException("git source not found in this team");
    }

    const source = dto.source ?? "IMAGE";
    const composeWebService =
      source === "COMPOSE" ? (this.composeWeb({ templateSlug: dto.templateSlug, composeFile: dto.composeFile })?.service ?? null) : null;
    const expose = this.resolveExpose(dto, server, source, composeWebService);

    const app = await this.prisma.application.create({
      data: {
        name: dto.name,
        templateSlug: dto.templateSlug ?? null,
        environmentId,
        source,
        image: dto.image ?? null,
        gitUrl: dto.gitUrl ?? null,
        gitBranch: dto.gitBranch ?? "main",
        gitSourceId: dto.gitSourceId ?? null,
        buildType: dto.buildType ?? "NIXPACKS",
        dockerfilePath: dto.dockerfilePath ?? null,
        buildCommand: dto.buildCommand ?? null,
        outputDir: dto.outputDir ?? null,
        composeFile: dto.composeFile ?? null,
        serverId: dto.serverId,
        teamId: server.teamId,
        env: {} as Prisma.InputJsonValue,
        envEnc: this.crypto.encrypt(JSON.stringify(dto.env ?? {})),
        hostPort: dto.hostPort ?? null,
        containerPort: dto.containerPort ?? 80,
        domain: expose.domain,
        https: expose.https,
        exposeMode: expose.exposeMode,
        domainKind: expose.domainKind,
        certType: expose.certType,
        tags: normalizeTags(dto.tags ?? []),
        webhookToken: generateWebhookToken(),
        webhookSecret: this.crypto.encrypt(generateWebhookSecret()),
      },
    });
    // Grant-on-create: the creator keeps access to what they made even if later restricted.
    await this.access.grantResourceAccess(userId, server.teamId, app.id);
    await this.audit.log({ actor: userId, action: "app.create", target: app.id });
    // Auto-track uptime for a domained app (best-effort; never blocks creation).
    await this.monitors.createForApp(app).catch(() => undefined);
    if (dto.deploy) {
      // Best-effort: kick off the first deploy so a one-click install actually
      // runs. Fire-and-forget — the build can take minutes, and a missing/offline
      // agent must not fail creation (mirrors deployFromWebhook). RBAC is already
      // enforced by requireRole(WRITE) above.
      void this.runDeploy(app, userId).catch(() => undefined);
    }
    const perms = await this.access.membershipPermissions(userId, server.teamId);
    return this.view(app, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, undefined, server.publicIp ?? server.publicIpv6);
  }

  /** One-click template catalog (gallery metadata only). */
  listTemplates(): TemplateMeta[] {
    return templateMetaList();
  }

  /** Instantiate a curated template as a COMPOSE app (secrets generated here). */
  async createFromTemplate(
    userId: string,
    slug: string,
    input: { name: string; serverId: string; environmentId?: string; deploy?: boolean },
  ): Promise<AppView> {
    const tpl = TEMPLATES[slug];
    if (!tpl) throw new NotFoundException("template not found");
    return this.create(userId, {
      name: input.name,
      serverId: input.serverId,
      templateSlug: slug,
      source: "COMPOSE",
      composeFile: tpl.composeFile,
      env: buildTemplateEnv(tpl),
      environmentId: input.environmentId,
      deploy: input.deploy,
    });
  }

  async list(userId: string): Promise<AppView[]> {
    const access = await this.access.accessByTeam(userId);
    const perms = await this.access.permissionsByTeam(userId);
    const ids = [...access.keys()];
    if (!ids.length) return [];
    const apps = await this.prisma.application.findMany({
      // Preview apps are nested under their parent, never in the top-level list.
      where: { teamId: { in: ids }, isPreview: false },
      orderBy: { createdAt: "desc" },
    });
    const ctxByEnv = await loadProjectCtxMany(this.prisma, apps.map((a) => a.environmentId));
    const ipByServer = await this.serverIpMap(apps.map((a) => a.serverId));
    // Per-resource scoping: a restricted member only sees apps in projects they're granted.
    return apps
      .filter((a) => canAccessResource(access.get(a.teamId), a.id, ctxByEnv.get(a.environmentId)?.projectId ?? null))
      .map((a) =>
        this.view(a, perms.get(a.teamId)?.has("apps:config") ?? false, perms.get(a.teamId)?.has("apps:deploy") ?? false, ctxByEnv.get(a.environmentId), ipByServer.get(a.serverId) ?? null),
      );
  }

  async get(userId: string, id: string): Promise<AppView> {
    const app = await this.require(userId, id);
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    const ctx = await loadProjectCtx(this.prisma, app.environmentId);
    return this.view(app, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, ctx, await this.serverIp(app.serverId));
  }

  async deploy(userId: string, id: string, opts?: { noCache?: boolean }) {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    await this.ensureNoActiveDeploy(id);
    return this.runDeploy(app, userId, opts?.noCache ?? false);
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

  // ── Preview deployments (B6) ──

  /**
   * Create-or-update a per-PR preview deploy from a verified webhook. A preview
   * is a throwaway clone of the parent app on the PR's head branch with its own
   * subdomain (`pr<n>.<parentDomain>`). No-op unless the parent opted in
   * (previewEnabled) and has a domain to derive the subdomain from. Fire-and-forget.
   */
  async upsertPreview(parent: Application, prNumber: number, headRef: string) {
    if (!parent.previewEnabled || !parent.domain) return;
    const existing = await this.prisma.application.findFirst({
      where: { parentAppId: parent.id, prNumber },
    });
    const previewDomain = `pr${prNumber}.${this.baseDomain(parent.domain)}`;
    let preview: Application;
    if (existing) {
      // Re-sync the head branch (a PR can be retargeted) before redeploying.
      preview = await this.prisma.application.update({
        where: { id: existing.id },
        data: { gitBranch: headRef },
      });
    } else {
      preview = await this.prisma.application.create({
        data: {
          name: `${parent.name} · PR #${prNumber}`,
          teamId: parent.teamId,
          serverId: parent.serverId,
          environmentId: parent.environmentId,
          source: parent.source,
          image: parent.image,
          gitUrl: parent.gitUrl,
          gitBranch: headRef,
          buildType: parent.buildType,
          dockerfilePath: parent.dockerfilePath,
          buildCommand: parent.buildCommand,
          outputDir: parent.outputDir,
          composeFile: parent.composeFile,
          healthCmd: parent.healthCmd,
          healthCheckType: parent.healthCheckType,
          healthCheckPath: parent.healthCheckPath,
          healthCheckPort: parent.healthCheckPort,
          memoryMb: parent.memoryMb,
          cpus: parent.cpus,
          volumes: (parent.volumes ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          gitTokenEnc: parent.gitTokenEnc,
          registryAuthEnc: parent.registryAuthEnc,
          env: {} as Prisma.InputJsonValue,
          envEnc: parent.envEnc,
          containerPort: parent.containerPort,
          domain: previewDomain,
          https: parent.https,
          // Mirror the parent's exposure so a preview of an HTTPS custom-domain app
          // keeps certType le-http (a subdomain cert) instead of falling to the
          // "http" default and being served over plain HTTP by the certType-aware labels.
          domainKind: parent.domainKind,
          exposeMode: parent.exposeMode,
          certType: parent.certType,
          // Preview-specific: no webhook of its own (parent owns the trigger).
          isPreview: true,
          parentAppId: parent.id,
          prNumber,
        },
      });
    }
    await this.audit.log({
      actor: "webhook:pr",
      action: "preview.deploy",
      target: preview.id,
      meta: { parentAppId: parent.id, prNumber, headRef },
    });
    return this.runDeploy(preview, "webhook:pr");
  }

  /** Tear down the preview for a closed/merged PR (no-op if none exists). */
  async removePreviewByPr(parentId: string, prNumber: number) {
    const preview = await this.prisma.application.findFirst({
      where: { parentAppId: parentId, prNumber, isPreview: true },
    });
    if (!preview) return;
    await this.removePreview(preview, "webhook:pr");
  }

  /** Active previews for a parent app (members only). */
  async listPreviews(userId: string, parentId: string): Promise<AppView[]> {
    const parent = await this.require(userId, parentId);
    const parentPerms = await this.access.membershipPermissions(userId, parent.teamId);
    const previews = await this.prisma.application.findMany({
      where: { parentAppId: parentId, isPreview: true },
      orderBy: { createdAt: "desc" },
    });
    const ipByServer = await this.serverIpMap(previews.map((p) => p.serverId));
    return previews.map((p) =>
      this.view(p, parentPerms?.has("apps:config") ?? false, parentPerms?.has("apps:deploy") ?? false, undefined, ipByServer.get(p.serverId) ?? null),
    );
  }

  /** Toggle per-PR previews on a parent app — requires a domain to build URLs. */
  async setPreviewEnabled(userId: string, id: string, enabled: boolean): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (enabled && !app.domain) {
      throw new BadRequestException("set a domain on the app before enabling previews");
    }
    await this.prisma.application.update({
      where: { id },
      data: { previewEnabled: enabled },
    });
    await this.audit.log({ actor: userId, action: "app.preview.config", target: id });
  }

  /** Manually remove a single preview (writer on the parent app). */
  async deletePreview(userId: string, parentId: string, previewId: string): Promise<void> {
    await this.requireWrite(userId, parentId, "apps:deploy");
    const preview = await this.prisma.application.findFirst({
      where: { id: previewId, parentAppId: parentId, isPreview: true },
    });
    if (!preview) throw new NotFoundException("preview not found");
    await this.removePreview(preview, userId);
  }

  /** Shared teardown: stop+remove the preview container, then delete the record. */
  private async removePreview(app: Application, actor: string): Promise<void> {
    const cmd = buildRemoveScript(app, this.appVolumes(app));
    await this.agentWs.sendCommand(app.serverId, cmd, "deploy").catch(() => undefined);
    await this.prisma.application.delete({ where: { id: app.id } });
    await this.audit.log({ actor, action: "preview.remove", target: app.id });
  }

  /** Strip a leading `www.` so previews hang off the apex domain. */
  private baseDomain(domain: string): string {
    return domain.replace(/^www\./i, "");
  }

  /**
   * Zero-downtime rolling is safe only for a routed app with no host port, no risky
   * raw docker flags, and no named volumes (two overlapping containers would share the
   * same volume and could corrupt data). Otherwise deploy is a hard cutover.
   */
  private rollingEligible(app: Application): boolean {
    return (
      !!app.domain &&
      app.deployStrategy === "ROLLING" &&
      app.rollbackOnFailure &&
      !app.hostPort &&
      !(app.dockerOptions && RISKY_DOCKER_OPTS.test(app.dockerOptions)) &&
      this.appVolumes(app).length === 0
    );
  }

  /** Core deploy: build/run on the agent and record the Deployment. */
  private async runDeploy(app: Application, actor: string, noCache = false) {
    const dep = await this.prisma.deployment.create({
      data: { appId: app.id, status: "RUNNING" },
    });
    this.deployLogs.begin(app.id);
    try {
      const isCompose = app.source === "COMPOSE";
      // A compose app also needs the proxy when its web service is routable (magic).
      const composeRoutable = isCompose && !!this.composeWeb(app);
      if (app.domain && (!isCompose || composeRoutable)) await this.proxy.ensureProxy(app.serverId);
      const spec = this.toSpec(app);
      spec.env = await this.resolvedEnv(app); // team shared vars + app env (app wins)
      spec.buildArgs = this.appBuildArgs(app); // build-time vars (app-specific only)
      await this.hydrateCertSpec(app, spec);
      // Private repo via a GitHub App: mint a fresh installation token for the clone.
      if (app.gitSourceId && app.source === "GIT") {
        spec.gitToken = await this.gitSources.installationToken(app.gitSourceId);
      }
      // Push the built image to the app's team registry (build-time), if configured.
      if (app.pushToRegistry && app.registryId && !isCompose) {
        const reg = await this.prisma.registry.findFirst({ where: { id: app.registryId, teamId: app.teamId } });
        if (reg) {
          const auth: RegistryAuth = { url: reg.url ?? undefined, user: reg.username, token: this.crypto.decrypt(reg.passwordEnc) };
          spec.registryPush = { auth, tag: registryImageRef(reg, app, dep.id) };
        }
      }
      // Capture the pushed ref before it is cleared (build-server path nulls registryPush) so
      // the deployment records it → a later rollback can pull it even after local prune.
      const registryRef = spec.registryPush?.tag ?? null;
      // Record a redacted config snapshot so the Deployments view can diff it.
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: { configSnapshot: buildConfigSnapshot(spec) as object },
      });
      // Strategy: rolling (zero-downtime overlap) for eligible routed apps; recreate
      // (stop→start→health-gate→restore-previous-on-failure) for every other app that
      // wants auto-rollback (host-port, named volume, risky docker opts, RECREATE); plain
      // hard cutover only when the user opted out of rollback (rollbackOnFailure=false).
      const rolling = !isCompose && this.rollingEligible(app);
      const recreate = !isCompose && !rolling && app.rollbackOnFailure;
      // The previous good image to fall back to on a failed recreate (its retained tag is
      // runTag(app, prev.id)). Excludes the current deployment; requires a kept image.
      const prev = recreate
        ? await this.prisma.deployment.findFirst({
            where: { appId: app.id, status: "SUCCESS", imageTag: { not: null }, id: { not: dep.id } },
            orderBy: { createdAt: "desc" },
          })
        : null;
      // Separate build server: build + push the image on it, then have the deploy server PULL
      // + run it (via registryPull). Registry is mandatory (the deploy server never builds).
      let buildLog = "";
      if (!isCompose && app.buildServerId) {
        if (!spec.registryPush) {
          throw new Error("a build server is set but no registry is configured — assign a registry to deploy");
        }
        const buildScript = buildBuildOnlyScript(spec, dep.id, noCache);
        const br = await this.agentWs.sendCommand(
          app.buildServerId,
          buildScript,
          "deploy",
          this.deployTimeoutMs(app),
          (chunk) => this.deployLogs.push(app.id, chunk),
        );
        buildLog = br.output;
        // Surface the real build error in the persisted record, not just a generic message.
        if (br.exitCode !== 0) throw new Error(`image build failed on the build server\n${br.output}`);
        // The deploy server pulls the just-pushed image instead of building it.
        spec.registryPull = { auth: spec.registryPush.auth, ref: spec.registryPush.tag };
        spec.registryPush = null;
      }
      const command = isCompose
        ? buildComposeUpScript(spec, noCache)
        : rolling
          ? buildRollingDeployScript(spec, dep.id, { build: true, noCache, probe: resolveHealthProbe(spec), ...ROLLING_GATE })
          : recreate
            ? buildRecreateDeployScript(spec, dep.id, {
                build: true,
                noCache,
                prevVersion: prev?.id ?? null,
                probe: resolveHealthProbe(spec),
                ...ROLLING_GATE,
              })
            : buildRunScript(spec, dep.id, true, noCache);
      const r = await this.agentWs.sendCommand(
        app.serverId,
        command,
        "deploy",
        this.deployTimeoutMs(app),
        (chunk) => this.deployLogs.push(app.id, chunk),
      );
      // Exit-code contract from the rolling/recreate scripts: 0 = healthy & live, 3 = new
      // version failed its health gate and the PREVIOUS one is serving (auto-rollback),
      // anything else = hard failure. Only rolling/recreate emit exit 3, and only when a
      // previous live version actually existed — so a plain hard-cutover build or a first
      // deploy that merely happens to exit 3 is a hard fail (not a false "kept the previous
      // version" that would leave the app wrongly marked RUNNING).
      const code = r.exitCode;
      const ok = code === 0;
      let rolledBack = false;
      if (code === 3 && !isCompose) {
        if (recreate) {
          rolledBack = !!prev; // recreate only exits 3 when it had a previous image to restore
        } else if (rolling) {
          const p = await this.prisma.deployment.findFirst({
            where: { appId: app.id, status: "SUCCESS", imageTag: { not: null }, id: { not: dep.id } },
          });
          rolledBack = !!p;
        }
      }
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          kind: rolledBack ? "AUTO_ROLLBACK" : "DEPLOY",
          // Prepend the build-server phase output so the persisted record has the full log.
          logs: (buildLog ? `${buildLog}\n${r.output}` : r.output).slice(0, 65536),
          exitCode: code,
          // Compose stacks are multi-image → no single rollback tag; a rolled-back
          // deploy's image never went live → no rollback tag either.
          imageTag: ok && !isCompose ? runTag(app, dep.id) : null,
          // The registry ref this build pushed to — lets rollback pull it even if the local
          // image was pruned. Only recorded on a successful push.
          registryImage: ok ? registryRef : null,
        },
      });
      await this.prisma.application.update({
        where: { id: app.id },
        // A rolled-back deploy keeps the previous container running → app is still RUNNING.
        data: { status: ok || rolledBack ? AppStatus.RUNNING : AppStatus.FAILED },
      });
      this.deployLogs.finish(app.id, {
        status: ok ? "SUCCESS" : "FAILED",
        exitCode: code,
        deploymentId: dep.id,
      });
      this.notifications
        .fireForEvent(
          app.teamId,
          ok ? "deploy_success" : rolledBack ? "deploy_rolled_back" : "deploy_failed",
          ok
            ? `✅ ${app.name}: deploy succeeded`
            : rolledBack
              ? `⚠️ ${app.name}: new version failed its health check — kept the previous version`
              : `🔴 ${app.name}: deploy failed`,
        )
        .catch(() => {});
      if (ok && !isCompose) {
        await this.pruneImages(app);
      } else if (!isCompose) {
        // A failed/rolled-back deploy built tugra_<id>:<depId> but it never went live →
        // reap the orphan image so repeated failures don't leak disk.
        await this.agentWs
          .sendCommand(app.serverId, buildImageRemoveScript(app, dep.id), "cleanup")
          .catch(() => undefined);
      }
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
      this.notifications.fireForEvent(app.teamId, "deploy_failed", `🔴 ${app.name}: deploy failed`).catch(() => {});
    }
    await this.audit.log({ actor, action: "app.deploy", target: app.id });
    return this.prisma.deployment.findUnique({ where: { id: dep.id } });
  }

  /** Re-run a previous successful deployment's image without rebuilding/pulling. */
  async rollback(userId: string, id: string, targetDeploymentId: string) {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    if (app.source === "COMPOSE") {
      throw new BadRequestException("rollback not supported for compose apps");
    }
    const target = await this.prisma.deployment.findFirst({
      where: { id: targetDeploymentId, appId: id, status: "SUCCESS" },
    });
    // Rollbackable if either the local image tag is still retained OR the deploy pushed a
    // portable registry image (which survives a local prune / host re-provision).
    if (!target || (!target.imageTag && !target.registryImage)) {
      throw new NotFoundException("no rollbackable deployment with that id");
    }
    // Resolve the image source BEFORE creating the deployment / touching app status. Prefer the
    // retained LOCAL tag (fast, no network — and a transient registry outage can't break it);
    // pull from the registry only when the local image is gone. If neither is usable, 404 up
    // front so a still-running app is never flipped to FAILED for an impossible rollback.
    let registryPull: { auth: RegistryAuth; ref: string } | null = null;
    if (!target.imageTag && target.registryImage && app.registryId) {
      const reg = await this.prisma.registry.findFirst({ where: { id: app.registryId, teamId: app.teamId } });
      if (reg) {
        const auth: RegistryAuth = { url: reg.url ?? undefined, user: reg.username, token: this.crypto.decrypt(reg.passwordEnc) };
        registryPull = { auth, ref: target.registryImage };
      }
    }
    if (!registryPull && !target.imageTag) {
      throw new NotFoundException("the image for this deployment is no longer available locally and cannot be pulled from a registry");
    }
    const dep = await this.prisma.deployment.create({
      data: { appId: app.id, status: "RUNNING", kind: "ROLLBACK" },
    });
    this.deployLogs.begin(app.id);
    try {
      if (app.domain) await this.proxy.ensureProxy(app.serverId);
      const spec = this.toSpec(app);
      spec.env = await this.resolvedEnv(app);
      await this.hydrateCertSpec(app, spec); // le-dns wildcard labels must match a normal deploy
      if (registryPull) spec.registryPull = registryPull;
      // registryPull → build=true so prepSteps PULLS + tags; else build=false re-runs the local tag.
      const r = await this.agentWs.sendCommand(
        app.serverId,
        buildRunScript(spec, target.id, !!registryPull),
        "deploy",
        this.deployTimeoutMs(app),
        (chunk) => this.deployLogs.push(app.id, chunk),
      );
      const ok = r.exitCode === 0;
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          logs: `rolled back to ${target.id}\n${r.output.slice(0, 65000)}`,
          exitCode: r.exitCode,
          imageTag: ok ? runTag(app, target.id) : null,
          registryImage: ok ? target.registryImage : null,
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
      // Remove the EXACT recorded tag: a rollback row stores the target's tag (tugra_<id>:<targetId>),
      // not one derived from its own deployment id, so reconstructing from d.id would miss it.
      if (d.imageTag) {
        await this.agentWs
          .sendCommand(app.serverId, buildImageRemoveScriptForTag(d.imageTag), "cleanup")
          .catch(() => undefined);
      }
      await this.prisma.deployment.update({
        where: { id: d.id },
        data: { imageTag: null },
      });
    }
  }

  async regenerateWebhook(userId: string, id: string): Promise<AppView> {
    // The webhook secret is a deploy trigger, so rotating it is an apps:deploy action.
    const app = await this.requireWrite(userId, id, "apps:deploy");
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
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    // Resolve the server IP like the other single-app paths so a domainless,
    // port-publishing app keeps its synthesized url in this response (consistency).
    return this.view(updated, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, undefined, await this.serverIp(updated.serverId));
  }

  async stop(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    const cmd =
      app.source === "COMPOSE"
        ? buildComposeStopScript(this.toSpec(app))
        : buildStopScript(app);
    await this.agentWs.sendCommand(app.serverId, cmd, "deploy").catch(() => undefined);
    await this.prisma.application.update({
      where: { id },
      data: { status: AppStatus.STOPPED },
    });
    await this.audit.log({ actor: userId, action: "app.stop", target: id });
  }

  async start(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    const cmd =
      app.source === "COMPOSE"
        ? buildComposeStartScript(this.toSpec(app))
        : buildStartScript(app);
    await this.agentWs.sendCommand(app.serverId, cmd, "deploy").catch(() => undefined);
    await this.prisma.application.update({ where: { id }, data: { status: AppStatus.RUNNING } });
    await this.audit.log({ actor: userId, action: "app.start", target: id });
  }

  async restart(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    const cmd =
      app.source === "COMPOSE"
        ? buildComposeRestartScript(this.toSpec(app))
        : buildRestartScript(app);
    await this.agentWs.sendCommand(app.serverId, cmd, "deploy").catch(() => undefined);
    await this.prisma.application.update({ where: { id }, data: { status: AppStatus.RUNNING } });
    await this.audit.log({ actor: userId, action: "app.restart", target: id });
  }

  async remove(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    const cmd =
      app.source === "COMPOSE"
        ? buildComposeDownScript(this.toSpec(app), { volumes: true })
        : buildRemoveScript(app, this.appVolumes(app));
    await this.agentWs.sendCommand(app.serverId, cmd, "deploy").catch(() => undefined);
    await this.monitors.removeForApp(id).catch(() => undefined);
    await this.prisma.application.delete({ where: { id } });
    await this.audit.log({ actor: userId, action: "app.remove", target: id });
  }

  async deployments(userId: string, id: string) {
    await this.require(userId, id);
    const rows = await this.prisma.deployment.findMany({
      where: { appId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    // Diff each deploy's config against the immediately older one (rows are
    // newest-first, so the previous deploy is the next index).
    return rows.map((d, i) => {
      const next = (d.configSnapshot as ConfigSnapshot | null) ?? null;
      const prev = (rows[i + 1]?.configSnapshot as ConfigSnapshot | null) ?? null;
      const { configSnapshot: _snap, ...rest } = d;
      return { ...rest, configChanges: next ? diffSnapshots(prev, next) : [] };
    });
  }

  /** AI-powered diagnosis of a deployment's logs (opt-in; writer-only). */
  async analyzeDeployment(userId: string, appId: string, depId: string): Promise<{ analysis: string }> {
    const app = await this.requireWrite(userId, appId, "apps:deploy");
    const dep = await this.prisma.deployment.findUnique({ where: { id: depId } });
    if (!dep || dep.appId !== appId) throw new NotFoundException("deployment not found");
    if (!dep.logs) throw new BadRequestException("deployment has no logs to analyze");
    const analysis = await this.ai.analyze(dep.logs, {
      appName: app.name,
      status: dep.status,
      exitCode: dep.exitCode,
    });
    await this.audit.log({ actor: userId, action: "app.deploy.analyze", target: appId });
    return { analysis };
  }

  /** List the app's docker containers (compose: all services) — for the terminal picker. */
  async listContainers(userId: string, id: string): Promise<{ containers: { name: string; state: string }[] }> {
    const app = await this.requireWrite(userId, id);
    const r = await this.agentWs.sendCommand(app.serverId, buildContainersScript(this.toSpec(app)), "deploy", 30_000);
    return { containers: parseContainers(r.output) };
  }

  /** Tail the running container's logs — writer-only (output may contain secrets). */
  async appLogs(userId: string, id: string, tail?: number): Promise<{ output: string }> {
    const app = await this.requireWrite(userId, id);
    const r = await this.agentWs.sendCommand(
      app.serverId,
      buildLogsScript(this.toSpec(app), tail),
      "deploy",
      60_000,
    );
    return { output: r.output.slice(0, 65536) };
  }

  /**
   * Live `docker logs --follow` stream over the signed "logs" capability. Writer-only (logs can
   * contain secrets, like appLogs). The container name is derived/validated server-side — for a
   * compose app the caller picks a container that MUST belong to this app's `tugra_<id>` project;
   * for a single-container app the client value is ignored entirely.
   */
  async streamContainerLogs(
    userId: string,
    id: string,
    opts: { container?: string; tail?: number; follow?: boolean },
  ): Promise<Observable<LogStreamEvent>> {
    const app = await this.requireWrite(userId, id);
    let target: string;
    if (app.source === "COMPOSE") {
      const prefix = composeProject(app); // `tugra_${app.id}`
      const container = opts.container ?? "";
      if (container !== prefix && !container.startsWith(`${prefix}-`)) {
        throw new BadRequestException("invalid container for this app");
      }
      target = container;
    } else {
      target = containerName(app);
    }
    if (!this.agentWs.isOnline(app.serverId)) throw new ServiceUnavailableException("agent offline");
    // tail is a SIGNED field (canonicalLogStart). A non-finite value (e.g. ?tail=abc → NaN) would be
    // signed as "NaN" but wire-serialized to null → the agent decodes 0 and the signature never
    // verifies, hanging the stream. `?? 200` only guards null/undefined, so filter NaN explicitly.
    const rawTail = Number.isFinite(opts.tail) ? (opts.tail as number) : 200;
    const tail = Math.max(1, Math.min(2000, Math.floor(rawTail)));
    await this.audit.log({ actor: userId, action: "app.logs.stream", target: id });
    return this.logStream.stream(app.serverId, target, { tail, follow: opts.follow ?? true });
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

  /** Build-time variables (injected during image build, separate from runtime env). */
  async getBuildArgs(userId: string, id: string): Promise<Record<string, string>> {
    const app = await this.requireWrite(userId, id);
    return this.appBuildArgs(app);
  }

  async setBuildArgs(userId: string, id: string, buildArgs: Record<string, string>): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: { buildArgsEnc: this.crypto.encrypt(JSON.stringify(buildArgs)) },
    });
    await this.audit.log({ actor: userId, action: "app.build_args.update", target: id });
  }

  async rename(userId: string, id: string, name: string): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({ where: { id }, data: { name } });
    await this.audit.log({ actor: userId, action: "app.name.update", target: id });
  }

  async setDockerOptions(userId: string, id: string, dockerOptions: string | null): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({ where: { id }, data: { dockerOptions } });
    await this.audit.log({ actor: userId, action: "app.docker_options.update", target: id });
  }

  /** Per-app deploy/rollback timeout in ms (default 5 min). */
  private deployTimeoutMs(app: Application): number {
    return (app.deployTimeoutSec ?? 300) * 1000;
  }

  async setLimits(
    userId: string,
    id: string,
    limits: { memoryMb?: number | null; cpus?: number | null; deployTimeoutSec?: number | null },
  ): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: {
        memoryMb: limits.memoryMb ?? null,
        cpus: limits.cpus ?? null,
        deployTimeoutSec: limits.deployTimeoutSec ?? null,
      },
    });
    await this.audit.log({ actor: userId, action: "app.limits.update", target: id });
  }

  /** Configure the deploy-gate health check. type null = auto; "NONE"|"HTTP"|"CMD" force
   *  it. A CMD check reuses `healthCmd`; HTTP uses path/port. */
  async setHealthCheck(
    userId: string,
    id: string,
    hc: { type?: string | null; path?: string | null; port?: number | null; command?: string | null },
  ): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: {
        healthCheckType: hc.type ?? null,
        healthCheckPath: hc.path ?? null,
        healthCheckPort: hc.port ?? null,
        // Only a CMD check owns healthCmd; other types leave any existing command intact
        // (resolveHealthProbe ignores it when the type isn't CMD/auto) so a save under
        // Auto/HTTP/None never silently wipes a previously-configured command.
        ...(hc.type === "CMD" ? { healthCmd: hc.command ?? null } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "app.healthcheck.update", target: id });
  }

  async setVolumes(userId: string, id: string, volumes: AppVolume[]): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: { volumes: volumes as unknown as Prisma.InputJsonValue },
    });
    await this.audit.log({ actor: userId, action: "app.volumes.update", target: id });
  }

  async setTags(userId: string, id: string, tags: string[]): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: { tags: normalizeTags(tags) },
    });
    await this.audit.log({ actor: userId, action: "app.tags.update", target: id });
  }

  async setCredentials(
    userId: string,
    id: string,
    creds: { gitToken?: string | null; registry?: RegistryAuth | null },
  ): Promise<void> {
    await this.requireWrite(userId, id);
    const data: Prisma.ApplicationUpdateInput = {};
    if (creds.gitToken !== undefined) {
      data.gitTokenEnc = creds.gitToken ? this.crypto.encrypt(creds.gitToken) : null;
    }
    if (creds.registry !== undefined) {
      data.registryAuthEnc = creds.registry
        ? this.crypto.encrypt(JSON.stringify(creds.registry))
        : null;
    }
    await this.prisma.application.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "app.credentials.update", target: id });
  }

  /** Configure the build: which team registry to push to, whether to push, and an optional
   *  separate build server (which requires a registry — the deploy server pulls the image). */
  async setBuildConfig(
    userId: string,
    id: string,
    cfg: { registryId?: string | null; pushToRegistry?: boolean; buildServerId?: string | null },
  ): Promise<void> {
    const app = await this.requireWrite(userId, id);
    // A registry must belong to the app's own team (no cross-team credential use).
    if (cfg.registryId) {
      const reg = await this.prisma.registry.findUnique({ where: { id: cfg.registryId } });
      if (!reg || reg.teamId !== app.teamId) {
        throw new BadRequestException("registry not found in this team");
      }
    }
    const data: Prisma.ApplicationUncheckedUpdateInput = {};
    if (cfg.registryId !== undefined) data.registryId = cfg.registryId;
    if (cfg.pushToRegistry !== undefined) data.pushToRegistry = cfg.pushToRegistry;
    if (cfg.buildServerId !== undefined) {
      if (cfg.buildServerId) {
        // The build server must be a server of the app's own team (no cross-team image path).
        const bs = await this.prisma.server.findUnique({ where: { id: cfg.buildServerId } });
        if (!bs || bs.teamId !== app.teamId) {
          throw new BadRequestException("build server not found in this team");
        }
        // A build server hands the image to the deploy server via a registry → it's mandatory.
        const effectiveRegistry = cfg.registryId !== undefined ? cfg.registryId : app.registryId;
        if (!effectiveRegistry) {
          throw new BadRequestException("a build server requires a registry to hand the built image to the deploy server");
        }
        data.pushToRegistry = true; // implied — the deploy server can only pull a pushed image
      }
      data.buildServerId = cfg.buildServerId;
    }
    await this.prisma.application.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "app.buildconfig.update", target: id });
  }

  /** Choose the deploy strategy (ROLLING zero-downtime vs RECREATE) and whether a failed
   *  health gate auto-rolls-back to the previous version. */
  async setDeploySettings(
    userId: string,
    id: string,
    cfg: { deployStrategy?: "ROLLING" | "RECREATE"; rollbackOnFailure?: boolean },
  ): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: {
        ...(cfg.deployStrategy !== undefined ? { deployStrategy: cfg.deployStrategy } : {}),
        ...(cfg.rollbackOnFailure !== undefined ? { rollbackOnFailure: cfg.rollbackOnFailure } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "app.deploysettings.update", target: id });
  }

  async setEnvironment(userId: string, id: string, environmentId: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    await this.assertEnvInTeam(environmentId, app.teamId);
    await this.prisma.application.update({ where: { id }, data: { environmentId } });
    await this.audit.log({ actor: userId, action: "app.environment.update", target: id });
  }

  /** Assign, change or clear an app's domain after creation (applied on next deploy). */
  async setDomain(userId: string, id: string, domain: string | null): Promise<void> {
    await this.requireWrite(userId, id);
    // A user-set domain is "custom" and served over HTTPS (Let's Encrypt); clearing
    // it resets the kind. This keeps custom domains on HTTPS under the certType-aware
    // Traefik labels (a bare `{ domain }` update would leave certType at the "http"
    // default and silently drop the app to plain HTTP).
    const data: Prisma.ApplicationUpdateInput = domain
      ? { domain, domainKind: "custom", certType: "le-http", https: true }
      : { domain: null, domainKind: "none" };
    await this.prisma.application.update({ where: { id }, data });
    await this.syncMonitor(id).catch(() => undefined); // keep the auto uptime monitor's target in step
    await this.audit.log({ actor: userId, action: "app.domain.update", target: id });
  }

  /**
   * (Re)expose an existing app: switch it to a magic domain, a raw host:port, a
   * custom domain, or nothing — recomputing the same domain/https/certType fields
   * create() derives, from the app's own server. Applied to Traefik on the next
   * deploy (the returned AppView.url reflects it immediately).
   */
  async expose(
    userId: string,
    id: string,
    input: { mode: "magic" | "port" | "none" | "custom"; domain?: string },
  ): Promise<AppView> {
    const app = await this.requireWrite(userId, id);
    const server = await this.prisma.server.findUnique({ where: { id: app.serverId } });
    if (!server) throw new NotFoundException("server not found");
    const composeWebService = app.source === "COMPOSE" ? (this.composeWeb(app)?.service ?? null) : null;
    const e = this.resolveExpose(
      { name: app.name, domain: input.mode === "custom" ? input.domain : null, exposeMode: input.mode },
      server,
      app.source,
      composeWebService,
    );
    await this.prisma.application.update({
      where: { id },
      data: { domain: e.domain, https: e.https, exposeMode: e.exposeMode, domainKind: e.domainKind, certType: e.certType },
    });
    await this.syncMonitor(id).catch(() => undefined);
    await this.audit.log({ actor: userId, action: "app.expose.update", target: id, meta: { mode: input.mode } });
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    const ctx = await loadProjectCtx(this.prisma, app.environmentId);
    return this.view({ ...app, ...e }, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, ctx, server.publicIp ?? server.publicIpv6 ?? null);
  }

  async setDomainOptions(
    userId: string,
    id: string,
    opts: { domainRedirect?: "www" | "root" | null; securityHeaders?: boolean; forwardAuth?: string | null },
  ): Promise<void> {
    await this.requireWrite(userId, id);
    const data: Prisma.ApplicationUpdateInput = {};
    if (opts.domainRedirect !== undefined) data.domainRedirect = opts.domainRedirect;
    if (opts.securityHeaders !== undefined) data.securityHeaders = opts.securityHeaders;
    if (opts.forwardAuth !== undefined) data.forwardAuth = opts.forwardAuth;
    await this.prisma.application.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "app.domainOptions.update", target: id });
  }

  /** Every app domain across the user's teams + a live SSL status probe. */
  async listDomains(userId: string): Promise<DomainView[]> {
    const apps = (await this.list(userId)).filter((a) => a.domain);
    return Promise.all(
      apps.map(async (a) => ({
        id: a.id,
        appId: a.id,
        appStatus: a.status,
        teamId: a.teamId,
        name: a.name,
        domain: a.domain!,
        https: a.https,
        url: a.url,
        domainRedirect: a.domainRedirect,
        securityHeaders: a.securityHeaders,
        ssl: await probeSsl(a.domain!),
      })),
    );
  }

  /** Ensure an environment exists and belongs to the given team (no cross-team moves). */
  private async assertEnvInTeam(environmentId: string, teamId: string): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { project: true },
    });
    if (!env || env.project.teamId !== teamId) {
      throw new BadRequestException("environment not found in this team");
    }
  }

  // ── helpers ──
  private appVolumes(app: Application): AppVolume[] {
    return Array.isArray(app.volumes) ? (app.volumes as unknown as AppVolume[]) : [];
  }

  private appGitToken(app: Application): string | null {
    if (!app.gitTokenEnc) return null;
    try {
      return this.crypto.decrypt(app.gitTokenEnc);
    } catch {
      return null;
    }
  }

  private appRegistryAuth(app: Application): RegistryAuth | null {
    if (!app.registryAuthEnc) return null;
    try {
      return JSON.parse(this.crypto.decrypt(app.registryAuthEnc)) as RegistryAuth;
    } catch {
      return null;
    }
  }

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

  private appBuildArgs(app: Application): Record<string, string> {
    if (!app.buildArgsEnc) return {};
    try {
      return JSON.parse(this.crypto.decrypt(app.buildArgsEnc)) as Record<string, string>;
    } catch {
      return {};
    }
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

  /**
   * Fill an AppSpec's server-derived cert fields (wildcard root + custom resolver)
   * for a le-dns/custom app — these live on the Server, not the Application row, so
   * both runDeploy AND rollback must set them or the rolled-back container loses its
   * wildcard cert labels. No-op for http/le-http apps.
   */
  private async hydrateCertSpec(app: Application, spec: AppSpec): Promise<void> {
    if (app.certType !== "le-dns" && app.certType !== "custom") return;
    const srv = await this.prisma.server
      .findUnique({ where: { id: app.serverId }, select: { wildcardDomain: true, customCertResolver: true } })
      .catch(() => null);
    spec.wildcardDomain = srv?.wildcardDomain ?? null;
    spec.customCertResolver = srv?.customCertResolver ?? null;
  }

  private toSpec(app: Application): AppSpec {
    // For a COMPOSE app, resolve the primary web service so the Traefik router
    // targets the right service + its real container port (not the meaningless 80
    // default a multi-service stack stores).
    const web = app.source === "COMPOSE" ? this.composeWeb(app) : null;
    return {
      id: app.id,
      source: app.source,
      image: app.image,
      gitUrl: app.gitUrl,
      gitBranch: app.gitBranch,
      buildType: app.buildType,
      dockerfilePath: app.dockerfilePath,
      buildCommand: app.buildCommand,
      outputDir: app.outputDir,
      composeFile: app.composeFile,
      healthCmd: app.healthCmd,
      healthCheckType: app.healthCheckType,
      healthCheckPath: app.healthCheckPath,
      healthCheckPort: app.healthCheckPort,
      memoryMb: app.memoryMb,
      cpus: app.cpus,
      dockerOptions: app.dockerOptions,
      volumes: this.appVolumes(app),
      gitToken: this.appGitToken(app),
      registryAuth: this.appRegistryAuth(app),
      env: this.appEnv(app),
      hostPort: app.hostPort,
      containerPort: web?.port ?? app.containerPort,
      domain: app.domain,
      domainRedirect: (app.domainRedirect as "www" | "root" | null) ?? null,
      securityHeaders: app.securityHeaders,
      forwardAuth: app.forwardAuth,
      certType: app.certType,
      composeWebService: web?.service ?? null,
    };
  }

  private async require(userId: string, id: string): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id } });
    if (!app) throw new NotFoundException("application not found");
    if (!(await this.access.teamRole(userId, app.teamId))) {
      throw new ForbiddenException("not a member of this team");
    }
    // Per-resource scoping: a restricted member must be granted this app (or its project).
    await this.access.requireResourceAccess(userId, app.teamId, {
      resourceId: app.id,
      resolveProjectId: () => loadProjectCtx(this.prisma, app.environmentId).then((c) => c.projectId),
    });
    return app;
  }

  // Deploy-family callers pass "apps:deploy"; config/CRUD callers use the default "apps:config".
  private async requireWrite(
    userId: string,
    id: string,
    permission: TeamPermission = "apps:config",
  ): Promise<Application> {
    const app = await this.prisma.application.findUnique({ where: { id } });
    if (!app) throw new NotFoundException("application not found");
    await this.access.requirePermission(userId, app.teamId, permission);
    return app;
  }

  /** Best reachable IP for one server (IPv4 preferred), or null. Best-effort:
   *  a DB blip just yields null (a domainless app's url falls back to null), never
   *  breaking the view. */
  private async serverIp(serverId: string): Promise<string | null> {
    const s = await this.prisma.server
      .findUnique({ where: { id: serverId }, select: { publicIp: true, publicIpv6: true } })
      .catch(() => null);
    return s?.publicIp ?? s?.publicIpv6 ?? null;
  }

  /** Batched server-IP lookup for list views (no N+1), same best-effort contract. */
  private async serverIpMap(serverIds: string[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(serverIds)];
    if (!ids.length) return new Map();
    const servers = await this.prisma.server
      .findMany({ where: { id: { in: ids } }, select: { id: true, publicIp: true, publicIpv6: true } })
      .catch(() => [] as { id: string; publicIp: string | null; publicIpv6: string | null }[]);
    return new Map(servers.map((s) => [s.id, s.publicIp ?? s.publicIpv6]));
  }

  private view(
    app: Application,
    canWrite: boolean, // apps:config — edit config, see compose
    canDeploy: boolean, // apps:deploy — see/rotate the webhook secret (it triggers a deploy)
    ctx?: ResourceProjectCtx,
    serverIp?: string | null,
  ): AppView {
    return {
      id: app.id,
      name: app.name,
      source: app.source,
      image: app.image,
      gitUrl: app.gitUrl,
      gitBranch: app.gitBranch,
      buildType: app.buildType,
      buildCommand: app.buildCommand,
      outputDir: app.outputDir,
      composeFile: canWrite ? app.composeFile : null,
      healthCmd: app.healthCmd,
      healthCheckType: app.healthCheckType,
      healthCheckPath: app.healthCheckPath,
      healthCheckPort: app.healthCheckPort,
      memoryMb: app.memoryMb,
      cpus: app.cpus,
      deployTimeoutSec: app.deployTimeoutSec,
      dockerOptions: app.dockerOptions,
      volumes: this.appVolumes(app),
      hasGitToken: !!app.gitTokenEnc,
      registryUrl: this.appRegistryAuth(app)?.url ?? null,
      registryUser: this.appRegistryAuth(app)?.user ?? null,
      registryId: app.registryId,
      pushToRegistry: app.pushToRegistry,
      buildServerId: app.buildServerId,
      deployStrategy: app.deployStrategy,
      rollbackOnFailure: app.rollbackOnFailure,
      // Whether this app will ACTUALLY deploy zero-downtime (rolling) — surfaces the fact
      // that a ROLLING preference silently falls back to recreate for non-eligible apps.
      // Mirrors runDeploy's real decision (`!isCompose && rollingEligible`): a compose app
      // deploys via its own up/down, never rolling.
      zeroDowntime: app.source !== "COMPOSE" && this.rollingEligible(app),
      templateSlug: app.templateSlug,
      templateLogo: app.templateSlug ? (TEMPLATES[app.templateSlug]?.logo ?? app.templateSlug) : null,
      environmentId: app.environmentId,
      projectId: ctx?.projectId ?? null,
      projectName: ctx?.projectName ?? null,
      environmentName: ctx?.environmentName ?? null,
      serverId: app.serverId,
      teamId: app.teamId,
      status: app.status,
      hostPort: app.hostPort,
      containerPort: app.containerPort,
      domain: app.domain,
      domainRedirect: app.domainRedirect,
      securityHeaders: app.securityHeaders,
      forwardAuth: app.forwardAuth,
      https: app.https,
      domainKind: app.domainKind,
      exposeMode: app.exposeMode,
      certType: app.certType,
      url: appUrl(app, serverIp ?? null),
      // Webhook credentials are a deploy trigger → only exposed to members who can deploy (NOT to
      // apps:config-only members, who could otherwise self-trigger a deploy via the public webhook).
      webhookToken: canDeploy ? app.webhookToken : null,
      webhookSecret:
        canDeploy && app.webhookSecret ? this.crypto.decrypt(app.webhookSecret) : null,
      isPreview: app.isPreview,
      previewEnabled: app.previewEnabled,
      prNumber: app.prNumber,
      parentAppId: app.parentAppId,
      tags: app.tags,
      volumeBackupEnabled: app.volumeBackupEnabled,
      volumeBackupIntervalHours: app.volumeBackupIntervalHours,
      volumeBackupRetention: app.volumeBackupRetention,
      volumeBackupDestinationId: app.volumeBackupDestinationId,
      envCount: Object.keys(this.appEnv(app)).length,
      canWrite,
      createdAt: app.createdAt,
    };
  }
}
