import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { createHash } from "node:crypto";
import { ModuleRef } from "@nestjs/core";
import { z } from "zod";
import { Application, AppStatus, Deployment, Prisma, Role } from "@prisma/client";
import type { FsEntry, TeamPermission } from "@tugra/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService, type AuditFilters } from "../audit/audit.service";
import { TeamAccessService, canAccessResource } from "../common/team-access.service";
import { ConfigService } from "@nestjs/config";
import { InstanceSettingsService } from "../instance/instance-settings.service";
// Lazy string-token lookup (ModuleRef) avoids a static applications→tunnel cycle.
import type { TunnelService } from "../tunnel/tunnel.service";
import { TUNNEL_SERVICE } from "../tunnel/tunnel.tokens";
import { loadProjectCtx, loadProjectCtxMany, type ResourceProjectCtx } from "../common/resource-project";
import { filterByQuery } from "../common/query-filter";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import { LogStreamService, type LogStreamEvent } from "../agent-gateway/log-stream.service";
import { ContainerMetricsService, type AppContainerMetrics } from "../metrics/container-metrics.service";
import { normalizeSince, normalizeSearch, clampTail } from "../common/log-filters";
import { assertSafeFsPath } from "../common/fs-path";
import { CryptoService } from "../crypto/crypto.service";
import { ProxyService } from "./proxy.service";
import { SwarmDeployService } from "../clusters/swarm-deploy.service";
import { SwarmService } from "../clusters/swarm.service";
import { DnsAutomationService } from "../dns/dns-automation.service";
import type { PlacementConstraint } from "../deploy/deploy-script";
import type { SetPlacementInput } from "./dto";
import { PlacementConstraintSchema } from "./dto";
import { serviceName, parseServiceTasks, parseSwarmTasks, type SwarmTask } from "../deploy/service-script";
import { MonitorsService } from "../monitors/monitors.service";
import { NotificationsService } from "../notifications/notifications.service";
import { GitSourcesService } from "../git-sources/git-sources.service";
import {
  buildImageRemoveScript,
  buildImageRemoveScriptForTag,
  buildRemoveScript,
  buildCustomCertRemoveScript,
  isSshGitUrl,
  gitUrlHost,
  buildRestartScript,
  buildRunScript,
  buildBuildOnlyScript,
  buildRollingDeployScript,
  buildRecreateDeployScript,
  buildPostDeployScript,
  resolveHealthProbe,
  buildStartScript,
  buildStopScript,
  runTag,
  registryImageRef,
  parseImageDigest,
  parseCommit,
  containerName,
  appVolumeName,
  hasNetworkOpt,
  type AppSpec,
  type AppVolume,
  type HostMount,
  type AppConfigMount,
  type RegistryAuth,
} from "../deploy/deploy-script";
import { parseCustomCert, certCoversHost } from "./custom-cert";
import { generateEd25519DeployKey } from "../git-sources/ssh-keygen";
import { assertSafeDockerOptions, validateHostMounts } from "../deploy/docker-options-safety";
import { AppDatabaseLinksService } from "./app-database-links.service";
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
  composeVolumes,
  composeServiceNames,
  parseContainers,
} from "../deploy/compose-script";
import {
  generateWebhookSecret,
  generateWebhookToken,
} from "../webhooks/webhook-verify";
import { type TemplateMeta } from "../templates/catalog";
import { TemplateCatalogService } from "../catalog/template-catalog.service";
import { publicManifest, toManifest, validateConfigMountServiceName, validateConfigMountTarget, validateInstallFields, type FormField, type PublicManifest } from "../templates/template-manifest";
import { resolveVariables } from "../templates/template-resolver";
import { rewriteHostPorts, substituteSelfUrls } from "../templates/install-compose";
import { assertSafeCompose } from "../deploy/compose-safety";
import {
  buildComposeGitRenderScript,
  buildComposeGitUpScript,
  parseRenderedCompose,
  composeGitCloneDir,
} from "../deploy/compose-git";
import { PortAllocatorService } from "./port-allocator.service";
import { probeSsl } from "./ssl-probe";
import { AiService } from "./ai.service";
import { TeamDefaultsService } from "../teams/team-defaults.service";
import { normalizeTags } from "../common/tags";
import { appUrl, primaryHostPort } from "../common/app-url";
import { magicDomain } from "./magic-domain";
import { inferComposeWeb } from "../deploy/compose-web";
import type { CreateAppInput, SetSourceInput, SetBuildInput } from "./dto";

const DEPLOY_TIMEOUT_MS = 300_000; // builds can be slow
// stop/start/restart (non-swarm) run no build but a compose restart of several services with a stop grace
// easily exceeds the 20s default; give it headroom so a slow-but-successful restart isn't killed mid-way.
const LIFECYCLE_TIMEOUT_MS = 120_000;
const DEPLOY_IMAGE_KEEP = 5; // versioned images retained for rollback
// Default rolling health-gate timing (not yet configurable per app).
const ROLLING_GATE = { retries: 20, intervalSec: 3, startPeriodSec: 5 };
// Raw docker flags that make two overlapping containers impossible (port map, own
// network/name/ip, or a shared volume mount) → the app can't roll, so we fall back to hard cutover.
// -v/--volume/--mount: an adopted container carries its named volume this way; two containers writing
// one volume during a rolling overlap would corrupt it, so such apps must hard-cutover.
const RISKY_DOCKER_OPTS = /(^|\s)(--ip6?|-p|--publish|--network|--name|-v|--volume|--mount)(\s|=|$)/;
export const AppViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.enum(["IMAGE", "GIT", "COMPOSE"]),
  image: z.string().nullable(),
  gitUrl: z.string().nullable(),
  gitBranch: z.string().nullable(),
  gitSourceId: z.string().nullable(), // linked GitHub App installation (private-repo token minting), if any
  buildType: z.enum(["NIXPACKS", "DOCKERFILE", "STATIC", "RAILPACK", "HEROKU"]),
  buildCommand: z.string().nullable(),
  dockerfilePath: z.string().nullable(), // DOCKERFILE build: path to the Dockerfile inside the repo
  baseDirectory: z.string().nullable(), // GIT: repo-relative build context/root for monorepos (null = repo root)
  outputDir: z.string().nullable(),
  composeFile: z.string().nullable(),
  composePath: z.string().nullable(), // COMPOSE-from-git: repo-relative path to the compose file (null = pasted compose)
  healthCmd: z.string().nullable(),
  healthCheckType: z.string().nullable(),
  healthCheckPath: z.string().nullable(),
  healthCheckPort: z.number().nullable(),
  memoryMb: z.number().nullable(),
  cpus: z.number().nullable(),
  reserveMemoryMb: z.number().nullable(),
  reserveCpus: z.number().nullable(),
  gpus: z.string().nullable(),
  deployTimeoutSec: z.number().nullable(),
  dockerOptions: z.string().nullable(),
  preDeployCommand: z.string().nullable(), // write-gated in view() (exec-power, may embed internal paths)
  postDeployCommand: z.string().nullable(),
  dbNetwork: z.boolean(), // attached to the node-local managed-DB network (tugra-net) — set by DB links
  volumes: z.array(z.object({ name: z.string(), path: z.string() })),
  hostMounts: z.array(z.object({ hostPath: z.string(), containerPath: z.string(), readOnly: z.boolean().optional() })),
  // Named volumes a COMPOSE app declares (empty for non-compose). Surfaced so the Files tab can show
  // them; `browsable` is false for external / custom-named volumes (not Tugra-owned → not browsable).
  composeVolumes: z.array(
    z.object({
      key: z.string(),
      browsable: z.boolean(),
      mounts: z.array(z.object({ service: z.string(), path: z.string() })),
    }),
  ),
  // Whether this COMPOSE app has any editable config mounts (content fetched on demand, not here).
  hasConfigMounts: z.boolean(),
  hasGitToken: z.boolean(),
  hasGitSshKey: z.boolean(),
  gitSshPublicKey: z.string().nullable(),
  registryUrl: z.string().nullable(),
  registryUser: z.string().nullable(),
  registryId: z.string().nullable(),
  pushToRegistry: z.boolean(),
  buildServerId: z.string().nullable(),
  clusterId: z.string().nullable(),
  replicas: z.number().nullable(),
  placement: z.object({ constraints: z.array(PlacementConstraintSchema), spreadLabelKey: z.string().nullable() }),
  constraintServerId: z.string().nullable(),
  deployStrategy: z.string(),
  rollbackOnFailure: z.boolean(),
  zeroDowntime: z.boolean(),
  templateSlug: z.string().nullable(),
  templateLogo: z.string().nullable(),
  environmentId: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  environmentName: z.string().nullable(),
  serverId: z.string(),
  teamId: z.string(),
  status: z.nativeEnum(AppStatus),
  hostPort: z.number().nullable(),
  containerPort: z.number().nullable(),
  domain: z.string().nullable(),
  extraDomains: z.array(z.string()), // additional alias hostnames routed to the same container
  domainRedirect: z.string().nullable(),
  securityHeaders: z.boolean(),
  forwardAuth: z.string().nullable(),
  https: z.boolean(),
  domainKind: z.string(),
  exposeMode: z.string(),
  tunnelExposed: z.boolean(),
  certType: z.string(),
  // Operator-uploaded custom cert (certType "custom"): the domains it covers + its expiry, for display.
  // `hasCustomCert` says a cert is stored; the PEM/key bytes are NEVER carried in this view.
  certDomains: z.array(z.string()),
  certNotAfter: z.date().nullable(),
  hasCustomCert: z.boolean(),
  url: z.string().nullable(),
  webhookToken: z.string().nullable(),
  webhookSecret: z.string().nullable(),
  isPreview: z.boolean(),
  previewEnabled: z.boolean(),
  prNumber: z.number().nullable(),
  parentAppId: z.string().nullable(),
  tags: z.array(z.string()),
  volumeBackupEnabled: z.boolean(),
  volumeBackupIntervalHours: z.number().nullable(),
  volumeBackupRetention: z.number(),
  volumeBackupDestinationId: z.string().nullable(),
  envCount: z.number(),
  canWrite: z.boolean(),
  // Set when the app has a user-uploaded custom icon; also cache-busts the GET /apps/:id/icon URL. Null
  // means "no custom icon" (fall back to the template/source logo). Bytes are never carried in this view.
  iconUpdatedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type AppView = z.infer<typeof AppViewSchema>;

export const DomainViewSchema = z.object({
  id: z.string(),
  appId: z.string(),
  appStatus: z.nativeEnum(AppStatus),
  teamId: z.string(),
  name: z.string(),
  domain: z.string(),
  https: z.boolean(),
  url: z.string().nullable(),
  domainRedirect: z.string().nullable(),
  securityHeaders: z.boolean(),
  ssl: z.object({
    state: z.enum(["ok", "expiring", "error"]),
    daysRemaining: z.number().nullable(),
    validTo: z.string().nullable(),
    issuer: z.string().nullable(),
  }),
});
export type DomainView = z.infer<typeof DomainViewSchema>;

// Clone result: the new app + machine-readable warning keys the UI localizes (domain_reset, etc.).
export const CloneAppResultSchema = z.object({
  app: AppViewSchema,
  warnings: z.array(z.string()),
});
export type CloneAppResult = z.infer<typeof CloneAppResultSchema>;

// Result of generating an SSH deploy key — the PUBLIC key + fingerprint only (the private key never leaves).
export const GitSshKeyResultSchema = z.object({
  publicKey: z.string(),
  fingerprint: z.string(),
});

/** Capture the user's non-secret install choices (timezone, username, ...) for the record, but never
 *  persist a secret field's value — installConfig is bookkeeping, not a secret store (SPEC §8). */
function redactInstallConfig(
  fields: Record<string, string> | undefined,
  defs: FormField[] | undefined,
): Record<string, string> | null {
  if (!fields) return null;
  const secretKeys = new Set((defs ?? []).filter((f) => f.secret).map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!secretKeys.has(k)) out[k] = v; // secret field values are dropped, not stored
  }
  return Object.keys(out).length > 0 ? out : null;
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
    private readonly containerMetricsSvc: ContainerMetricsService,
    private readonly portAlloc: PortAllocatorService,
    private readonly catalog: TemplateCatalogService,
    private readonly swarmDeploy: SwarmDeployService,
    private readonly swarm: SwarmService,
    private readonly dns: DnsAutomationService,
    private readonly dbLinks: AppDatabaseLinksService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Rebuild the app's server tunnel ingress from DB truth (lazy token avoids a static tunnel cycle).
   *  Best-effort — a Cloudflare hiccup must not fail the domain/expose mutation that triggered it. */
  private async syncTunnelIngress(serverId: string): Promise<void> {
    await this.moduleRef
      .get<TunnelService>(TUNNEL_SERVICE, { strict: false })
      .syncIngress(serverId)
      .catch(() => undefined);
  }

  /**
   * Reject routing an app to the control panel's OWN domain. When panel TLS is configured the bundled
   * Traefik serves the panel via a file-provider router on that host; an app's label router on the same
   * host would fight it and could take the host over — locking the owner out of their own control plane.
   * No configured panel domain (bring-your-own-proxy) => nothing is reserved, so this is a no-op. Resolved
   * lazily via ModuleRef to avoid widening the constructor (and its one direct test construction). The
   * settings/env read is best-effort: a lookup failure must not block a legitimate domain change.
   */
  private async assertDomainNotReserved(domain: string | null | undefined): Promise<void> {
    if (!domain) return;
    // Fail-OPEN: any resolution hiccup (a partial test module, a missing provider) must not block a
    // legitimate domain change — it just means "nothing reserved". Only a genuine collision throws.
    let panelDomain: string | null = null;
    try {
      const config = this.moduleRef.get(ConfigService, { strict: false });
      panelDomain = await this.moduleRef
        .get(InstanceSettingsService, { strict: false })
        .panelDomainFor(config.get<string>("PANEL_DOMAIN"), config.get<string>("PANEL_TLS"));
    } catch {
      panelDomain = null;
    }
    const norm = (h: string) => h.trim().replace(/\.+$/, "").toLowerCase();
    if (panelDomain && norm(domain) === norm(panelDomain)) {
      throw new BadRequestException(
        "That hostname is your control panel's domain — routing an app to it would take over the panel. Use a different hostname.",
      );
    }
  }

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
    const override = app.templateSlug ? this.catalog.get(app.templateSlug)?.web : undefined;
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
      proxyBind: string;
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
    // A tunnel-only proxy (bind:"none") publishes no host port, so a magic domain built from the
    // box IP (sslip) would resolve to an unbound address — a dead link. Skip auto-magic ONLY when such a server
    // has no wildcard: with a wildcard (a tunnel gives the server one), magicDomain yields <label>.<wildcard>,
    // which the Cloudflare tunnel routes — so those apps still get a working, tunnel-reachable domain.
    const tunnelOnlyNoWildcard = server.proxyBind === "none" && !server.wildcardDomain;
    if (exposeMode === "magic" && !tunnelOnlyNoWildcard && (source !== "COMPOSE" || !!composeWebService)) {
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
        select: { publicIp: true, publicIpv6: true, wildcardDomain: true, magicSuffix: true, proxyBind: true },
      })
      .catch(() => null);
    if (!server) return;
    const apps = await this.prisma.application
      .findMany({ where: { serverId, domainKind: "magic", isPreview: false } })
      .catch(() => [] as Application[]);
    const suffix = server.magicSuffix ?? process.env.MAGIC_DOMAIN_SUFFIX ?? "sslip.io";
    // A server switched to tunnel-only with no wildcard can no longer serve a box-IP magic (sslip) domain —
    // those existing magic apps would keep a dead URL. Clear them to domainless (the operator tunnel-exposes
    // them to get a real hostname). Matches the resolveExpose guard for new apps.
    const dropMagic = server.proxyBind === "none" && !server.wildcardDomain;
    for (const app of apps) {
      if (dropMagic) {
        if (app.domain) {
          await this.prisma.application.update({ where: { id: app.id }, data: { domain: null, domainKind: "none" } }).catch(() => undefined);
          await this.syncMonitor(app.id).catch(() => undefined);
        }
        continue;
      }
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
        const data: Prisma.ApplicationUpdateInput = { domain: next };
        // The old domain is baked into the app's compose + mount self-URLs (real-url-substitution);
        // rewrite them to the new domain so the container's own links stay correct after an IP change.
        if (app.domain) {
          if (app.composeFile?.includes(app.domain)) {
            data.composeFile = app.composeFile.split(app.domain).join(next);
          }
          if (Array.isArray(app.configMounts)) {
            const mounts = app.configMounts as { content?: unknown }[];
            if (mounts.some((m) => typeof m.content === "string" && m.content.includes(app.domain!))) {
              data.configMounts = mounts.map((m) =>
                typeof m.content === "string" ? { ...m, content: m.content.split(app.domain!).join(next) } : m,
              ) as unknown as Prisma.InputJsonValue;
            }
          }
        }
        await this.prisma.application.update({ where: { id: app.id }, data }).catch(() => undefined);
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
    await this.assertDomainNotReserved(dto.domain); // never let a new app claim the panel's own hostname
    if (dto.environmentId) await this.assertEnvInTeam(dto.environmentId, server.teamId);
    // Never orphan: fall back to the team's default environment when none is chosen.
    const environmentId =
      dto.environmentId ?? (await this.teamDefaults.resolveDefaultEnvironmentId(server.teamId));
    if (dto.gitSourceId) {
      const gs = await this.prisma.gitSource.findUnique({ where: { id: dto.gitSourceId } });
      if (!gs || gs.teamId !== server.teamId) throw new BadRequestException("git source not found in this team");
    }

    const source = dto.source ?? "IMAGE";
    // COMPOSE is either pasted (composeFile) or sourced from git (gitUrl + composePath) — the DTO guarantees
    // exactly one. A git-compose stack has no stored YAML to validate here; it is cloned, rendered and
    // validated (assertSafeCompose over the rendered config) at deploy time instead.
    const isGitCompose = source === "COMPOSE" && !!dto.gitUrl;
    // A user-pasted compose at create was never validated (only setComposeFile + the importer ran the guard),
    // so a privileged/host-escaping stack could be installed. Validate it here too; curated templates are
    // trusted (they install through a different, server-controlled path) so they skip this.
    if (source === "COMPOSE" && dto.composeFile && !dto.templateSlug) assertSafeCompose(dto.composeFile);
    const composeWebService =
      source === "COMPOSE" ? (this.composeWeb({ templateSlug: dto.templateSlug, composeFile: dto.composeFile })?.service ?? null) : null;
    const expose = this.resolveExpose(dto, server, source, composeWebService);

    // An ssh:// / git@ repo (GIT build OR git-compose) needs a deploy key the user adds to the repo first —
    // generate it now and skip the first deploy (a clone would fail until the public key is added).
    const sshAuto = (source === "GIT" || isGitCompose) && isSshGitUrl(dto.gitUrl ?? "");
    const sshKey = sshAuto ? generateEd25519DeployKey() : null;

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
        baseDirectory: source === "GIT" ? dto.baseDirectory ?? null : null, // monorepo root; GIT-only
        buildCommand: dto.buildCommand ?? null,
        outputDir: dto.outputDir ?? null,
        composeFile: dto.composeFile ?? null,
        composePath: isGitCompose ? dto.composePath ?? "docker-compose.yml" : null,
        serverId: dto.serverId,
        teamId: server.teamId,
        env: {} as Prisma.InputJsonValue,
        envEnc: this.crypto.encrypt(JSON.stringify(dto.env ?? {})),
        gitTokenEnc: dto.gitToken ? this.crypto.encrypt(dto.gitToken) : null,
        gitSshKeyEnc: sshKey ? this.crypto.encrypt(sshKey.privateKeyOpenSsh) : null,
        gitSshPublicKey: sshKey?.publicKey ?? null,
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
    // Skip the first deploy for an auto-keyed ssh repo — the user must add the public key to the repo first.
    return this.finishCreate(app, userId, server.teamId, dto.deploy && !sshAuto, server.publicIp ?? server.publicIpv6);
  }

  /** Shared post-insert tail for both create() and createFromTemplate(): grant-on-create access,
   *  audit, uptime monitor, best-effort first deploy, and the AppView projection. Kept out of any
   *  enclosing transaction — a fire-and-forget deploy or monitor must never run inside the tx. */
  private async finishCreate(
    app: Application,
    userId: string,
    teamId: string,
    deploy: boolean | undefined,
    serverIp: string | null | undefined,
  ): Promise<AppView> {
    // Grant-on-create: the creator keeps access to what they made even if later restricted.
    await this.access.grantResourceAccess(userId, teamId, app.id);
    await this.audit.log({ actor: userId, action: "app.create", target: app.id });
    // Auto-track uptime for a domained app (best-effort; never blocks creation).
    await this.monitors.createForApp(app).catch(() => undefined);
    if (deploy) {
      // Best-effort: kick off the first deploy so a one-click install actually runs. Fire-and-forget
      // — the build can take minutes, and a missing/offline agent must not fail creation. RBAC is
      // already enforced by requirePermission("apps:config") at the create site.
      void this.submitDeploy(app, userId).catch(() => undefined);
    }
    const perms = await this.access.membershipPermissions(userId, teamId);
    return this.view(app, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, undefined, serverIp);
  }

  /** Name for a cloned app: the override (capped), else the source name + " (copy)" (not chained). */
  private cloneName(src: string, override?: string): string {
    if (override && override.trim()) return override.trim().slice(0, 100);
    return `${src.replace(/ \(copy\)$/, "").trim()} (copy)`.slice(0, 100);
  }

  /**
   * Clone an app into a new one on the SAME server + environment: an allow-listed copy of its config (never
   * a spread — a future column must be copied deliberately), with the domain, custom cert, webhook and host
   * ports NOT carried over, secrets copied as encrypted blobs (same key), scheduled tasks copied DISABLED,
   * the custom icon copied, and status left NEW (the user deploys it). Returns the view + machine-readable
   * warning keys the UI localizes. Cross-server / env moves, volume-data copy and port re-allocation are
   * deliberate follow-ups.
   */
  async clone(userId: string, id: string, input: { name?: string }): Promise<{ app: AppView; warnings: string[] }> {
    const src = await this.require(userId, id);
    if (src.isPreview) throw new BadRequestException("a preview app can't be cloned");
    await this.access.requirePermission(userId, src.teamId, "apps:config");
    const server = await this.prisma.server.findUnique({ where: { id: src.serverId } });
    if (!server) throw new NotFoundException("server not found");

    const warnings: string[] = [];
    const name = this.cloneName(src.name, input.name);
    const composeWebService = src.source === "COMPOSE" ? (this.composeWeb(src)?.service ?? null) : null;
    // Fresh exposure — the domain is NEVER copied (two apps on one host = a Traefik router clash); a custom
    // domain clones to none, magic clones to a new magic domain on this server.
    const expose = this.resolveExpose({ name, exposeMode: src.exposeMode === "custom" ? "none" : src.exposeMode }, server, src.source, composeWebService);

    if (src.domainKind === "custom") warnings.push("domain_reset");
    if (src.certPem) warnings.push("custom_cert_dropped");
    if (src.hostPort != null) warnings.push("host_port_reset");
    if (Array.isArray(src.portMappings) && src.portMappings.length > 0) warnings.push("port_mappings_copied");

    const icon = await this.prisma.appIcon.findUnique({ where: { appId: src.id } });
    const jsonOrNull = (v: unknown) => (v == null ? Prisma.JsonNull : (v as Prisma.InputJsonValue));

    const created = await this.prisma.$transaction(async (tx) => {
      const app = await tx.application.create({
        data: {
          name,
          teamId: src.teamId,
          serverId: src.serverId,
          environmentId: src.environmentId,
          buildServerId: src.buildServerId,
          // Same server → keep the stateful swarm pin; a cross-server clone (follow-up) would reset these.
          clusterId: src.clusterId,
          replicas: src.replicas,
          placement: jsonOrNull(src.placement),
          constraintServerId: src.constraintServerId,
          templateSlug: src.templateSlug,
          source: src.source,
          image: src.image,
          gitUrl: src.gitUrl,
          gitBranch: src.gitBranch,
          gitSourceId: src.gitSourceId,
          buildType: src.buildType,
          dockerfilePath: src.dockerfilePath,
          baseDirectory: src.baseDirectory,
          buildCommand: src.buildCommand,
          outputDir: src.outputDir,
          composeFile: src.composeFile,
          composePath: src.composePath, // keep a cloned git-compose app git-sourced
          healthCmd: src.healthCmd,
          healthCheckType: src.healthCheckType,
          healthCheckPath: src.healthCheckPath,
          healthCheckPort: src.healthCheckPort,
          memoryMb: src.memoryMb,
          cpus: src.cpus,
          reserveMemoryMb: src.reserveMemoryMb,
          reserveCpus: src.reserveCpus,
          gpus: src.gpus,
          deployTimeoutSec: src.deployTimeoutSec,
          preDeployCommand: src.preDeployCommand,
          postDeployCommand: src.postDeployCommand,
          // Volume DEFINITIONS copy, but the docker volume name derives from the new app id → fresh empty
          // volumes, no data shared (structural). Data copy is a follow-up.
          volumes: jsonOrNull(src.volumes),
          hostMounts: jsonOrNull(src.hostMounts),
          portMappings: jsonOrNull(src.portMappings),
          installConfig: jsonOrNull(src.installConfig),
          configMounts: jsonOrNull(src.configMounts),
          // Encrypted blobs copy verbatim (one global key, no per-app binding) — same as the preview path.
          gitTokenEnc: src.gitTokenEnc,
          gitSshKeyEnc: src.gitSshKeyEnc, // same repo → the same deploy key clones it
          gitSshPublicKey: src.gitSshPublicKey,
          registryId: src.registryId,
          registryAuthEnc: src.registryAuthEnc,
          pushToRegistry: src.pushToRegistry,
          env: {} as Prisma.InputJsonValue,
          envEnc: src.envEnc,
          buildArgsEnc: src.buildArgsEnc,
          dockerOptions: src.dockerOptions,
          dbNetwork: src.dbNetwork,
          // A copied host port would clash on the same server; cleared (re-allocation is a follow-up).
          hostPort: null,
          containerPort: src.containerPort,
          domain: expose.domain,
          https: expose.https,
          exposeMode: expose.exposeMode,
          domainKind: expose.domainKind,
          certType: expose.certType,
          domainRedirect: src.domainRedirect,
          securityHeaders: src.securityHeaders,
          forwardAuth: src.forwardAuth,
          deployStrategy: src.deployStrategy,
          rollbackOnFailure: src.rollbackOnFailure,
          tags: src.tags,
          iconUpdatedAt: icon ? new Date() : null,
          // A fresh webhook (the token is unique; sharing it would double-trigger + collide on the unique index).
          webhookToken: generateWebhookToken(),
          webhookSecret: this.crypto.encrypt(generateWebhookSecret()),
          volumeBackupIntervalHours: src.volumeBackupIntervalHours,
          volumeBackupRetention: src.volumeBackupRetention,
          volumeBackupDestinationId: src.volumeBackupDestinationId,
          // Defaults left as-is: status NEW (not deployed), isPreview/previewEnabled false, cert* null,
          // tunnelExposed false, volumeBackupEnabled false.
        },
      });
      if (icon) {
        await tx.appIcon.create({ data: { appId: app.id, mime: icon.mime, data: icon.data, sizeBytes: icon.sizeBytes } });
      }
      const tasks = await tx.scheduledTask.findMany({ where: { appId: src.id } });
      if (tasks.length > 0) {
        // Copied DISABLED, so the clone never double-runs the source's crons until the user enables them.
        await tx.scheduledTask.createMany({
          data: tasks.map((t) => ({ appId: app.id, name: t.name, schedule: t.schedule, command: t.command, enabled: false })),
        });
        warnings.push("tasks_disabled");
      }
      return app;
    });

    await this.access.grantResourceAccess(userId, src.teamId, created.id);
    await this.monitors.createForApp(created).catch(() => undefined);
    await this.audit.log({ actor: userId, action: "app.clone", target: created.id, meta: { sourceId: src.id } });
    const perms = await this.access.membershipPermissions(userId, src.teamId);
    const app = this.view(created, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, undefined, server.publicIp ?? server.publicIpv6);
    return { app, warnings };
  }

  /** Generate (or rotate) an ed25519 SSH deploy key for an ssh:// / git@ repo. Returns only the PUBLIC key
   *  + fingerprint — the private key is encrypted at rest and never leaves the server. The operator adds the
   *  public key to the repo as a read-only deploy key, then deploys. */
  async generateGitSshKey(userId: string, id: string): Promise<{ publicKey: string; fingerprint: string }> {
    const app = await this.requireWrite(userId, id);
    if (app.source !== "GIT" || !isSshGitUrl(app.gitUrl ?? "")) {
      throw new BadRequestException("a deploy key applies to a Git app with an ssh:// or git@ repository URL");
    }
    const key = generateEd25519DeployKey();
    await this.prisma.application.update({
      where: { id },
      data: { gitSshKeyEnc: this.crypto.encrypt(key.privateKeyOpenSsh), gitSshPublicKey: key.publicKey },
    });
    await this.audit.log({ actor: userId, action: "app.git_ssh_key.generate", target: id });
    return { publicKey: key.publicKey, fingerprint: key.fingerprint };
  }

  async removeGitSshKey(userId: string, id: string): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({ where: { id }, data: { gitSshKeyEnc: null, gitSshPublicKey: null } });
    await this.audit.log({ actor: userId, action: "app.git_ssh_key.remove", target: id });
  }

  /** One-click template catalog (gallery metadata only). */
  listTemplates(): TemplateMeta[] {
    return this.catalog.metaList();
  }

  /**
   * Instantiate a curated template as a COMPOSE app, RESOLVED at install time: fresh host ports are
   * allocated and the baked compose is rewritten to them (so installing the same template twice never
   * collides on a host port), env is resolved from the manifest (typed fields + variables + user
   * overrides), and portMappings/installConfig are persisted. The port allocation + the app insert run
   * in ONE transaction (the allocator's advisory lock is held until commit) so two concurrent installs
   * serialize and get distinct ports.
   */
  async createFromTemplate(
    userId: string,
    slug: string,
    input: {
      name: string;
      serverId: string;
      environmentId?: string;
      deploy?: boolean;
      fields?: Record<string, string>;
      composeOverride?: string;
      envOverride?: Record<string, string>;
    },
  ): Promise<AppView> {
    const tpl = this.catalog.get(slug);
    if (!tpl) throw new NotFoundException("template not found");
    const server = await this.prisma.server.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
    if (input.environmentId) await this.assertEnvInTeam(input.environmentId, server.teamId);
    const environmentId =
      input.environmentId ?? (await this.teamDefaults.resolveDefaultEnvironmentId(server.teamId));

    const manifest = toManifest(tpl);
    const exposures = manifest.exposure ?? [];
    const mounts = manifest.mounts ?? [];
    const magicSuffix = server.magicSuffix ?? process.env.MAGIC_DOMAIN_SUFFIX ?? "sslip.io";

    // Validate user field values against the typed field defs (regex/min/max/required).
    validateInstallFields(input.fields, manifest.fields);
    // Validate each config mount before it becomes a host bind in the (assertSafeCompose-bypassed)
    // Tugra override: the serviceName is a raw YAML key and the target is the bind's container path.
    for (const m of mounts) {
      validateConfigMountServiceName(m.serviceName);
      validateConfigMountTarget(m.target);
    }
    // A fork-free compose override is user-authored → reject any host-escaping directive before it is
    // ever written to a host and run (privileged / docker.sock / host binds / dangerous caps / …).
    if (input.composeOverride) assertSafeCompose(input.composeOverride);
    const baseCompose = input.composeOverride ?? manifest.composeFile;

    // Probe listening host ports OUTSIDE the transaction — it is an agent network round-trip and must
    // not run inside the DB transaction (would hold the connection idle-in-tx and risk the tx timeout).
    const probed = exposures.length ? await this.portAlloc.probeUsedPorts(server.id) : new Set<number>();

    const app = await this.prisma.$transaction(async (tx) => {
      // Allocate inside the tx (fast DB-only ops): the advisory lock is held until this transaction
      // commits, so a concurrent install cannot pick the same port between our allocation and our insert.
      const allocated = exposures.length ? await this.portAlloc.allocate(server.id, exposures.length, tx, probed) : [];
      // Rewrite ports on whichever compose we install (override or template). When the override's
      // ports don't match the exposure metadata, rewriteHostPorts is a no-op — the user owns them.
      const { compose, portMappings, mounts: rewrittenMounts } = rewriteHostPorts(baseCompose, exposures, allocated, mounts);
      const allocatedPorts = Object.fromEntries(
        exposures.map((e, i) => [`${e.serviceName}:${e.containerPort}`, allocated[i]]),
      );
      const resolved = resolveVariables(manifest, {
        appName: input.name,
        publicIp: server.publicIp,
        publicIpv6: server.publicIpv6,
        wildcardDomain: server.wildcardDomain,
        magicSuffix,
        allocatedPorts,
        userFields: input.fields,
      });
      // envOverride layers last (user wins), mirroring the deploy-time shared-vars < app-env order.
      const env = { ...resolved, ...(input.envOverride ?? {}) };
      const installConfig = redactInstallConfig(input.fields, manifest.fields);
      const web = this.composeWeb({ templateSlug: slug, composeFile: compose });
      const composeWebService = web?.service ?? null;
      const expose = this.resolveExpose({ name: input.name }, server, "COMPOSE", composeWebService);
      // Swap the importer's baked `localhost` self-URLs for the app's real magic domain / server IP
      // (the container reads these as its own base/redirect URLs). Pure/sync — safe inside the tx.
      const { compose: finalCompose, mounts: finalMounts } = substituteSelfUrls(
        compose,
        portMappings,
        { domain: expose.domain, https: expose.https, serverIp: server.publicIp ?? server.publicIpv6 ?? null, web },
        rewrittenMounts,
      );
      return tx.application.create({
        data: {
          name: input.name,
          templateSlug: slug,
          environmentId,
          source: "COMPOSE",
          composeFile: finalCompose,
          serverId: server.id,
          teamId: server.teamId,
          env: {} as Prisma.InputJsonValue,
          envEnc: this.crypto.encrypt(JSON.stringify(env)),
          hostPort: null,
          containerPort: 80,
          domain: expose.domain,
          https: expose.https,
          exposeMode: expose.exposeMode,
          domainKind: expose.domainKind,
          certType: expose.certType,
          tags: [],
          webhookToken: generateWebhookToken(),
          webhookSecret: this.crypto.encrypt(generateWebhookSecret()),
          portMappings: portMappings as unknown as Prisma.InputJsonValue,
          installConfig: (installConfig as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          // Persist config-mount bodies with ${KEY} placeholders intact (secrets resolve at deploy);
          // their baked localhost self-URLs are swapped for the real address too.
          configMounts: finalMounts?.length
            ? (finalMounts as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
        },
      });
    });

    if (input.composeOverride || input.envOverride) {
      // Audit a fork-free override — record THAT one happened + which env keys, never their values.
      await this.audit.log({
        actor: userId,
        action: "app.template.override",
        target: app.id,
        meta: { slug, composeOverride: !!input.composeOverride, envKeys: Object.keys(input.envOverride ?? {}) },
      });
    }
    return this.finishCreate(app, userId, server.teamId, input.deploy, server.publicIp ?? server.publicIpv6);
  }

  /**
   * The install-form manifest for a template: typed field DEFINITIONS + exposure + mount META, never
   * resolved secret values (they don't exist until install). The raw composeFile is returned only when
   * `serverId` is given and the caller can write to that server's team (advanced compose edit).
   */
  async getTemplateManifest(userId: string, slug: string, serverId?: string): Promise<PublicManifest> {
    const tpl = this.catalog.get(slug);
    if (!tpl) throw new NotFoundException("template not found");
    let canWrite = false;
    if (serverId) {
      const server = await this.prisma.server.findUnique({ where: { id: serverId }, select: { teamId: true } });
      if (server) canWrite = (await this.access.membershipPermissions(userId, server.teamId))?.has("apps:config") ?? false;
    }
    return publicManifest(toManifest(tpl), canWrite);
  }

  async list(userId: string, q?: string): Promise<AppView[]> {
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
    const views = apps
      .filter((a) => canAccessResource(access.get(a.teamId), a.id, ctxByEnv.get(a.environmentId)?.projectId ?? null))
      .map((a) =>
        this.view(a, perms.get(a.teamId)?.has("apps:config") ?? false, perms.get(a.teamId)?.has("apps:deploy") ?? false, ctxByEnv.get(a.environmentId), ipByServer.get(a.serverId) ?? null),
      );
    // `?q`: in-memory substring filter over non-secret fields of the already-authorized views.
    return filterByQuery(views, q, (a) => [a.name, a.domain, a.image, a.gitUrl, a.templateSlug]);
  }

  async get(userId: string, id: string): Promise<AppView> {
    const app = await this.require(userId, id);
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    const ctx = await loadProjectCtx(this.prisma, app.environmentId);
    return this.view(app, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, ctx, await this.serverIp(app.serverId));
  }

  async deploy(userId: string, id: string, opts?: { noCache?: boolean }) {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    // No 409 on a busy app any more: submitDeploy queues it and runs it when the current deploy finishes.
    return this.submitDeploy(app, userId, opts?.noCache ?? false);
  }

  /** One RUNNING deploy per app at a time (keeps the live-log stream unambiguous). Still used by rollback and
   *  the config-edit guards; the deploy queue enforces the same invariant via claimNext + the partial index. */
  private async ensureNoActiveDeploy(appId: string): Promise<void> {
    const running = await this.prisma.deployment.findFirst({
      where: { appId, status: "RUNNING" },
    });
    if (running) throw new ConflictException("a deployment is already running");
  }

  /** Create the RUNNING row for a rollback. Rollback doesn't go through the deploy queue, so it relies on the
   *  one-running-per-app partial unique index as the backstop — map its violation (a deploy claimed RUNNING
   *  in the race after ensureNoActiveDeploy) to a clean 409 instead of a raw Prisma error. */
  private async createRollbackDeployment(appId: string): Promise<Deployment> {
    try {
      return await this.prisma.deployment.create({
        data: { appId, status: "RUNNING", kind: "ROLLBACK", trigger: "rollback", startedAt: new Date() },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("a deployment is already running");
      }
      throw e;
    }
  }

  /**
   * Deploy triggered by a verified git webhook — no interactive user, so the
   * role check is skipped (the webhook secret is the authorization). Fire this
   * without awaiting; builds can take minutes.
   */
  async deployFromWebhook(appId: string) {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    // Queued if a deploy is already running (a push during a deploy no longer starts a second concurrent run).
    return this.submitDeploy(app, "webhook");
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
          gitSourceId: parent.gitSourceId, // keep the GitHub-App link so a private-repo preview can mint a clone token
          gitBranch: headRef,
          buildType: parent.buildType,
          dockerfilePath: parent.dockerfilePath,
          baseDirectory: parent.baseDirectory, // a monorepo preview must build the same subdirectory as its parent
          buildCommand: parent.buildCommand,
          outputDir: parent.outputDir,
          composeFile: parent.composeFile,
          healthCmd: parent.healthCmd,
          healthCheckType: parent.healthCheckType,
          healthCheckPath: parent.healthCheckPath,
          healthCheckPort: parent.healthCheckPort,
          memoryMb: parent.memoryMb,
          cpus: parent.cpus,
          reserveMemoryMb: parent.reserveMemoryMb,
          reserveCpus: parent.reserveCpus,
          gpus: parent.gpus,
          volumes: (parent.volumes ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          gitTokenEnc: parent.gitTokenEnc,
          gitSshKeyEnc: parent.gitSshKeyEnc, // preview clones the same repo → reuse the parent's deploy key
          gitSshPublicKey: parent.gitSshPublicKey,
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
          // A preview gets its own subdomain and never inherits the parent's uploaded cert bytes, so a
          // "custom"-cert parent downgrades to le-http (ACME for the preview host) instead of a dead
          // "custom" with no cert.
          certType: parent.certType === "custom" ? "le-http" : parent.certType,
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
    return this.submitDeploy(preview, "webhook:pr");
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
   * raw docker flags, no named volumes (two overlapping containers would share the
   * same volume and could corrupt data), and no GPU (the overlapping rollout would
   * contend for the same device/VRAM and fail health, forcing a false rollback).
   * Otherwise deploy is a hard cutover.
   */
  private rollingEligible(app: Application): boolean {
    return (
      !!app.domain &&
      app.deployStrategy === "ROLLING" &&
      app.rollbackOnFailure &&
      !app.hostPort &&
      !(app.dockerOptions && RISKY_DOCKER_OPTS.test(app.dockerOptions)) &&
      !app.gpus &&
      this.appVolumes(app).length === 0
    );
  }

  /** Wall-clock metadata stamped onto every terminal deploy/rollback update: ms from when the run actually
   *  STARTED (startedAt — QUEUED->RUNNING) to now, clamped ≥ 0 so queue wait time is not counted as build
   *  time. Falls back to createdAt for rollback rows (which never queue) and legacy rows. */
  private finishStamp(dep: { createdAt?: Date | string | null; startedAt?: Date | string | null }): { durationMs: number } {
    const from = dep.startedAt ?? dep.createdAt;
    const started = from ? new Date(from).getTime() : NaN;
    return { durationMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0 };
  }

  /** Origin of a deploy, derived from runDeploy's actor (userId | "webhook" | "webhook:pr"). Distinct
   *  from Deployment.kind, which is the OUTCOME (DEPLOY / ROLLBACK / AUTO_ROLLBACK). */
  private triggerOf(actor: string): string {
    return actor === "webhook:pr" ? "preview" : actor === "webhook" ? "webhook" : "manual";
  }

  /**
   * Enqueue a deploy and, if the app is idle, run it inline. One RUNNING deploy per app: a submit for a busy
   * app returns a QUEUED row at once (HTTP 200) instead of the old 409, and the queue drains FIFO as each
   * deploy finishes. A webhook submit supersedes older still-QUEUED webhook deploys for the same app (a newer
   * push wins; manual/preview rows are kept). Returns the row to report: the finished row if it ran inline,
   * else the QUEUED row.
   */
  private async submitDeploy(app: Application, actor: string, noCache = false) {
    const QUEUE_CAP = 10; // max QUEUED deploys per app (Coolify caps per server at 25)
    const trigger = this.triggerOf(actor);
    if ((await this.prisma.deployment.count({ where: { appId: app.id, status: "QUEUED" } })) >= QUEUE_CAP) {
      throw new ConflictException("deploy queue is full — wait for queued deploys to run");
    }
    const dep = await this.prisma.deployment.create({
      data: { appId: app.id, status: "QUEUED", trigger, requestedBy: actor, noCache },
    });
    if (trigger === "webhook") {
      await this.prisma.deployment.updateMany({
        where: { appId: app.id, status: "QUEUED", trigger: "webhook", id: { not: dep.id } },
        data: { status: "CANCELLED", exitCode: -1, logs: "Superseded by a newer push" },
      });
    }
    const claimed = await this.claimNext(app.id);
    // We own the claim only if OUR row was promoted to RUNNING — run it inline + await so the idle-path
    // contract (caller gets the finished deployment) holds. The app we were handed is freshly fetched, so
    // pass it straight through. Otherwise our row stays QUEUED and drains later (with a reloaded app).
    if (claimed?.id === dep.id) return this.executeDeploy(claimed, app, actor, noCache);
    return this.prisma.deployment.findUnique({ where: { id: dep.id } });
  }

  /**
   * Atomically promote the oldest QUEUED deploy for an app to RUNNING, unless one is already RUNNING. A row
   * lock on the Application (SELECT ... FOR UPDATE) serializes concurrent submits/drains so only one can claim.
   * The CAS (updateMany WHERE status=QUEUED) also loses safely to a racing cancel — it just tries the next row.
   * Returns the newly-RUNNING row, or null when a deploy is already running or the queue is empty.
   */
  private async claimNext(appId: string): Promise<Deployment | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Application" WHERE id = ${appId} FOR UPDATE`;
      if (await tx.deployment.count({ where: { appId, status: "RUNNING" } })) return null;
      const tried: string[] = []; // rows whose CAS lost to a cancel — skip them so the loop always terminates
      for (;;) {
        const next = await tx.deployment.findFirst({
          where: { appId, status: "QUEUED", id: { notIn: tried } },
          orderBy: { createdAt: "asc" },
        });
        if (!next) return null;
        const { count } = await tx.deployment.updateMany({
          where: { id: next.id, status: "QUEUED" },
          data: { status: "RUNNING", startedAt: new Date() },
        });
        if (count === 1) return tx.deployment.findUnique({ where: { id: next.id } });
        tried.push(next.id); // count 0 → a cancel won the race for this row; try the next-oldest QUEUED row
      }
    });
  }

  /** Start the next queued deploy for an app, if one is queued and none is running. Reloads the app fresh so a
   *  deploy that waited in the queue builds the current config. Fire-and-forget: executeDeploy records its own
   *  terminal status and chains the next drain in its finally, so errors never surface here. */
  private async drain(appId: string): Promise<void> {
    const next = await this.claimNext(appId).catch(() => null);
    if (!next) return;
    const app = await this.prisma.application.findUnique({ where: { id: next.appId } });
    if (!app) return; // app deleted while queued — its deployments cascade away, nothing to run
    void this.executeDeploy(next, app, next.requestedBy ?? "system", next.noCache).catch(() => undefined);
  }

  /**
   * Cancel a QUEUED deploy — a compare-and-set on status=QUEUED. A RUNNING deploy can't be cancelled yet
   * (that needs an agent-side process kill — a separate step), so a RUNNING or already-terminal row 409s.
   * Scoped by the already-authorized appId, so a depId belonging to another app can't be cancelled (no IDOR).
   */
  async cancelDeployment(userId: string, appId: string, depId: string): Promise<Deployment | null> {
    await this.requireWrite(userId, appId, "apps:deploy");
    const { count } = await this.prisma.deployment.updateMany({
      where: { id: depId, appId, status: "QUEUED" },
      data: { status: "CANCELLED", exitCode: -1, logs: "Cancelled by user" },
    });
    if (count === 1) {
      await this.audit.log({ actor: userId, action: "app.deploy.cancel", target: appId });
      return this.prisma.deployment.findUnique({ where: { id: depId } });
    }
    const row = await this.prisma.deployment.findFirst({ where: { id: depId, appId } });
    if (!row) throw new NotFoundException("deployment not found");
    if (row.status === "RUNNING") throw new ConflictException("a running deployment can't be cancelled yet");
    throw new ConflictException("deployment already finished");
  }

  /** Execute one already-CLAIMED (RUNNING) deploy: build/run on the agent and record the result. The caller
   *  supplies a FRESH app (submitDeploy passes the just-fetched one for the inline path; drain reloads it, so
   *  config edited while the deploy sat QUEUED is picked up). On EVERY exit path it drains the app's queue
   *  (starts the next QUEUED deploy), so deploys for one app run one-at-a-time, FIFO. */
  private async executeDeploy(dep: Deployment, app: Application, actor: string, noCache: boolean) {
    this.deployLogs.begin(app.id);
    try {
      const isCompose = app.source === "COMPOSE";
      // COMPOSE-from-git: the compose file is cloned + rendered + validated on the agent rather than read from
      // a stored composeFile. It routes only through explicit per-service domains (there is no stored YAML to
      // infer a web service from), so composeWeb(app) is null for it.
      const isGitCompose = isCompose && !!app.composePath && !!app.gitUrl;
      const serviceDomains = isCompose ? await this.loadServiceDomains(app.id) : [];
      // A compose app also needs the proxy when its web service is routable (magic) OR it has per-service domains.
      const composeRoutable = isCompose && (!!this.composeWeb(app) || serviceDomains.length > 0);
      // Swarm apps route through the cluster's swarm-mode Traefik (Phase B), not the per-server classic proxy.
      if ((app.domain || serviceDomains.length > 0) && !app.clusterId && (!isCompose || composeRoutable)) await this.proxy.ensureProxy(app.serverId);
      const spec = this.toSpec(app);
      if (isCompose && serviceDomains.length > 0) spec.serviceDomains = serviceDomains;
      spec.env = await this.resolvedEnv(app); // team shared vars + app env (app wins)
      spec.buildArgs = this.appBuildArgs(app); // build-time vars (app-specific only)
      await this.hydrateCertSpec(app, spec);
      // Private repo via a GitHub App: mint a fresh installation token for the clone (GIT build or git-compose).
      if (app.gitSourceId && (app.source === "GIT" || isGitCompose)) {
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
      // ── Swarm service deploy: the app targets a cluster's swarm, not a single server. Delegate
      // the command build + dispatch (to the manager) + async-rollout classification to SwarmDeployService,
      // then apply the SAME exit-code contract (0 converged / 3 auto-rolled-back / other failed). ──
      if (app.clusterId) {
        const sd = await this.swarmDeploy.deploy(app, spec, dep.id, {
          noCache,
          timeoutMs: this.deployTimeoutMs(app),
          onChunk: (chunk) => this.deployLogs.push(app.id, chunk),
        });
        const ok = sd.exitCode === 0;
        const rolledBack = sd.exitCode === 3; // Swarm's native --update-failure-action rollback restored the previous live spec
        const sc = app.source === "GIT" ? parseCommit(sd.output) : null; // only GIT emits a real marker; gating blocks forged ones
        await this.prisma.deployment.update({
          where: { id: dep.id },
          data: {
            status: ok ? "SUCCESS" : "FAILED",
            kind: rolledBack ? "AUTO_ROLLBACK" : "DEPLOY",
            logs: sd.output.slice(0, 65536),
            exitCode: sd.exitCode,
            imageTag: null, // no local retag on a swarm — the registry ref is the artifact
            registryImage: ok ? sd.registryRef : null,
            imageDigest: ok ? sd.digest : null,
            commitSha: sc?.sha ?? null,
            commitMessage: sc?.message ?? null,
            ...this.finishStamp(dep),
          },
        });
        await this.prisma.application.update({
          where: { id: app.id },
          data: { status: ok || rolledBack ? AppStatus.RUNNING : AppStatus.FAILED },
        });
        this.deployLogs.finish(app.id, { status: ok ? "SUCCESS" : "FAILED", exitCode: sd.exitCode, deploymentId: dep.id });
        this.notifyDeploy(app, dep, ok ? "deploy_success" : rolledBack ? "deploy_rolled_back" : "deploy_failed").catch(() => {});
        // No image prune — nothing was retagged locally; the registry is the retention mechanism.
        await this.audit.log({ actor, action: "app.deploy", target: app.id });
        return this.prisma.deployment.findUnique({ where: { id: dep.id } });
      }
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
      // COMPOSE-from-git: clone + render the stack on the agent, then VALIDATE the rendered config on the hub
      // (assertSafeCompose, with the clone as the allowed root) BEFORE running anything. The up script re-clones
      // and refuses to run unless the stack still renders to the exact digest we validated (a TOCTOU lock).
      let gitComposeUp: string | null = null;
      if (isGitCompose) {
        this.deployLogs.push(app.id, "Validating compose from the repository...\n");
        const rr = await this.agentWs.sendCommand(
          app.serverId,
          buildComposeGitRenderScript(spec),
          "deploy",
          this.deployTimeoutMs(app),
          (chunk) => this.deployLogs.push(app.id, chunk),
        );
        if (rr.exitCode !== 0) throw new Error(`could not clone/render the compose from the repository\n${rr.output}`);
        const rendered = parseRenderedCompose(rr.output);
        if (!rendered) throw new Error("could not read the rendered compose from the repository — check the compose path and that the file is valid");
        // Throws BadRequestException (→ FAILED) if the rendered stack would escape the host; the clone dir is
        // the allowed root for build contexts and bind sources.
        assertSafeCompose(rendered.compose, { gitCloneRoot: composeGitCloneDir(spec) });
        // Route only services that actually exist in the rendered stack; drop (and note) any stale rows.
        if (spec.serviceDomains?.length) {
          const present = new Set(composeServiceNames(rendered.compose));
          const kept = spec.serviceDomains.filter((row) => present.has(row.service));
          for (const row of spec.serviceDomains) {
            if (!present.has(row.service)) this.deployLogs.push(app.id, `TUGRA: service "${row.service}" is not in the compose — its domain ${row.hostname} will not be routed\n`);
          }
          spec.serviceDomains = kept;
        }
        gitComposeUp = buildComposeGitUpScript(spec, rendered.sha, noCache);
      }
      const command = isGitCompose
        ? gitComposeUp!
        : isCompose
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
      // The IMAGE prep steps echo the digest marker; for a build-server deploy those steps run on the
      // BUILD server (buildLog), not the deploy server (r.output), so parse the COMBINED output.
      const combinedOutput = buildLog ? `${buildLog}\n${r.output}` : r.output;
      // GIT (and git-compose) deploys echo the deployed commit right after the clone; gate on those so a
      // pasted-IMAGE/COMPOSE build (or a hook) can't forge a marker — no real one is emitted there.
      const cc = app.source === "GIT" || isGitCompose ? parseCommit(combinedOutput) : null;
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          kind: rolledBack ? "AUTO_ROLLBACK" : "DEPLOY",
          // Prepend the build-server phase output so the persisted record has the full log.
          logs: combinedOutput.slice(0, 65536),
          exitCode: code,
          // Compose stacks are multi-image → no single rollback tag; a rolled-back
          // deploy's image never went live → no rollback tag either.
          imageTag: ok && !isCompose ? runTag(app, dep.id) : null,
          // The registry ref this build pushed to — lets rollback pull it even if the local
          // image was pruned. Only recorded on a successful push.
          registryImage: ok ? registryRef : null,
          // The resolved upstream digest the deploy script echoed (IMAGE pulls only) — provenance +
          // a byte-exact rollback source when the local tag is later pruned.
          imageDigest: ok && !isCompose ? parseImageDigest(combinedOutput) : null,
          commitSha: cc?.sha ?? null,
          commitMessage: cc?.message ?? null,
          ...this.finishStamp(dep),
        },
      });
      await this.prisma.application.update({
        where: { id: app.id },
        // A rolled-back deploy keeps the previous container running → app is still RUNNING.
        data: { status: ok || rolledBack ? AppStatus.RUNNING : AppStatus.FAILED },
      });
      // Post-deploy hook (classic path only): run the user command inside the now-live container. Issued as a
      // separate best-effort command so the delicate health-gate exit logic is untouched; failure never rolls back.
      if (ok && !isCompose && spec.postDeployCommand?.trim()) {
        const pr = await this.agentWs
          .sendCommand(app.serverId, buildPostDeployScript(spec), "deploy", this.deployTimeoutMs(app), (chunk) => this.deployLogs.push(app.id, chunk))
          .catch((e) => ({ output: e instanceof Error ? e.message : "post-deploy hook failed to run", exitCode: -1 }));
        // Persist the hook's output into the deployment record so the history has it (best-effort; the hook
        // is post-success, so it never changes the SUCCESS status or triggers a rollback).
        if (pr?.output) {
          await this.prisma.deployment
            .update({ where: { id: dep.id }, data: { logs: `${combinedOutput}\n${pr.output}`.slice(0, 65536) } })
            .catch(() => undefined);
        }
      }
      this.deployLogs.finish(app.id, {
        status: ok ? "SUCCESS" : "FAILED",
        exitCode: code,
        deploymentId: dep.id,
      });
      this.notifyDeploy(
        app,
        dep,
        ok ? "deploy_success" : rolledBack ? "deploy_rolled_back" : "deploy_failed",
      ).catch(() => {});
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
      // Best-effort: a build-server / git-compose failure throws with output that may still carry the commit
      // marker. GIT or git-compose only, so a pasted-IMAGE/COMPOSE failure message can't forge one. (isGitCompose
      // lives in the try scope, so the discriminator is inlined here.)
      const gitSourced = app.source === "GIT" || (app.source === "COMPOSE" && !!app.composePath && !!app.gitUrl);
      const cc = gitSourced && e instanceof Error ? parseCommit(e.message) : null;
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: "FAILED",
          logs: e instanceof Error ? e.message : "failed",
          commitSha: cc?.sha ?? null,
          commitMessage: cc?.message ?? null,
          ...this.finishStamp(dep),
        },
      });
      await this.prisma.application.update({
        where: { id: app.id },
        data: { status: AppStatus.FAILED },
      });
      this.deployLogs.finish(app.id, { status: "FAILED", exitCode: -1, deploymentId: dep.id });
      this.notifyDeploy(app, dep, "deploy_failed").catch(() => {});
    } finally {
      // Whatever happened (success, failure, or the early swarm return), start the next queued deploy for
      // this app. The row is already terminal here, so claimNext's RUNNING-count check won't see this one.
      void this.drain(app.id);
    }
    await this.audit.log({ actor, action: "app.deploy", target: app.id });
    return this.prisma.deployment.findUnique({ where: { id: dep.id } });
  }

  /** Re-run a previous successful deployment's image without rebuilding/pulling. */
  async rollback(userId: string, id: string, targetDeploymentId: string) {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    await this.ensureNoActiveDeploy(id); // don't race a running deploy/rollback (both write app.composeFile for compose)
    const isCompose = app.source === "COMPOSE";
    const target = await this.prisma.deployment.findFirst({
      where: { id: targetDeploymentId, appId: id, status: "SUCCESS" },
    });
    // Swarm app: roll the service back to the target deployment's image ref (no rebuild), not a classic run.
    if (app.clusterId) return this.rollbackSwarm(userId, app, target);
    // Resolve the rollback SOURCE up front (before creating the deployment / touching app status) so a
    // still-running app is never flipped to FAILED for an impossible rollback.
    let registryPull: { auth: RegistryAuth; ref: string } | null = null;
    let composeFile: string | null = null;
    if (isCompose) {
      // Compose apps have no single image tag; the rollbackable artifact is the compose YAML captured
      // verbatim in the target deploy's config snapshot. Env stays CURRENT (same as IMAGE/GIT rollback).
      composeFile = (target?.configSnapshot as ConfigSnapshot | null)?.composeFile ?? null;
      if (!target || !composeFile) {
        throw new NotFoundException("no rollbackable compose configuration for that deployment");
      }
    } else {
      // Rollbackable if the local tag is retained, OR a portable artifact exists to re-pull: a pushed
      // registry image, or the recorded upstream digest (IMAGE apps → byte-exact reconstruction).
      if (!target || (!target.imageTag && !target.registryImage && !target.imageDigest)) {
        throw new NotFoundException("no rollbackable deployment with that id");
      }
      // Prefer the retained LOCAL tag (fast, no network); pull from the registry only when the local
      // image is gone. If neither is usable, 404 up front.
      if (!target.imageTag && target.registryImage && app.registryId) {
        const reg = await this.prisma.registry.findFirst({ where: { id: app.registryId, teamId: app.teamId } });
        if (reg) {
          const auth: RegistryAuth = { url: reg.url ?? undefined, user: reg.username, token: this.crypto.decrypt(reg.passwordEnc) };
          registryPull = { auth, ref: target.registryImage };
        }
      }
      if (!registryPull && !target.imageTag && !target.imageDigest) {
        throw new NotFoundException("the image for this deployment is no longer available locally and cannot be pulled from a registry");
      }
    }
    const dep = await this.createRollbackDeployment(app.id);
    this.deployLogs.begin(app.id);
    try {
      if (app.domain) await this.proxy.ensureProxy(app.serverId);
      // For compose, derive the spec from the RESTORED compose file so its computed routing
      // (composeWebService + containerPort, which toSpec infers from the compose YAML) matches the
      // container actually being deployed — else a domain-routed app's Traefik override/labels would
      // point at the CURRENT version's service/port against the old container (silent 502 / phantom service).
      const spec = this.toSpec(isCompose ? { ...app, composeFile: composeFile! } : app);
      if (isCompose) spec.serviceDomains = await this.loadServiceDomains(app.id); // keep per-service routes on rollback
      spec.env = await this.resolvedEnv(app);
      await this.hydrateCertSpec(app, spec); // le-dns wildcard labels must match a normal deploy
      // A rollback re-runs a PRIOR image; never re-run deploy hooks (e.g. a migration) against it — a
      // registry/digest rollback is build=true, which would otherwise emit the pre-deploy step.
      spec.preDeployCommand = null;
      spec.postDeployCommand = null;
      let command: string;
      if (isCompose) {
        command = buildComposeUpScript(spec);
      } else {
        // registryPull → build=true so prepSteps PULLS + tags; else build=false re-runs the local tag.
        if (registryPull) spec.registryPull = registryPull;
        // IMAGE app whose local tag was pruned + no registry push: reconstruct byte-exact by pulling
        // the recorded upstream digest (spec.registryAuth carries any private-registry credentials).
        else if (!target!.imageTag && target!.imageDigest) {
          spec.registryPull = { auth: spec.registryAuth, ref: target!.imageDigest };
        }
        command = buildRunScript(spec, target!.id, !!spec.registryPull);
      }
      const r = await this.agentWs.sendCommand(
        app.serverId,
        command,
        "deploy",
        this.deployTimeoutMs(app),
        (chunk) => this.deployLogs.push(app.id, chunk),
      );
      const ok = r.exitCode === 0;
      // For compose, the compose YAML IS the deployable source — persist the rolled-back file as the
      // app's current one (DB+disk consistent, so a later restart/redeploy uses it). IMAGE apps keep
      // app.image and re-run an old tag, so nothing to persist there.
      if (ok && isCompose) {
        await this.prisma.application.update({ where: { id: app.id }, data: { composeFile: composeFile! } });
      }
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          logs: `rolled back to ${target!.id}\n${r.output.slice(0, 65000)}`,
          exitCode: r.exitCode,
          // Compose has no single rollback tag; record a snapshot so the rollback is itself a future
          // rollback target (mirrors the imageTag an IMAGE rollback records).
          imageTag: ok && !isCompose ? runTag(app, target!.id) : null,
          registryImage: ok && !isCompose ? target!.registryImage : null,
          // Carry the digest forward so the rollback deploy is itself a byte-exact rollback target.
          imageDigest: ok && !isCompose ? target!.imageDigest : null,
          // Rollback re-runs a prior image (no clone) → show the commit that is now live, carried from the target.
          commitSha: ok && !isCompose ? target!.commitSha : null,
          commitMessage: ok && !isCompose ? target!.commitMessage : null,
          ...(ok && isCompose ? { configSnapshot: buildConfigSnapshot(spec) as object } : {}),
          ...this.finishStamp(dep),
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
        data: { status: "FAILED", logs: e instanceof Error ? e.message : "failed", ...this.finishStamp(dep) },
      });
      await this.prisma.application.update({
        where: { id: app.id },
        data: { status: AppStatus.FAILED },
      });
      this.deployLogs.finish(app.id, { status: "FAILED", exitCode: -1, deploymentId: dep.id });
    } finally {
      // Rollback occupied the single RUNNING slot; resume any deploys that queued behind it.
      void this.drain(app.id);
    }
    await this.audit.log({
      actor: userId,
      action: "app.rollback",
      target: id,
      meta: { targetDeploymentId },
    });
    return this.prisma.deployment.findUnique({ where: { id: dep.id } });
  }

  /** Swarm-app rollback: `docker service update --image <target ref>` with the app's CURRENT config (no
   *  rebuild), mirroring the classic rollback philosophy. imageTag is never used for swarm apps, so the
   *  rollback source is the target deployment's pushed registryImage (GIT) or recorded digest (IMAGE). */
  private async rollbackSwarm(
    userId: string,
    app: Application,
    target: {
      id: string;
      registryImage: string | null;
      imageDigest: string | null;
      commitSha: string | null;
      commitMessage: string | null;
    } | null,
  ) {
    if (!target || (!target.registryImage && !target.imageDigest)) {
      throw new NotFoundException("no rollbackable deployment with that id");
    }
    let ref: string;
    let auth: RegistryAuth | null = null;
    if (target.registryImage) {
      ref = target.registryImage;
      if (app.registryId) {
        const reg = await this.prisma.registry.findFirst({ where: { id: app.registryId, teamId: app.teamId } });
        if (reg) auth = { url: reg.url ?? undefined, user: reg.username, token: this.crypto.decrypt(reg.passwordEnc) };
      }
    } else {
      ref = target.imageDigest!;
      auth = this.appRegistryAuth(app) ?? null;
    }
    const dep = await this.createRollbackDeployment(app.id);
    this.deployLogs.begin(app.id);
    try {
      const spec = this.toSpec(app);
      spec.env = await this.resolvedEnv(app);
      const sd = await this.swarmDeploy.rollbackTo(app, spec, ref, auth, {
        onChunk: (chunk) => this.deployLogs.push(app.id, chunk),
      });
      const ok = sd.exitCode === 0;
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: {
          status: ok ? "SUCCESS" : "FAILED",
          logs: `rolled back to ${target.id}\n${sd.output.slice(0, 65000)}`,
          exitCode: sd.exitCode,
          imageTag: null,
          registryImage: ok ? ref : null,
          imageDigest: ok ? sd.digest : null,
          // Carry the target deploy's commit forward so the rollback row shows what is now live.
          commitSha: ok ? target.commitSha : null,
          commitMessage: ok ? target.commitMessage : null,
          ...this.finishStamp(dep),
        },
      });
      await this.prisma.application.update({ where: { id: app.id }, data: { status: ok ? AppStatus.RUNNING : AppStatus.FAILED } });
      this.deployLogs.finish(app.id, { status: ok ? "SUCCESS" : "FAILED", exitCode: sd.exitCode, deploymentId: dep.id });
      this.notifyDeploy(app, dep, ok ? "deploy_success" : "deploy_failed").catch(() => {});
    } catch (e) {
      await this.prisma.deployment.update({ where: { id: dep.id }, data: { status: "FAILED", logs: e instanceof Error ? e.message : "failed", ...this.finishStamp(dep) } });
      await this.prisma.application.update({ where: { id: app.id }, data: { status: AppStatus.FAILED } });
      this.deployLogs.finish(app.id, { status: "FAILED", exitCode: -1, deploymentId: dep.id });
    } finally {
      void this.drain(app.id); // resume deploys queued behind the rollback
    }
    await this.audit.log({ actor: userId, action: "app.rollback", target: app.id });
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
    if (app.clusterId) {
      // Swarm: scale the service to 0 (keeps the service definition so start can scale it back up).
      const res = await this.swarmDeploy.scale(app, 0);
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`stop did not converge (exit ${res.exitCode}) — the app's status is unchanged`);
    } else {
      // A non-zero exit means the command RAN but failed (compose project missing, etc.); an offline/transport
      // failure rejects. Both used to be swallowed and the app was marked STOPPED anyway, so a failed stop
      // reported success (HTTP 200 + audit + UI toast all lied). Pre-check online for a clean 503, then verify
      // the command itself succeeded. (Classic stop ends `|| true` so it always exits 0 — this is a no-op there.)
      if (!this.agentWs.isOnline(app.serverId)) throw new ServiceUnavailableException("agent offline");
      const cmd = app.source === "COMPOSE" ? buildComposeStopScript(this.toSpec(app)) : buildStopScript(app);
      const res = await this.agentWs.sendCommand(app.serverId, cmd, "deploy", LIFECYCLE_TIMEOUT_MS);
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`stop failed (exit ${res.exitCode}) — the app's status is unchanged`);
    }
    await this.prisma.application.update({
      where: { id },
      data: { status: AppStatus.STOPPED },
    });
    await this.audit.log({ actor: userId, action: "app.stop", target: id });
  }

  async start(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    if (app.clusterId) {
      const res = await this.swarmDeploy.scale(app, Math.max(1, app.replicas ?? 1));
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`start did not converge (exit ${res.exitCode}) — the app's status is unchanged`);
    } else {
      // `docker start`/`compose start` exit non-zero when the container/project is gone — verify instead of
      // falsely reporting RUNNING (see stop()). Pre-check online for a clean 503 rather than an opaque 500.
      if (!this.agentWs.isOnline(app.serverId)) throw new ServiceUnavailableException("agent offline");
      const cmd = app.source === "COMPOSE" ? buildComposeStartScript(this.toSpec(app)) : buildStartScript(app);
      const res = await this.agentWs.sendCommand(app.serverId, cmd, "deploy", LIFECYCLE_TIMEOUT_MS);
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`start failed (exit ${res.exitCode}) — the app's status is unchanged`);
    }
    await this.prisma.application.update({ where: { id }, data: { status: AppStatus.RUNNING } });
    await this.audit.log({ actor: userId, action: "app.start", target: id });
  }

  async restart(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    if (app.clusterId) {
      // Swarm restart = a forced rolling recreation of all tasks (async; the builder polls to convergence).
      const res = await this.swarmDeploy.restart(app);
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`restart did not converge (exit ${res.exitCode}) — the app's status is unchanged`);
    } else {
      // `docker restart`/`compose restart` exit non-zero when the container/project is gone — verify instead of
      // falsely reporting RUNNING (see stop()). Pre-check online for a clean 503 rather than an opaque 500.
      if (!this.agentWs.isOnline(app.serverId)) throw new ServiceUnavailableException("agent offline");
      const cmd = app.source === "COMPOSE" ? buildComposeRestartScript(this.toSpec(app)) : buildRestartScript(app);
      const res = await this.agentWs.sendCommand(app.serverId, cmd, "deploy", LIFECYCLE_TIMEOUT_MS);
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`restart failed (exit ${res.exitCode}) — the app's status is unchanged`);
    }
    await this.prisma.application.update({ where: { id }, data: { status: AppStatus.RUNNING } });
    await this.audit.log({ actor: userId, action: "app.restart", target: id });
  }

  async remove(userId: string, id: string, opts: { keepVolumes?: boolean } = {}): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (app.clusterId) {
      // Swarm: remove the service cluster-wide (Swarm tears down every task on every node).
      await this.swarmDeploy.remove(app).catch(() => undefined);
    } else {
      // keepVolumes: leave the app's named volumes / compose volumes on the host (the user opted to keep
      // their data). Default removes them — deleting an app frees its disk, as before.
      const cmd =
        app.source === "COMPOSE"
          ? buildComposeDownScript(this.toSpec(app), { volumes: !opts.keepVolumes })
          : buildRemoveScript(app, opts.keepVolumes ? [] : this.appVolumes(app));
      await this.agentWs.sendCommand(app.serverId, cmd, "deploy").catch(() => undefined);
    }
    // Drop the app's uploaded custom cert from the proxy's /dynamic (best-effort; classic apps only — a
    // clustered app's cert lives on the manager's swarm proxy, a separate path).
    if (app.certPem && !app.clusterId) {
      await this.agentWs.sendCommand(app.serverId, buildCustomCertRemoveScript(app.id), "deploy").catch(() => undefined);
    }
    await this.monitors.removeForApp(id).catch(() => undefined);
    // Best-effort: remove the Cloudflare records Tugra auto-created for this app BEFORE the Domain rows cascade
    // away (otherwise they'd dangle at the provider). Never blocks deletion — the user already passed requireWrite.
    await this.dns.purgeDomains(userId, id).catch(() => undefined);
    await this.prisma.application.delete({ where: { id } });
    // Drop the deleted app's stale rule from its server's tunnel ingress (recomputed from DB truth).
    if (app.tunnelExposed) await this.syncTunnelIngress(app.serverId);
    await this.audit.log({ actor: userId, action: "app.remove", target: id });
  }

  /** Compensating delete for a create() that must be undone before any deploy ran (e.g. the
   *  migrator's adopt when its `docker rename` fails): drop the monitor + row, run NO docker —
   *  a deploy:false app never touched the host, and the foreign container must stay intact. */
  async discardUndeployed(appId: string): Promise<void> {
    await this.monitors.removeForApp(appId).catch(() => undefined);
    await this.prisma.application.delete({ where: { id: appId } }).catch(() => undefined);
  }

  async deployments(userId: string, id: string) {
    // Writer-only: each row carries the raw build/deploy `logs`, which can contain secrets (DSN, tokens,
    // .env dumps in build output) — same rationale as appLogs/listContainers. A VIEWER must not read them.
    const app = await this.requireWrite(userId, id);
    const isCompose = app.source === "COMPOSE";
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
      // A SUCCESS deploy is a rollback target if its artifact is retained: for compose that's the
      // compose YAML in its snapshot (recorded at deploy START, so it exists on FAILED rows too →
      // the status gate is essential); otherwise the local image tag or a portable registry image.
      const rollbackable =
        d.status === "SUCCESS" &&
        (isCompose ? !!next?.composeFile : !!(d.imageTag || d.registryImage || d.imageDigest));
      return { ...rest, configChanges: next ? diffSnapshots(prev, next) : [], rollbackable };
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
    // Swarm app: the "containers" are the service's tasks, spread across the cluster — list them via the
    // manager (`docker service ps`), not a single host's `docker ps`.
    if (app.clusterId) {
      const r = await this.swarmDeploy.status(app);
      return { containers: parseServiceTasks(r.output) };
    }
    const r = await this.agentWs.sendCommand(app.serverId, buildContainersScript(this.toSpec(app)), "deploy", 30_000);
    return { containers: parseContainers(r.output) };
  }

  /**
   * Live replica status for a swarm-deployed app — the desired replica count vs how many tasks are actually
   * running, plus each task's slot/node/state (for the app's cluster-deploy panel). Read via the swarm
   * manager (`docker service ps`). Degrades gracefully: a missing/offline manager (or any status error)
   * returns `reachable: false` with an empty task list rather than throwing, so the polling panel shows an
   * "unavailable" hint instead of erroring out.
   */
  async clusterStatus(
    userId: string,
    id: string,
  ): Promise<{ desired: number; running: number; reachable: boolean; tasks: SwarmTask[] }> {
    const app = await this.requireWrite(userId, id);
    if (!app.clusterId) throw new BadRequestException("app is not deployed to a cluster");
    const desired = app.replicas ?? 1;
    const r = await this.swarmDeploy.status(app).catch(() => ({ exitCode: 1, output: "" }));
    if (r.exitCode !== 0) return { desired, running: 0, reachable: false, tasks: [] };
    // Keep only the current generation (desired-state Running) — `docker service ps` also lists shut-down
    // history tasks, which would inflate the table and confuse the running/desired count.
    const tasks = parseSwarmTasks(r.output).filter((t) => t.desiredState === "Running");
    const running = tasks.filter((t) => t.currentState.startsWith("Running")).length;
    return { desired, running, reachable: true, tasks };
  }

  /** Tail the running container's logs — writer-only (output may contain secrets). */
  async appLogs(userId: string, id: string, tail?: number): Promise<{ output: string }> {
    const app = await this.requireWrite(userId, id);
    // Swarm app: aggregate logs across replicas from the manager (`docker service logs`).
    if (app.clusterId) {
      const r = await this.swarmDeploy.logs(app, clampTail(tail));
      return { output: r.output.slice(0, 65536) };
    }
    const r = await this.agentWs.sendCommand(
      app.serverId,
      buildLogsScript(this.toSpec(app), tail),
      "deploy",
      60_000,
    );
    return { output: r.output.slice(0, 65536) };
  }

  /**
   * List files/dirs inside one of the app's DECLARED volumes (read-only metadata only — never
   * content). The volume must be one the app declares (never an arbitrary docker volume). The path is
   * validated here (defense-in-depth) before it is sent; the agent re-validates and runs the listing
   * inside a sandboxed, read-only, network-less helper container (os.Root-confined). Writer-only, like logs.
   */
  async listFiles(
    userId: string,
    id: string,
    volumeName: string,
    path = "",
  ): Promise<{ entries: FsEntry[]; truncated: boolean }> {
    const app = await this.requireWrite(userId, id);
    let dockerName: string;
    if (app.source === "COMPOSE") {
      // Only a Tugra-owned, auto-named compose volume (tugra_<id>_<key>) is browsable — never an
      // external or custom-named volume, which could point at another app's or a host volume.
      const cv = composeVolumes(app).find((v) => v.key === volumeName);
      if (!cv || !cv.browsable) throw new BadRequestException("unknown volume for this app");
      dockerName = cv.dockerName;
    } else {
      const declared =
        Array.isArray(app.volumes) &&
        (app.volumes as Array<{ name?: string }>).some((v) => v?.name === volumeName);
      if (!declared) throw new BadRequestException("unknown volume for this app");
      dockerName = appVolumeName(app, volumeName);
    }
    const rel = assertSafeFsPath(path);
    // A swarm (clustered) app's stateful volume lives on the node it is PINNED to (constraintServerId),
    // not on app.serverId (the cluster's entry/manager) — targeting serverId would list the wrong host's
    // filesystem (empty or a different app's data). Resolve the real node for clustered apps.
    let targetServer = app.serverId;
    if (app.clusterId) {
      if (!app.constraintServerId) throw new BadRequestException("clustered app has no pinned node to browse");
      targetServer = app.constraintServerId;
    }
    if (!this.agentWs.isOnline(targetServer)) throw new ServiceUnavailableException("agent offline");
    return this.agentWs.sendFsReq(targetServer, "list", dockerName, rel);
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
    opts: { container?: string; tail?: number; follow?: boolean; since?: string; search?: string },
  ): Promise<Observable<LogStreamEvent>> {
    const app = await this.requireWrite(userId, id);
    const tail = clampTail(opts.tail);
    const since = normalizeSince(opts.since);
    const search = normalizeSearch(opts.search);
    // Swarm app: live-follow the aggregated service logs from the manager (`docker service logs --follow`).
    if (app.clusterId) {
      const managerId = await this.swarmDeploy.resolveManager(app.clusterId); // throws if swarm not ACTIVE/manager offline
      await this.audit.log({ actor: userId, action: "app.logs.stream", target: id });
      return this.logStream.stream(managerId, serviceName(app), { tail, follow: opts.follow ?? true, since, search, service: true });
    }
    const target = this.resolveLogTarget(app, opts.container);
    if (!this.agentWs.isOnline(app.serverId)) throw new ServiceUnavailableException("agent offline");
    // tail/since/search are SIGNED fields (canonicalLogStart) that also reach docker/grep on the
    // agent — normalize a malformed value to a safe default here so the signature verifies and no
    // bad value hits the shell-less docker/grep argv.
    await this.audit.log({ actor: userId, action: "app.logs.stream", target: id });
    return this.logStream.stream(app.serverId, target, { tail, follow: opts.follow ?? true, since, search });
  }

  /**
   * Pre-flight access check for the container-log SSE endpoint, run from a guard so the HTTP status is
   * real. `@Sse` commits a 200 + text/event-stream response the moment the handler is invoked, so a
   * throw from inside the handler can no longer set 403/503 — a guard runs first (canActivate) and its
   * ForbiddenException / ServiceUnavailableException becomes the actual response status.
   */
  async assertContainerLogStreamAccess(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (app.clusterId) {
      await this.swarmDeploy.resolveManager(app.clusterId); // throws if the swarm isn't ACTIVE / the manager is offline
      return;
    }
    if (!this.agentWs.isOnline(app.serverId)) throw new ServiceUnavailableException("agent offline");
  }

  /**
   * One-shot log export for download (writer-only). Not a stream — collects `docker logs` output in
   * a single request/response so the browser can save it as a file. No `search` (that's a live-view
   * filter); `since` + a larger tail cap are supported.
   */
  async downloadLogs(
    userId: string,
    id: string,
    opts: { container?: string; tail?: number; since?: string },
  ): Promise<string> {
    const app = await this.requireWrite(userId, id);
    const tail = clampTail(opts.tail, 10000);
    // Swarm app: aggregated service logs from the manager (honor the since window + timestamps, like classic).
    if (app.clusterId) {
      const r = await this.swarmDeploy.logs(app, tail, normalizeSince(opts.since));
      await this.audit.log({ actor: userId, action: "app.logs.download", target: id });
      return r.output.slice(0, 5_000_000);
    }
    const target = this.resolveLogTarget(app, opts.container);
    if (!this.agentWs.isOnline(app.serverId)) throw new ServiceUnavailableException("agent offline");
    const since = normalizeSince(opts.since);
    // Fixed command; target is prefix-validated + since is normalized (no shell metacharacters).
    const cmd = `docker logs --timestamps --tail ${tail}${since ? ` --since ${since}` : ""} ${target} 2>&1`;
    const r = await this.agentWs.sendCommand(app.serverId, cmd, "deploy", 60_000);
    await this.audit.log({ actor: userId, action: "app.logs.download", target: id });
    return r.output.slice(0, 5_000_000); // hard cap the response size
  }

  /** Resolve + validate the target container for a log op (writer already checked by requireWrite).
   *  Compose: the client-picked container MUST belong to this app's `tugra_<id>` project AND be a
   *  plain docker name — the download path interpolates this into a shell command, so the charset
   *  check (no shell metacharacters, spaces, `;`, `|`, `$`…) prevents command injection there. */
  private resolveLogTarget(app: Application, container?: string): string {
    if (app.source !== "COMPOSE") return containerName(app);
    const prefix = composeProject(app); // `tugra_${app.id}`
    const picked = container ?? "";
    const membership = picked === prefix || picked.startsWith(`${prefix}-`);
    if (!membership || !/^[a-zA-Z0-9._-]+$/.test(picked)) {
      throw new BadRequestException("invalid container for this app");
    }
    return picked;
  }

  /**
   * Per-container resource history (CPU/RAM/Net/Block) for the app's charts. Read-level (`require`)
   * — metrics carry no secrets, so any team member (incl. READER) may view them. The container set
   * is derived server-side from the app's `tugra_<id>` project prefix; the range is clamped.
   */
  async containerMetrics(userId: string, id: string, range?: string): Promise<AppContainerMetrics> {
    const app = await this.require(userId, id);
    // A swarm app's task containers are scattered across the cluster's member nodes (named
    // tugra_<id>.<slot>.<taskid>), so query every member and match the `.` task suffix.
    if (app.clusterId) {
      const members = await this.prisma.server.findMany({ where: { clusterId: app.clusterId }, select: { id: true } });
      return this.containerMetricsSvc.forApp(members.map((m) => m.id), composeProject(app), range, true);
    }
    return this.containerMetricsSvc.forApp(app.serverId, composeProject(app), range);
  }

  /**
   * Live build-log stream for the app's active deploy (replay-so-far + live).
   * Returns null when there's no active stream → caller falls back to the
   * persisted logs served by deployments().
   */
  async streamLogs(userId: string, id: string) {
    // Writer-only: build/deploy logs can echo secrets (env values printed during a build), and the REST
    // `deployments()` / persisted-log path is already writer-gated — a viewer must not read them over SSE.
    await this.requireWrite(userId, id);
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

  /**
   * Opt an app into (or out of) the node-local managed-DB network (tugra-net) so its container resolves
   * `tugra_db_<id>` by name. Turning it ON is refused unless the app can actually use that node-local bridge:
   * a classic (non-swarm) app, not COMPOSE (those declare their own networks), with no conflicting --network
   * in docker options, and at least one managed database on the SAME server. Takes effect on the NEXT deploy
   * (no live reattach); turning it OFF is always allowed (the next deploy drops the network). Writer-gated.
   */
  async setDbNetwork(userId: string, id: string, on: boolean): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (on) {
      if (app.clusterId) throw new BadRequestException("a swarm/cluster app deploys on the overlay — it can't join the node-local DB network");
      if (app.source === "COMPOSE") throw new BadRequestException("a compose app manages its own networks — declare tugra-net in the compose file instead");
      if (hasNetworkOpt(app.dockerOptions)) {
        throw new BadRequestException("remove the --network flag from this app's docker options before linking the DB network");
      }
      const dbCount = await this.prisma.database.count({ where: { serverId: app.serverId, teamId: app.teamId } });
      if (dbCount === 0) throw new BadRequestException("no managed database on this app's server to link to");
    } else {
      // Turning it off would strip tugra-net from the next deploy, breaking every linked database's
      // injected URI. Refuse until the links are removed first.
      const linkCount = await this.prisma.appDatabaseLink.count({ where: { appId: id } });
      if (linkCount > 0) throw new BadRequestException("unlink this app's databases before leaving the managed-DB network");
    }
    await this.prisma.application.update({ where: { id }, data: { dbNetwork: on } });
    await this.audit.log({ actor: userId, action: "app.db_network.update", target: id, meta: { on } });
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
    const app = await this.requireWrite(userId, id);
    // Validate at set-time (clear 400 now, not a failed deploy later): reject an unterminated quote AND any
    // host-escaping flag (--privileged, docker.sock/host-path bind, host namespaces, host devices,
    // non-allowlisted --cap-add). Shell-injection itself is neutralized at deploy time by dockerOptionsArgs.
    assertSafeDockerOptions(dockerOptions);
    // A DB-network-linked app manages its own --network; a conflicting one here would be ambiguous.
    if (app.dbNetwork && hasNetworkOpt(dockerOptions)) {
      throw new BadRequestException("this app is linked to the managed-DB network — remove --network here, or unlink the DB network first");
    }
    await this.prisma.application.update({ where: { id }, data: { dockerOptions } });
    await this.audit.log({ actor: userId, action: "app.docker_options.update", target: id });
  }

  /** Set the pre/post-deploy hook commands. Arbitrary shell, so: write-gated, trimmed (empty → null to
   *  clear the hook), and the audit record carries only lengths — never the command text. Execution runs
   *  in a container of the app image at deploy time (shell-quoted, exit-normalized), never on the host. */
  async setDeployHooks(userId: string, id: string, pre: string | null, post: string | null): Promise<void> {
    const app = await this.requireWrite(userId, id);
    const norm = (s: string | null) => {
      const trimmed = (s ?? "").trim();
      return trimmed ? trimmed : null;
    };
    const preDeployCommand = norm(pre);
    const postDeployCommand = norm(post);
    // Hooks only execute on the classic single-server path (preDeploySteps / buildPostDeployScript). Reject
    // setting them where they'd silently never run — but always allow clearing (both null) so stale values
    // can be removed after an app is moved to a cluster.
    if ((preDeployCommand || postDeployCommand) && (app.clusterId || app.source === "COMPOSE" || app.isPreview)) {
      throw new BadRequestException("deploy hooks are only supported on single-server, non-compose apps");
    }
    await this.prisma.application.update({ where: { id }, data: { preDeployCommand, postDeployCommand } });
    await this.audit.log({
      actor: userId,
      action: "app.deploy_hooks.update",
      target: id,
      meta: { preLen: preDeployCommand?.length ?? 0, postLen: postDeployCommand?.length ?? 0 },
    });
  }

  /**
   * Replace a COMPOSE app's docker-compose.yml. Validated up front (clear 400 now, not a failed
   * deploy later): valid YAML plus no privileged / host-escaping / host-bind compose — the same
   * safety policy a Coolify-imported stack already passes (assertSafeCompose). The routed web service
   * and container port are re-inferred from the stored file at deploy/view time, so persisting the
   * file is enough for routing to follow a renamed/removed web service. Applies on the next deploy;
   * only the size + sha256 are audited, never the content.
   */
  async setComposeFile(userId: string, id: string, composeFile: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (app.source !== "COMPOSE") throw new BadRequestException("not a compose app");
    assertSafeCompose(composeFile);
    await this.ensureNoActiveDeploy(id);
    await this.prisma.application.update({ where: { id }, data: { composeFile } });
    await this.audit.log({
      actor: userId,
      action: "app.compose_file.update",
      target: id,
      meta: { bytes: composeFile.length, sha256: createHash("sha256").update(composeFile).digest("hex") },
    });
  }

  /**
   * Edit WHERE the app's code/image comes from, after create (day-2). The source TYPE is fixed:
   * a GIT app edits repo URL / branch / GitHub-App link; an IMAGE app edits its image ref; a COMPOSE
   * app uses setComposeFile instead. Applies on the NEXT deploy (no auto-deploy).
   *
   * SECURITY: a stored git credential is scoped to one host. Changing the repo URL to a different host —
   * or switching an https (token) repo to ssh — must never carry that credential to the new host, or an
   * attacker-controlled URL would exfiltrate it via the clone's GIT_ASKPASS / x-access-token injection.
   * So a host change clears the HTTPS token and unlinks any GitHub App; switching to ssh clears the token
   * and mints a fresh deploy key; and a GitHub App (github.com-only) can never pair with a non-github host.
   * Returns the credential side effects as `warnings` so the UI can tell the operator what was reset.
   */
  async setSource(userId: string, id: string, input: SetSourceInput): Promise<{ warnings: string[] }> {
    const app = await this.requireWrite(userId, id);
    if (app.isPreview) throw new BadRequestException("a preview app's source is controlled by its parent");
    if (app.source === "COMPOSE") throw new BadRequestException("edit a compose app's source with the compose-file endpoint");
    const warnings: string[] = [];
    const data: Prisma.ApplicationUncheckedUpdateInput = {};

    if (app.source === "IMAGE") {
      if (input.gitUrl !== undefined || input.gitBranch !== undefined || input.gitSourceId !== undefined) {
        throw new BadRequestException("this app deploys a prebuilt image — only `image` can be changed (the source type is fixed at create)");
      }
      if (input.image === undefined) throw new BadRequestException("provide an image reference");
      data.image = input.image;
    } else {
      // GIT
      if (input.image !== undefined) throw new BadRequestException("this app builds from Git — `image` does not apply (the source type is fixed at create)");

      const nextUrl = input.gitUrl !== undefined ? input.gitUrl : app.gitUrl ?? "";
      const prevHost = gitUrlHost(app.gitUrl ?? "");
      const nextHost = gitUrlHost(nextUrl);
      if (input.gitUrl !== undefined && !nextHost) throw new BadRequestException("could not parse the git URL host");
      const hostChanged = input.gitUrl !== undefined && nextHost !== prevHost;
      const wasSsh = isSshGitUrl(app.gitUrl ?? "");
      const nowSsh = isSshGitUrl(nextUrl);

      // Resolve the GitHub-App link requested in THIS call (team-scoped), so the host guard sees final state.
      let nextSourceId: string | null | undefined;
      if (input.gitSourceId !== undefined) {
        if (input.gitSourceId === null) nextSourceId = null;
        else {
          const gs = await this.prisma.gitSource.findUnique({ where: { id: input.gitSourceId } });
          if (!gs || gs.teamId !== app.teamId) throw new BadRequestException("git source not found in this team");
          nextSourceId = input.gitSourceId;
        }
      }

      if (input.gitUrl !== undefined) data.gitUrl = input.gitUrl;
      if (input.gitBranch !== undefined) data.gitBranch = input.gitBranch;
      if (nextSourceId !== undefined) data.gitSourceId = nextSourceId;

      // A host change (or https->ssh) must drop the old host's credentials.
      if (hostChanged || (nowSsh && !wasSsh)) {
        if (app.gitTokenEnc) { data.gitTokenEnc = null; warnings.push("git_token_cleared"); }
        // Unlink the GitHub App unless the caller is re-linking it in this same call.
        if (app.gitSourceId && nextSourceId === undefined) { data.gitSourceId = null; nextSourceId = null; warnings.push("git_source_unlinked"); }
      }
      const effectiveSourceId = nextSourceId !== undefined ? nextSourceId : app.gitSourceId;

      if (nowSsh) {
        // ssh authenticates with a deploy key, never a token or GitHub App.
        if (effectiveSourceId) throw new BadRequestException("unlink the GitHub App before switching to an ssh repository (ssh clones with a deploy key, not an app token)");
        if (app.gitTokenEnc && data.gitTokenEnc === undefined) { data.gitTokenEnc = null; warnings.push("git_token_cleared"); }
        if (!wasSsh || hostChanged || !app.gitSshKeyEnc) {
          const key = generateEd25519DeployKey();
          data.gitSshKeyEnc = this.crypto.encrypt(key.privateKeyOpenSsh);
          data.gitSshPublicKey = key.publicKey;
          warnings.push("ssh_key_generated"); // add this public key to the repo before deploying
        }
      } else if (wasSsh && !nowSsh) {
        // https now — a stored deploy key is dead weight; drop it so the UI shows no stale key.
        data.gitSshKeyEnc = null;
        data.gitSshPublicKey = null;
      }

      // A GitHub App installation token only authenticates github.com — it must never be injected into
      // a clone of any other host.
      if (effectiveSourceId && !nowSsh && nextHost && nextHost !== "github.com") {
        throw new BadRequestException("the linked GitHub App only authenticates github.com repositories — unlink it or point the repo at github.com");
      }
    }

    await this.ensureNoActiveDeploy(id);
    await this.prisma.application.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "app.source.update", target: id, meta: { warnings } });
    return { warnings };
  }

  /**
   * Edit HOW a Git app is built, after create (day-2): the build type, the one set of fields that applies
   * to it, and the monorepo base directory. Replace semantics — the fields that don't apply to the chosen
   * type are cleared (so a stale dockerfilePath/buildCommand can't leak into a Nixpacks build) and an
   * omitted baseDirectory clears it (back to the repo root). GIT apps only (IMAGE deploys a prebuilt image;
   * COMPOSE builds from its compose file). Applies on the next deploy.
   */
  async setBuild(userId: string, id: string, input: SetBuildInput): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (app.isPreview) throw new BadRequestException("a preview app's build is controlled by its parent");
    if (app.source !== "GIT") throw new BadRequestException("build settings apply only to Git apps");
    await this.ensureNoActiveDeploy(id);
    await this.prisma.application.update({
      where: { id },
      data: {
        buildType: input.buildType,
        dockerfilePath: input.buildType === "DOCKERFILE" ? input.dockerfilePath ?? null : null,
        buildCommand: input.buildType === "STATIC" ? input.buildCommand ?? null : null,
        outputDir: input.buildType === "STATIC" ? input.outputDir ?? null : null,
        // The monorepo base directory applies to every build type, so it sits outside the per-type ternaries.
        baseDirectory: input.baseDirectory ?? null,
      },
    });
    await this.audit.log({ actor: userId, action: "app.build.update", target: id, meta: { buildType: input.buildType, baseDirectory: input.baseDirectory ?? null } });
  }

  /** Config mounts (serviceName/target/mode + current content) of a COMPOSE app, for the editor UI.
   *  Content holds `${KEY}` placeholders at rest (resolved only at deploy) but can also hold literal
   *  text a user typed, so the route is gated `read:secrets`. Empty when the app declares none. */
  async listConfigMounts(userId: string, id: string): Promise<AppConfigMount[]> {
    const app = await this.requireWrite(userId, id);
    if (app.source !== "COMPOSE") throw new BadRequestException("not a compose app");
    return this.appConfigMounts(app);
  }

  /**
   * Replace ONLY the content of the config mount whose target matches. serviceName, target and mode
   * stay exactly as stored — the mount is addressed by its exact target, never added or re-keyed, so
   * the raw YAML service key and the index-derived host path stay server-controlled. Applies on the
   * next deploy (the override carries a content fingerprint so compose recreates the service). Audits
   * size + sha256 only, never the content.
   */
  async setConfigMountContent(userId: string, id: string, target: string, content: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (app.source !== "COMPOSE") throw new BadRequestException("not a compose app");
    validateConfigMountTarget(target); // reuse the install-time shape/injection guard
    const mounts = this.appConfigMounts(app);
    const idx = mounts.findIndex((m) => m.target === target);
    if (idx < 0) throw new NotFoundException("config mount not found");
    // Keep the whole app's materialized script within the agent's single-argv limit (see compose-script
    // base64 inflation); cap one mount and the sum across mounts.
    const total = mounts.reduce((n, m, i) => n + (i === idx ? content.length : m.content.length), 0);
    if (total > 256 * 1024) throw new BadRequestException("config mounts exceed the total size limit");
    await this.ensureNoActiveDeploy(id);
    const next = mounts.map((m, i) => (i === idx ? { ...m, content } : m));
    await this.prisma.application.update({
      where: { id },
      data: { configMounts: next as unknown as Prisma.InputJsonValue },
    });
    await this.audit.log({
      actor: userId,
      action: "app.config_mount.update",
      target: id,
      meta: { target, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") },
    });
  }

  /** Per-app deploy/rollback timeout in ms (default 5 min). */
  private deployTimeoutMs(app: Application): number {
    return (app.deployTimeoutSec ?? 300) * 1000;
  }

  async setLimits(
    userId: string,
    id: string,
    limits: {
      memoryMb?: number | null;
      cpus?: number | null;
      reserveMemoryMb?: number | null;
      reserveCpus?: number | null;
      gpus?: string | null;
      deployTimeoutSec?: number | null;
    },
  ): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: {
        memoryMb: limits.memoryMb ?? null,
        cpus: limits.cpus ?? null,
        reserveMemoryMb: limits.reserveMemoryMb ?? null,
        reserveCpus: limits.reserveCpus ?? null,
        gpus: limits.gpus || null, // "" (cleared) → null
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

  /** Replace an app's HOST bind-mounts (e.g. a media library). Validated now against the sensitive-path
   *  denylist (clear 400, not a broken deploy later) — the exact bar the free-form dockerOptions `-v` path
   *  already enforces. Applies on the next deploy. */
  async setHostMounts(userId: string, id: string, mounts: HostMount[]): Promise<void> {
    await this.requireWrite(userId, id);
    const clean = validateHostMounts(mounts);
    await this.prisma.application.update({ where: { id }, data: { hostMounts: clean as unknown as Prisma.InputJsonValue } });
    await this.audit.log({ actor: userId, action: "app.host_mounts.update", target: id, meta: { count: clean.length } });
  }

  async setVolumes(userId: string, id: string, volumes: AppVolume[]): Promise<void> {
    const app = await this.requireWrite(userId, id);
    const data: Prisma.ApplicationUncheckedUpdateInput = { volumes: volumes as unknown as Prisma.InputJsonValue };
    // Adding persistent storage to an app ALREADY on a cluster hard-pins it to one node (a stateful
    // service can't diverge across nodes) — symmetric with setClusterConfig, and closes the pre-existing gap
    // where setVolumes had zero cluster-awareness. Removing all volumes does NOT auto-unpin (v1 — see docs).
    if (app.clusterId && volumes.length > 0) {
      if ((app.replicas ?? 1) > 1) {
        throw new BadRequestException("lower replicas to 1 before adding persistent storage — a stateful app pinned to a single node can't run more than one replica");
      }
      const cluster = await this.prisma.cluster.findUnique({ where: { id: app.clusterId }, select: { swarmManagerId: true } });
      if (!cluster?.swarmManagerId) throw new BadRequestException("cluster has no swarm manager to pin this stateful app to");
      data.constraintServerId = cluster.swarmManagerId;
      data.placement = Prisma.JsonNull; // hard pin overrides any user placement rules (can't contradict the pin)
    }
    await this.prisma.application.update({ where: { id }, data });
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

  /** Deploy this app as a Docker Swarm service across a cluster, or clear it back to classic
   *  single-server deploy. Swarm mode requires a stateless single-service app on a formed swarm; a GIT app
   *  additionally needs a registry (its image must be pullable by every node). */
  async setClusterConfig(
    userId: string,
    id: string,
    cfg: { clusterId?: string | null; replicas?: number | null },
  ): Promise<void> {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    const data: Prisma.ApplicationUncheckedUpdateInput = {};
    if (cfg.clusterId !== undefined) {
      let managerId: string | null = null;
      if (cfg.clusterId) {
        if (app.source === "COMPOSE") throw new BadRequestException("compose apps can't be deployed as swarm services yet");
        // A DB-network link is a node-local bridge (tugra-net) — meaningless on a multi-node overlay. Unlink
        // first so the operator explicitly re-decides DB connectivity for the swarm topology.
        if (app.dbNetwork) throw new BadRequestException("this app is linked to the node-local DB network (tugra-net) — unlink it (dbNetwork off) before deploying to a swarm");
        // GPUs are node-local hardware — genuinely unsupportable on a multi-node cluster. (Named volumes used
        // to be refused here too; a stateful app is now hard-pinned to one node instead — see below.)
        if (app.gpus) throw new BadRequestException("GPU apps can't be deployed as swarm services");
        const cluster = await this.prisma.cluster.findUnique({ where: { id: cfg.clusterId }, select: { teamId: true, swarmStatus: true, swarmManagerId: true } });
        if (!cluster || cluster.teamId !== app.teamId) throw new BadRequestException("cluster not found in this team");
        if (cluster.swarmStatus !== "ACTIVE" && cluster.swarmStatus !== "DEGRADED") {
          throw new BadRequestException("form the cluster's swarm before deploying to it");
        }
        if (app.source === "GIT") {
          if (!app.registryId) throw new BadRequestException("a GIT app deployed to a swarm needs a registry (the image must be pullable by every node)");
          data.pushToRegistry = true; // every node pulls the built image from the registry
        }
        managerId = cluster.swarmManagerId;
        // A stateful app's named volume is node-local — a replica rescheduled elsewhere would start
        // with empty/diverged data. Instead of refusing, hard-pin it to one node (the manager — deterministic,
        // always resolvable, same anchor magic-domain re-home already uses) so its single replica lands on its data.
        if (this.appVolumes(app).length > 0) {
          if (!managerId) throw new BadRequestException("cluster has no swarm manager to pin this stateful app to");
          data.constraintServerId = managerId;
          // A hard node-pin is authoritative over user placement rules (which are meaningless on a single-node
          // app and can directly contradict the pin) — clear them so the deploy can't emit a contradictory set.
          data.placement = Prisma.JsonNull;
        } else {
          // Stateless on a cluster: never leave a STALE pin from a previous stateful/different-cluster state.
          data.constraintServerId = null;
        }
      } else {
        data.constraintServerId = null; // leaving a cluster drops the node pin (meaningless on classic deploy)
      }
      // Placement references a SPECIFIC cluster's live nodes — stale on ANY clusterId change (including
      // clearing back to classic deploy, where constraints are meaningless). Wipe it (Prisma.JsonNull convention).
      if (cfg.clusterId !== app.clusterId) data.placement = Prisma.JsonNull;
      data.clusterId = cfg.clusterId;
      // A magic app is served by the CLUSTER's swarm-Traefik (on the manager), not its own server — so
      // re-home its magic domain + cert onto the manager when it joins a cluster, and back onto its own
      // server when it leaves. The existing {slug}-{hash} label is preserved so the URL only moves its
      // IP/wildcard part (stable across re-home). Custom domains are server-agnostic (le-http) → untouched.
      if (app.exposeMode === "magic" && app.domainKind !== "custom") {
        const srvId = cfg.clusterId ? managerId : app.serverId;
        const server = srvId
          ? await this.prisma.server.findUnique({
              where: { id: srvId },
              select: { publicIp: true, publicIpv6: true, wildcardDomain: true, magicSuffix: true, certMode: true },
            })
          : null;
        if (server) {
          const label = (app.domain ?? "").split(".")[0] || undefined; // keep the URL stable across re-home
          const domain = magicDomain({
            name: app.name,
            label,
            publicIp: server.publicIp,
            publicIpv6: server.publicIpv6,
            wildcardDomain: server.wildcardDomain,
            suffix: server.magicSuffix ?? process.env.MAGIC_DOMAIN_SUFFIX ?? "sslip.io",
          });
          if (domain) {
            // A wildcard DNS-01 cert (le-dns) on the target gives the magic app HTTPS under one cert; else plain HTTP.
            const le = server.certMode === "le-dns" && !!server.wildcardDomain;
            data.domain = domain;
            data.https = le;
            data.certType = le ? "le-dns" : "http";
            data.domainKind = "magic";
          }
        }
      }
    }
    // A stateful app pinned to one node runs exactly 1 replica (N>1 tasks would mount the same node-local
    // volume concurrently = corruption). Effective clusterId so a later replicas-only change is caught too.
    const effectiveClusterId = cfg.clusterId !== undefined ? cfg.clusterId : app.clusterId;
    // Effective replicas too (not just this call's cfg.replicas): a pin call that OMITS replicas must still be
    // caught if the app already has replicas>1 stored (else N tasks mount the same node-local volume = corruption).
    const effectiveReplicas = cfg.replicas !== undefined ? cfg.replicas : app.replicas;
    if (effectiveClusterId && this.appVolumes(app).length > 0 && effectiveReplicas != null && effectiveReplicas > 1) {
      throw new BadRequestException("a stateful app pinned to a single node runs exactly 1 replica");
    }
    if (cfg.replicas !== undefined) {
      data.replicas = cfg.replicas === null ? null : Math.max(1, Math.floor(cfg.replicas));
    }
    await this.prisma.application.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "app.clusterconfig.update", target: id });
  }

  /** LIVE scale a cluster-deployed app to `replicas` NOW (persist the count AND apply it to the running swarm
   *  service, polling to convergence) — unlike setClusterConfig which only persists for the next deploy. Scoped
   *  to swarm apps (replicas are meaningless for a single classic container) and refuses N>1 for a stateful
   *  (named-volume) app pinned to one node, mirroring setClusterConfig's guard. Reuses swarmDeploy.scale (which
   *  has no auth of its own) behind requireWrite('apps:deploy'). */
  async scaleNow(userId: string, id: string, replicas: number): Promise<void> {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    if (!app.clusterId) throw new BadRequestException("scaling replicas is only supported for cluster-deployed (swarm) apps");
    const n = Math.max(1, Math.floor(replicas));
    if (this.appVolumes(app).length > 0 && n > 1) {
      throw new BadRequestException("a stateful app pinned to a single node runs exactly 1 replica");
    }
    // Apply LIVE first and only persist `replicas` once the swarm actually converged — mirrors runDeploy's
    // "apply, then persist the true outcome". Persisting first would poison app.replicas (the desired-state
    // field a later start()/deploy() blindly reasserts) with a count that never took effect if the manager is
    // offline or the rollout doesn't converge. scale() takes the count as an arg, so `app` needs no mutation.
    const res = await this.swarmDeploy.scale(app, n);
    if (res.exitCode !== 0) {
      throw new ServiceUnavailableException(`scale did not converge (exit ${res.exitCode}) — the app's stored replica count is unchanged`);
    }
    await this.prisma.application.update({ where: { id }, data: { replicas: n } });
    await this.audit.log({ actor: userId, action: "app.scale", target: id, meta: { replicas: n } });
  }

  /** Configure swarm placement. Config-time (applied on next deploy) like volumes/limits. Requires a
   *  clusterId; hostname/nodeId rules are re-validated server-side against the cluster's CURRENT live nodes at
   *  save time (a TOCTOU with a node leaving between page-load and save is acceptable — same class as our
   *  manager-reachability checks elsewhere). */
  async setPlacement(userId: string, id: string, input: SetPlacementInput): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (!app.clusterId) throw new BadRequestException("select a cluster before configuring placement");
    const needsLive = input.constraints.some((c) => c.type === "hostname" || c.type === "nodeId");
    if (needsLive) {
      const live = (await this.swarm.status(userId, app.clusterId)).live ?? [];
      for (const c of input.constraints) {
        if (c.type === "hostname" && !live.some((n) => n.hostname === c.value)) throw new BadRequestException(`no live node with hostname "${c.value}"`);
        if (c.type === "nodeId" && !live.some((n) => n.id === c.value)) throw new BadRequestException(`no live node with id "${c.value}"`);
      }
    }
    await this.prisma.application.update({ where: { id }, data: { placement: input as unknown as Prisma.InputJsonValue } });
    await this.audit.log({ actor: userId, action: "app.placement.update", target: id });
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
    const app = await this.requireWrite(userId, id);
    await this.assertDomainNotReserved(domain); // don't let an app steal the control-panel hostname
    // A user-set domain is "custom" and served over HTTPS (Let's Encrypt); clearing
    // it resets the kind. This keeps custom domains on HTTPS under the certType-aware
    // Traefik labels (a bare `{ domain }` update would leave certType at the "http"
    // default and silently drop the app to plain HTTP).
    const data: Prisma.ApplicationUpdateInput = domain
      ? { domain, domainKind: "custom", certType: "le-http", https: true }
      : { domain: null, domainKind: "none", extraDomains: [] }; // no primary → alias domains are meaningless
    await this.clearCertIfLeavingCustom(app, data);
    await this.prisma.application.update({ where: { id }, data });
    await this.syncMonitor(id).catch(() => undefined); // keep the auto uptime monitor's target in step
    // A tunnel-exposed app's CF ingress rule keys off its hostname — rebuild it when the domain changes/clears.
    if (app.tunnelExposed) await this.syncTunnelIngress(app.serverId);
    await this.audit.log({ actor: userId, action: "app.domain.update", target: id });
  }

  /**
   * Replace an app's additional alias hostnames — extra domains served alongside the primary `domain`, each
   * on its own HTTPS router (HTTP-01), applied on the next deploy. Classic/compose only. Each host must be
   * free: not the control-panel domain, not the primary (or its www/bare counterpart), not claimed by another
   * app (as a primary or an alias), and — for an uploaded custom cert — covered by it. A replace-set (the
   * passed list becomes the complete set), mirroring Coolify's domain-list replace.
   */
  async setExtraDomains(userId: string, id: string, domains: string[]): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (!app.domain) throw new BadRequestException("set a primary domain before adding extra domains");
    // Swarm stale-label removal on `docker service update` isn't wired yet → extras are classic/compose only.
    if (app.clusterId) throw new BadRequestException("extra domains aren't supported for clustered (swarm) apps yet");
    // A tunnel-exposed app has no public HTTP-01 reachability (its ingress keys off the single primary host).
    if (app.tunnelExposed) throw new BadRequestException("extra domains aren't supported for a tunnel-exposed app");
    const hosts = Array.from(new Set(domains.map((h) => h.trim().replace(/\.+$/, "").toLowerCase()))).filter(Boolean);
    const base = app.domain.replace(/^www\./i, "");
    for (const h of hosts) {
      await this.assertDomainNotReserved(h); // never let an alias steal the control-panel hostname
      if (h === app.domain.toLowerCase() || h === base.toLowerCase() || h === `www.${base.toLowerCase()}`) {
        throw new BadRequestException(`${h} is already served by the primary domain`);
      }
    }
    // Uploaded custom cert: an alias is served by SNI from the shared cert store, so the cert MUST cover it
    // (otherwise Traefik would hand out its default cert for that host).
    if (app.certType === "custom" && app.certPem) {
      for (const h of hosts) {
        if (!certCoversHost(app.certDomains, h)) {
          throw new BadRequestException(`the uploaded certificate does not cover ${h}`);
        }
      }
    }
    // Cross-app claim: no other app may already use any of these hosts as its primary or an alias. Generic
    // message so another team's app name isn't leaked.
    if (hosts.length) {
      const clash = await this.prisma.application.findFirst({
        where: { id: { not: id }, OR: [{ domain: { in: hosts, mode: "insensitive" } }, { extraDomains: { hasSome: hosts } }] },
        select: { id: true },
      });
      if (clash) throw new BadRequestException("one of those hostnames is already in use by another application");
    }
    await this.prisma.application.update({ where: { id }, data: { extraDomains: hosts } });
    await this.audit.log({ actor: userId, action: "app.extra_domains.update", target: id, meta: { count: hosts.length } });
  }

  /** The per-service domains of a COMPOSE app (service → hostname + port), for the deploy spec + the UI. */
  async listServiceDomains(userId: string, id: string): Promise<{ service: string; hostname: string; port: number }[]> {
    await this.requireWrite(userId, id);
    return this.loadServiceDomains(id);
  }

  private async loadServiceDomains(appId: string): Promise<{ service: string; hostname: string; port: number }[]> {
    const rows = await this.prisma.appServiceDomain.findMany({ where: { applicationId: appId }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => ({ service: r.service, hostname: r.hostname, port: r.port }));
  }

  /**
   * Replace a COMPOSE app's per-service domains — each routes a named compose service (on a port) to its own
   * hostname, applied on the next deploy. Validated like extra domains (panel/primary/cross-app/cert), plus
   * the service must exist in the stored compose YAML (for a git compose the deploy's render step checks it).
   */
  async setServiceDomains(userId: string, id: string, rows: { service: string; hostname: string; port: number }[]): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (app.source !== "COMPOSE") throw new BadRequestException("service domains apply only to compose apps");
    if (app.clusterId) throw new BadRequestException("service domains aren't supported for clustered apps");
    if (app.tunnelExposed) throw new BadRequestException("service domains aren't supported for a tunnel-exposed app");
    const hosts = rows.map((r) => r.hostname);
    const base = app.domain ? app.domain.replace(/^www\./i, "").toLowerCase() : null;
    const services = app.composeFile ? new Set(composeServiceNames(app.composeFile)) : null;
    for (const row of rows) {
      await this.assertDomainNotReserved(row.hostname);
      if (base && (row.hostname === app.domain!.toLowerCase() || row.hostname === base || row.hostname === `www.${base}`)) {
        throw new BadRequestException(`${row.hostname} is already served by the primary domain`);
      }
      if ((app.extraDomains ?? []).map((h) => h.toLowerCase()).includes(row.hostname)) {
        throw new BadRequestException(`${row.hostname} is already an extra domain of this app`);
      }
      if (services && !services.has(row.service)) {
        throw new BadRequestException(`compose service "${row.service}" is not defined in the compose file`);
      }
      if (app.certType === "custom" && app.certPem && !certCoversHost(app.certDomains, row.hostname)) {
        throw new BadRequestException(`the uploaded certificate does not cover ${row.hostname}`);
      }
    }
    // Cross-app claim across every app's primary domain, its aliases, and other apps' service domains.
    if (hosts.length) {
      const [appClash, svcClash] = await Promise.all([
        this.prisma.application.findFirst({ where: { id: { not: id }, OR: [{ domain: { in: hosts, mode: "insensitive" } }, { extraDomains: { hasSome: hosts } }] }, select: { id: true } }),
        this.prisma.appServiceDomain.findFirst({ where: { applicationId: { not: id }, hostname: { in: hosts } }, select: { id: true } }),
      ]);
      if (appClash || svcClash) throw new BadRequestException("one of those hostnames is already in use by another application");
    }
    await this.prisma.$transaction([
      this.prisma.appServiceDomain.deleteMany({ where: { applicationId: id } }),
      this.prisma.appServiceDomain.createMany({ data: rows.map((r) => ({ applicationId: id, service: r.service, hostname: r.hostname, port: r.port })) }),
    ]);
    await this.audit.log({ actor: userId, action: "app.service_domains.update", target: id, meta: { count: rows.length } });
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
    if (input.mode === "custom") await this.assertDomainNotReserved(input.domain); // not the panel's hostname
    const server = await this.prisma.server.findUnique({ where: { id: app.serverId } });
    if (!server) throw new NotFoundException("server not found");
    const composeWebService = app.source === "COMPOSE" ? (this.composeWeb(app)?.service ?? null) : null;
    const e = this.resolveExpose(
      { name: app.name, domain: input.mode === "custom" ? input.domain : null, exposeMode: input.mode },
      server,
      app.source,
      composeWebService,
    );
    const data: Prisma.ApplicationUpdateInput = { domain: e.domain, https: e.https, exposeMode: e.exposeMode, domainKind: e.domainKind, certType: e.certType };
    await this.clearCertIfLeavingCustom(app, data); // drop a stale custom cert when re-exposing off "custom"
    await this.prisma.application.update({ where: { id }, data });
    await this.syncMonitor(id).catch(() => undefined);
    // Rebuild tunnel ingress when the app is routed through a tunnel and its hostname just changed/cleared.
    if (app.tunnelExposed) await this.syncTunnelIngress(app.serverId);
    await this.audit.log({ actor: userId, action: "app.expose.update", target: id, meta: { mode: input.mode } });
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    const ctx = await loadProjectCtx(this.prisma, app.environmentId);
    // Reflect a cleared custom cert in the returned view (data.certPem is nulled when it was dropped).
    const certCleared = data.certPem === null ? { certPem: null, certKeyEnc: null, certDomains: [], certNotAfter: null } : {};
    return this.view({ ...app, ...e, ...certCleared }, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, ctx, server.publicIp ?? server.publicIpv6 ?? null);
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

  /**
   * Upload an operator-supplied custom TLS cert for this app (certType → "custom"). The cert/key pair is
   * validated + matched here (parseCustomCert) so a broken pair is rejected before anything is stored; the
   * key is encrypted at rest and never returned. Takes effect on the next deploy, when the deploy script
   * writes the cert into the proxy's /dynamic and the router serves it statically by SNI (no ACME).
   */
  async setCustomCert(userId: string, id: string, certPem: string, keyPem: string): Promise<{ domains: string[]; notAfter: string }> {
    const app = await this.requireWrite(userId, id);
    if (!app.domain || app.domainKind !== "custom") {
      throw new BadRequestException("a custom certificate applies to a custom domain — set one on this app first");
    }
    // A clustered app is fronted by the manager's swarm-Traefik; the per-server /dynamic cert write isn't on
    // that path, so a custom cert there would silently serve Traefik's default cert. Refuse rather than lie.
    if (app.clusterId) {
      throw new BadRequestException("custom certificates aren't supported for clustered (swarm) apps yet");
    }
    let info: { domains: string[]; notAfter: Date };
    try {
      info = parseCustomCert(certPem, keyPem);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    // The cert lands in the server's SHARED Traefik cert store (matched by SNI), so it must actually cover
    // this app's own host — otherwise a writer could install a cert for a domain they don't control, or just
    // break their own HTTPS (Traefik would find no SNI match and serve its default cert).
    if (!certCoversHost(info.domains, app.domain)) {
      throw new BadRequestException(
        `the certificate does not cover ${app.domain} (it is valid for: ${info.domains.join(", ") || "no domains"})`,
      );
    }
    // Alias hostnames are served from the SAME shared cert store by SNI, so the cert must cover them too.
    for (const h of app.extraDomains ?? []) {
      if (!certCoversHost(info.domains, h)) {
        throw new BadRequestException(`the certificate does not cover the extra domain ${h} (valid for: ${info.domains.join(", ") || "no domains"})`);
      }
    }
    await this.prisma.application.update({
      where: { id },
      data: {
        certType: "custom",
        certPem,
        certKeyEnc: this.crypto.encrypt(keyPem),
        certDomains: info.domains,
        certNotAfter: info.notAfter,
      },
    });
    await this.audit.log({
      actor: userId,
      action: "app.cert.upload",
      target: id,
      meta: { domains: info.domains, notAfter: info.notAfter.toISOString() },
    });
    return { domains: info.domains, notAfter: info.notAfter.toISOString() };
  }

  /** Remove the uploaded custom cert and revert certType (le-http for a real domain, else http). Best-effort
   *  deletes the cert from the proxy's /dynamic so it stops being served; the router label reverts on the
   *  next deploy. */
  async clearCustomCert(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (!app.certPem && app.certType !== "custom") return; // nothing stored
    await this.prisma.application.update({
      where: { id },
      data: {
        certPem: null,
        certKeyEnc: null,
        certDomains: [],
        certNotAfter: null,
        certType: app.domainKind === "custom" ? "le-http" : "http",
      },
    });
    if (!app.clusterId) {
      await this.agentWs.sendCommand(app.serverId, buildCustomCertRemoveScript(id), "deploy").catch(() => undefined);
    }
    await this.audit.log({ actor: userId, action: "app.cert.clear", target: id });
  }

  /**
   * One-click custom-domain setup: create the Cloudflare DNS records (DnsAutomationService) AND wire the app's
   * domain fields. `dryRun` returns the plan only. Otherwise it applies the records, then sets the app domain
   * (custom + le-http + HTTPS) and, for an apex domain with a www CNAME, the www→apex canonical redirect — so
   * both the apex and www are served and one Let's Encrypt cert covers them. apps:config is checked up front
   * (fail fast before any DNS write) and DnsAutomationService additionally enforces apps:deploy.
   */
  async autoSetupDomain(
    userId: string,
    id: string,
    input: { domain: string; credentialId?: string; includeWww?: boolean; overwrite?: boolean; dryRun?: boolean },
  ): Promise<{ dryRun: boolean; hostname: string; status?: string; apex?: boolean; sslMode?: string; records: unknown[] }> {
    await this.requireWrite(userId, id); // apps:config — we will set the domain; fail before any DNS mutation
    await this.assertDomainNotReserved(input.domain); // fail before creating DNS records for the panel's host
    const opts = { domain: input.domain, credentialId: input.credentialId, includeWww: input.includeWww, overwrite: input.overwrite };
    if (input.dryRun) {
      const plan = await this.dns.previewRecords(userId, id, opts);
      return { dryRun: true, hostname: plan.hostname, apex: plan.apex, sslMode: plan.sslMode, records: plan.records };
    }
    const applied = await this.dns.applyRecords(userId, id, opts);
    await this.setDomain(userId, id, applied.hostname); // custom + le-http + https + monitor/tunnel sync
    // Set the canonical redirect EXPLICITLY in every case: "root" (www → apex) only when the apex has a www
    // CNAME, otherwise clear it. Leaving a stale redirect would make Traefik serve Host(base)||Host(www) and
    // request a cert for a www host that has no DNS record — failing the Let's Encrypt order and breaking HTTPS.
    const hasWww = applied.records.some((r) => r.type === "CNAME" && r.name.startsWith("www."));
    await this.setDomainOptions(userId, id, { domainRedirect: applied.apex && hasWww ? "root" : null });
    return { dryRun: false, hostname: applied.hostname, status: applied.status, apex: applied.apex, records: applied.records };
  }

  /** The copy-paste DNS records to create by hand at any provider (manual fallback when not using Cloudflare). */
  manualDomainRecords(userId: string, id: string, input: { domain: string; includeWww?: boolean }) {
    return this.dns.manualRecords(userId, id, input);
  }

  /** Re-check that the app's auto-setup domain resolves to the app (real public-DNS lookup) + refresh its status. */
  verifyDomain(userId: string, id: string, hostname?: string) {
    return this.dns.verify(userId, id, hostname);
  }

  /** Tear down the Cloudflare records Tugra created for a domain (+ drop the Domain row). */
  cleanupDomainDns(userId: string, id: string, hostname?: string) {
    return this.dns.cleanup(userId, id, hostname);
  }

  /** The audit history for one app (every actor). Gated by the SAME authz as GET /apps/:id — membership +
   *  per-resource/project access (require), so a scoped member can't read the audit of an app they can't view. */
  async listAudit(userId: string, id: string, filters?: AuditFilters) {
    await this.require(userId, id);
    return this.audit.listForTarget(id, filters);
  }

  /** Every app domain across the user's teams + a live SSL status probe. */
  async listDomains(userId: string, q?: string): Promise<DomainView[]> {
    const withDomain = (await this.list(userId)).filter((a) => a.domain);
    // Apply `?q` over domain-level fields BEFORE the live per-domain SSL probe, so only matches are probed.
    const apps = filterByQuery(withDomain, q, (a) => [a.name, a.domain, a.url, a.domainRedirect]);
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

  private appHostMounts(app: Application): HostMount[] {
    return Array.isArray(app.hostMounts) ? (app.hostMounts as unknown as HostMount[]) : [];
  }

  /** The named volumes a COMPOSE app declares, for the Files tab (empty for non-compose). The real
   *  docker name stays server-side; only the key, mount points and a browsable flag are exposed. */
  private composeVolumesView(app: Application): { key: string; browsable: boolean; mounts: { service: string; path: string }[] }[] {
    if (app.source !== "COMPOSE") return [];
    return composeVolumes(app).map((v) => ({ key: v.key, browsable: v.browsable, mounts: v.mounts }));
  }

  private appConfigMounts(app: Application): AppConfigMount[] {
    return Array.isArray(app.configMounts) ? (app.configMounts as unknown as AppConfigMount[]) : [];
  }

  /** Structured placement of a swarm app, safely coerced from the nullable Json column. */
  private appPlacement(app: Application): { constraints: PlacementConstraint[]; spreadLabelKey: string | null } {
    const p = app.placement as { constraints?: unknown; spreadLabelKey?: unknown } | null;
    return {
      constraints: Array.isArray(p?.constraints) ? (p!.constraints as PlacementConstraint[]) : [],
      spreadLabelKey: typeof p?.spreadLabelKey === "string" ? (p!.spreadLabelKey as string) : null,
    };
  }

  private appGitToken(app: Application): string | null {
    if (!app.gitTokenEnc) return null;
    try {
      return this.crypto.decrypt(app.gitTokenEnc);
    } catch {
      return null;
    }
  }

  /** Decrypt the app's SSH deploy key for the deploy spec. Null when none is stored or the blob can't be read. */
  private appGitSshKey(app: Application): string | null {
    if (!app.gitSshKeyEnc) return null;
    try {
      return this.crypto.decrypt(app.gitSshKeyEnc);
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

  /**
   * Env injected at deploy, lowest precedence first: team shared variables, then auto-injected database
   * links (connection URIs), then app-specific vars. A link whose key the app sets explicitly is skipped
   * (the explicit value wins); any other unresolvable link fails the deploy loudly. Computed fresh so a
   * changed DB host/credential propagates on the next deploy without re-saving env.
   */
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
    const appEnv = this.appEnv(app);
    const linked = await this.dbLinks.resolveLinkedEnv(app, new Set(Object.keys(appEnv)));
    return { ...merged, ...linked, ...appEnv }; // shared < linked DB < app-specific
  }

  /**
   * Fill an AppSpec's server-derived cert fields (wildcard root + custom resolver)
   * for a le-dns/custom app — these live on the Server, not the Application row, so
   * both runDeploy AND rollback must set them or the rolled-back container loses its
   * wildcard cert labels. No-op for http/le-http apps.
   */
  /** When an app that carries an uploaded custom cert is moved OFF certType "custom" (a domain or expose
   *  change), drop the stored cert + key from the row AND remove it from the proxy's /dynamic, so no stale
   *  cert or private key lingers (and the old SNI stops being served). Mutates `data` in place; call BEFORE
   *  the prisma update. No-op for an app without a stored cert. */
  private async clearCertIfLeavingCustom(app: Application, data: Prisma.ApplicationUpdateInput): Promise<void> {
    if (!app.certPem) return;
    if (data.certType === "custom") return; // staying custom — keep it
    data.certPem = null;
    data.certKeyEnc = null;
    data.certDomains = [];
    data.certNotAfter = null;
    if (data.certType === undefined) data.certType = "http"; // domainless app: don't leave certType "custom"
    if (!app.clusterId) {
      await this.agentWs.sendCommand(app.serverId, buildCustomCertRemoveScript(app.id), "deploy").catch(() => undefined);
    }
  }

  /** Decrypt an app's uploaded custom-cert private key for the deploy spec. Null when none is stored or the
   *  stored ciphertext can't be read (never write a broken key into the proxy). */
  private appCertKey(app: Application): string | null {
    if (!app.certKeyEnc) return null;
    try {
      return this.crypto.decrypt(app.certKeyEnc);
    } catch {
      return null;
    }
  }

  private async hydrateCertSpec(app: Application, spec: AppSpec): Promise<void> {
    if (app.certType !== "le-dns" && app.certType !== "custom") return;
    // A clustered app is fronted by the manager's swarm-Traefik, so its wildcard / custom resolver
    // must come from the MANAGER's server config — not the app's own server (which isn't in the route).
    let srvId = app.serverId;
    if (app.clusterId) {
      const cluster = await this.prisma.cluster
        .findUnique({ where: { id: app.clusterId }, select: { swarmManagerId: true } })
        .catch(() => null);
      if (cluster?.swarmManagerId) srvId = cluster.swarmManagerId;
    }
    const srv = await this.prisma.server
      .findUnique({ where: { id: srvId }, select: { wildcardDomain: true, customCertResolver: true } })
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
      baseDirectory: app.baseDirectory,
      buildCommand: app.buildCommand,
      outputDir: app.outputDir,
      composeFile: app.composeFile,
      composePath: app.composePath,
      healthCmd: app.healthCmd,
      healthCheckType: app.healthCheckType,
      healthCheckPath: app.healthCheckPath,
      healthCheckPort: app.healthCheckPort,
      memoryMb: app.memoryMb,
      cpus: app.cpus,
      reserveMemoryMb: app.reserveMemoryMb,
      reserveCpus: app.reserveCpus,
      gpus: app.gpus,
      replicas: app.replicas,
      placementConstraints: this.appPlacement(app).constraints,
      placementSpreadLabelKey: this.appPlacement(app).spreadLabelKey,
      dockerOptions: app.dockerOptions,
      preDeployCommand: app.preDeployCommand,
      postDeployCommand: app.postDeployCommand,
      // Attach to the node-local managed-DB network only for a classic (non-swarm) deploy — a clustered app
      // runs as a swarm service on the overlay, where a node-local bridge is meaningless.
      dbNetwork: !!app.dbNetwork && !app.clusterId,
      volumes: this.appVolumes(app),
      hostMounts: this.appHostMounts(app),
      gitToken: this.appGitToken(app),
      gitSshKey: this.appGitSshKey(app),
      registryAuth: this.appRegistryAuth(app),
      env: this.appEnv(app),
      hostPort: app.hostPort,
      containerPort: web?.port ?? app.containerPort,
      domain: app.domain,
      extraDomains: app.extraDomains ?? [],
      domainRedirect: (app.domainRedirect as "www" | "root" | null) ?? null,
      securityHeaders: app.securityHeaders,
      forwardAuth: app.forwardAuth,
      certType: app.certType,
      // A clustered app deploys on the swarm manager's proxy, where the per-server /dynamic cert write never
      // runs — so never feed it a custom cert (it would relabel to tls=true with no cert and serve the
      // default). Classic apps only. setCustomCert also refuses clustered apps up front.
      certPem: app.clusterId ? null : app.certPem,
      certKey: app.clusterId ? null : this.appCertKey(app),
      composeWebService: web?.service ?? null,
      // Config mounts are a template (COMPOSE) feature only — never for a docker-run app.
      configMounts: app.source === "COMPOSE" ? this.appConfigMounts(app) : null,
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

  // --- Custom app icon (user-uploaded PNG, stored inline in Postgres) ---------------------------------
  // The icon is served to <img> tags from our own origin, so the upload is validated strictly: a real PNG
  // (8-byte signature + a well-formed IHDR), square, 32-512px a side, and at most 64KB decoded. A file that
  // passes those checks cannot be content-sniffed into HTML/SVG/script, which — together with the fixed
  // image/png Content-Type + nosniff the GET endpoint sends — stops a hostile upload from ever executing in
  // the panel's origin. Kept small by design (the browser crops to a 128x128 PNG before upload).
  static readonly ICON_MAX_BYTES = 64 * 1024;

  private validatePngIcon(buf: Buffer): void {
    if (buf.length > ApplicationsService.ICON_MAX_BYTES) throw new BadRequestException("icon too large (max 64KB)");
    // Need at least the 8-byte signature + 25-byte IHDR + 12-byte IEND to be a structurally complete PNG.
    if (buf.length < 45) throw new BadRequestException("icon is not a valid PNG");
    const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buf.subarray(0, 8).equals(SIG)) throw new BadRequestException("icon must be a PNG");
    // The first chunk must be IHDR with the canonical 13-byte body (length at 8-11, type "IHDR" at 12-15).
    if (buf.readUInt32BE(8) !== 13 || buf.toString("ascii", 12, 16) !== "IHDR") {
      throw new BadRequestException("icon is not a valid PNG");
    }
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width !== height) throw new BadRequestException("icon must be square");
    if (width < 32 || width > 512) throw new BadRequestException("icon must be 32-512px square");
    // Must end with the canonical 12-byte IEND chunk (empty data → fixed CRC 0xAE426082). This rejects a
    // header-only, truncated or garbage-tailed upload — which no browser could decode — rather than storing
    // it as a broken image. It is not a full PNG decode, but it bounds a direct-API caller to complete files.
    const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    if (!buf.subarray(buf.length - 12).equals(IEND)) throw new BadRequestException("icon is not a valid PNG");
  }

  /** Raw icon bytes for the GET endpoint (read-authorized). 404 when the app has no custom icon. */
  async getIcon(userId: string, id: string): Promise<{ mime: string; data: Buffer }> {
    await this.require(userId, id);
    const icon = await this.prisma.appIcon.findUnique({ where: { appId: id } });
    if (!icon) throw new NotFoundException("no icon");
    return { mime: icon.mime, data: Buffer.from(icon.data) };
  }

  /** Store (or replace) the app's custom icon from a base64-encoded PNG. Write-authorized + strictly validated. */
  async setIcon(userId: string, id: string, pngBase64: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    const buf = Buffer.from(pngBase64, "base64"); // tolerant decode; the PNG check below is the real gate
    if (buf.length === 0) throw new BadRequestException("icon is empty");
    this.validatePngIcon(buf);
    await this.prisma.$transaction([
      this.prisma.appIcon.upsert({
        where: { appId: id },
        create: { appId: id, mime: "image/png", data: buf, sizeBytes: buf.length },
        update: { mime: "image/png", data: buf, sizeBytes: buf.length },
      }),
      this.prisma.application.update({ where: { id }, data: { iconUpdatedAt: new Date() } }),
    ]);
    await this.audit.log({ actor: userId, action: "app.icon.set", target: app.id, meta: { sizeBytes: buf.length } });
  }

  /** Remove the app's custom icon (idempotent — a no-op when none is set). Write-authorized. */
  async deleteIcon(userId: string, id: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    await this.prisma.$transaction([
      this.prisma.appIcon.deleteMany({ where: { appId: id } }), // deleteMany: removing a missing icon is a no-op, not a 404
      this.prisma.application.update({ where: { id }, data: { iconUpdatedAt: null } }),
    ]);
    await this.audit.log({ actor: userId, action: "app.icon.delete", target: app.id });
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

  /** Build the typed deploy-event ctx (project/env names, app URL, duration) and fire it. */
  private async notifyDeploy(
    app: Application,
    dep: { id: string; createdAt?: Date | string | null; startedAt?: Date | string | null },
    event: string,
  ): Promise<void> {
    const [pctx, serverIp] = await Promise.all([
      // Enrichment is best-effort — a transient lookup failure must not drop the notification.
      loadProjectCtx(this.prisma, app.environmentId).catch(
        (): ResourceProjectCtx => ({ projectId: null, projectName: null, environmentName: null }),
      ),
      this.serverIp(app.serverId),
    ]);
    const url = appUrl(
      {
        domain: app.domain,
        https: app.https,
        hostPort:
          app.hostPort ??
          (app.domain == null && app.source === "COMPOSE" ? primaryHostPort(app, this.composeWeb(app)) : null),
      },
      serverIp ?? null,
    );
    // The raw deploy output is deliberately NOT forwarded: it can echo secrets (env/connection
    // strings) and is writer-only in-app. The notification links to the access-controlled log instead.
    await this.notifications.fireForEvent(app.teamId, event, {
      appId: app.id,
      appName: app.name,
      domain: app.domain,
      url: url ?? "",
      projectName: pctx.projectName,
      environmentName: pctx.environmentName,
      // Measure from when the deploy started (startedAt), falling back to createdAt; never let a missing
      // timestamp throw and drop the whole notification.
      durationMs: this.finishStamp(dep).durationMs,
    });
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
      gitSourceId: app.gitSourceId,
      buildType: app.buildType,
      buildCommand: app.buildCommand,
      dockerfilePath: app.dockerfilePath,
      baseDirectory: app.baseDirectory,
      outputDir: app.outputDir,
      composeFile: canWrite ? app.composeFile : null,
      composePath: app.composePath,
      hasConfigMounts: this.appConfigMounts(app).length > 0,
      healthCmd: app.healthCmd,
      healthCheckType: app.healthCheckType,
      healthCheckPath: app.healthCheckPath,
      healthCheckPort: app.healthCheckPort,
      memoryMb: app.memoryMb,
      cpus: app.cpus,
      reserveMemoryMb: app.reserveMemoryMb,
      reserveCpus: app.reserveCpus,
      gpus: app.gpus,
      deployTimeoutSec: app.deployTimeoutSec,
      dockerOptions: app.dockerOptions,
      // Hooks are deploy-time exec power and may embed internal paths → writer-only (like composeFile).
      preDeployCommand: canWrite ? app.preDeployCommand : null,
      postDeployCommand: canWrite ? app.postDeployCommand : null,
      dbNetwork: !!app.dbNetwork && !app.clusterId,
      volumes: this.appVolumes(app),
      hostMounts: this.appHostMounts(app),
      composeVolumes: this.composeVolumesView(app),
      hasGitToken: !!app.gitTokenEnc,
      hasGitSshKey: !!app.gitSshKeyEnc,
      gitSshPublicKey: app.gitSshPublicKey ?? null,
      registryUrl: this.appRegistryAuth(app)?.url ?? null,
      registryUser: this.appRegistryAuth(app)?.user ?? null,
      registryId: app.registryId,
      pushToRegistry: app.pushToRegistry,
      buildServerId: app.buildServerId,
      clusterId: app.clusterId,
      replicas: app.replicas,
      placement: this.appPlacement(app),
      constraintServerId: app.constraintServerId,
      deployStrategy: app.deployStrategy,
      rollbackOnFailure: app.rollbackOnFailure,
      // Whether this app will ACTUALLY deploy zero-downtime (rolling) — surfaces the fact
      // that a ROLLING preference silently falls back to recreate for non-eligible apps.
      // Mirrors runDeploy's real decision (`!isCompose && rollingEligible`): a compose app
      // deploys via its own up/down, never rolling.
      zeroDowntime: app.source !== "COMPOSE" && this.rollingEligible(app),
      templateSlug: app.templateSlug,
      templateLogo: app.templateSlug ? (this.catalog.get(app.templateSlug)?.logo ?? app.templateSlug) : null,
      iconUpdatedAt: app.iconUpdatedAt,
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
      extraDomains: app.extraDomains ?? [],
      domainRedirect: app.domainRedirect,
      securityHeaders: app.securityHeaders,
      forwardAuth: app.forwardAuth,
      https: app.https,
      domainKind: app.domainKind,
      exposeMode: app.exposeMode,
      tunnelExposed: app.tunnelExposed,
      certType: app.certType,
      certDomains: app.certDomains,
      certNotAfter: app.certNotAfter,
      hasCustomCert: !!app.certPem,
      // A domainless COMPOSE app is reachable via its portMappings, not the always-null scalar
      // hostPort — derive the effective port (only when needed) so the URL is never null.
      url: appUrl(
        {
          domain: app.domain,
          https: app.https,
          hostPort:
            app.hostPort ??
            (app.domain == null && app.source === "COMPOSE" ? primaryHostPort(app, this.composeWeb(app)) : null),
        },
        serverIp ?? null,
      ),
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
