import { sourceUsableBy } from "../git-sources/source-scope";
import type { PrProvider } from "../webhooks/pr-events";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { createHash } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { ModuleRef } from "@nestjs/core";
import { z } from "zod";
import { Application, AppStatus, Deployment, Prisma, Role } from "@prisma/client";
import type { FsEntry, TeamPermission } from "@tugra/shared";
import { AGENT_FEATURE_CMD_JOURNAL } from "@tugra/shared";
import { APP_MOVE_TERMINAL, assertNoActiveMove, findActiveMove } from "../common/app-move-guard";
import { AgentDisconnectedException, AgentOfflineException } from "../agent-gateway/agent-offline.exception";
import { DeployLeaseService } from "./deploy-lease.service";
import { INTERRUPTED_DEPLOY_NOTE } from "./deployment-reconcile.service";
import { decideDeployOutcome, isDispatchPlan, isSwarmDispatch, type DispatchPlan } from "./deploy-outcome";
import { classifyActor, classifyNote, finishedAtOf, predatesMove, toDeploymentRow } from "./deployment-view";
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
import {
  applyEnvFlags, autoMultilineLegacy, BUILD_FLAG_TOTAL_MAX_BYTES, encodeEnvMeta, EnvMetaCorruptError, ML_KEYS_MAX, ML_TOTAL_MAX_BYTES, ML_VALUE_MAX_BYTES,
  normalizeFlags, parseEnvMeta, pruneMeta, validateEnvFlags, type EnvMeta, type FlagInput,
} from "../common/env-flags";
import { validatePngIcon } from "../common/png-icon";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { DeployLogHub } from "../agent-gateway/deploy-log.hub";
import { LogStreamService, type LogStreamEvent } from "../agent-gateway/log-stream.service";
import { ContainerMetricsService, type AppContainerMetrics } from "../metrics/container-metrics.service";
import { normalizeSince, normalizeSearch, clampTail } from "../common/log-filters";
import { assertSafeFsPath } from "../common/fs-path";
import { CryptoService } from "../crypto/crypto.service";
import { ProxyService } from "./proxy.service";
import { ProxyConfigService } from "../proxy-config/proxy-config.service";
import { SwarmDeployService } from "../clusters/swarm-deploy.service";
import { SwarmService } from "../clusters/swarm.service";
import { DnsAutomationService } from "../dns/dns-automation.service";
import type { PlacementConstraint } from "../deploy/deploy-script";
import type { PushAlias } from "../deploy/push-ref";
import { injectableBuildArgs } from "../deploy/build-args";
import { APPS_NETWORK, isUserNetworkNameAllowed } from "../deploy/network-names";
import type { SetPlacementInput } from "./dto";
import { PlacementConstraintSchema } from "./dto";
import { serviceName, parseServiceTasks, parseSwarmTasks, parseServiceImageDigest, type SwarmTask } from "../deploy/service-script";
import { MonitorsService } from "../monitors/monitors.service";
import { NotificationsService } from "../notifications/notifications.service";
import { GitSourcesService, sourceCloneHost } from "../git-sources/git-sources.service";
import {
  buildImageRemoveScriptForTags,
  buildAppImagesRemoveScript,
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
  resolveHealthGate,
  resolveSoak,
  soakRetries,
  defaultSoakFor,
  buildStartScript,
  buildStopScript,
  runTag,
  registryImageRef,
  parseImageDigest,
  parseCommit,
  containerName,
  appVolumeName,
  hasNetworkOpt,
  buildBuildCachePruneScript,
  resolveHealthCheckType,
  internalHostFor,
  tokenizeDockerOptions,
  type AppSpec,
  type AppVolume,
  type HostMount,
  type AppConfigMount,
  type ComposeNetworkRow,
  type RegistryAuth,
} from "../deploy/deploy-script";
import { parseCustomCert, certCoversHost } from "./custom-cert";
import { generateEd25519DeployKey } from "../git-sources/ssh-keygen";
import { assertSafeDockerOptions, dockerOptionLabels, validateHostMounts } from "../deploy/docker-options-safety";
import { assertSafeCustomLabels } from "../deploy/custom-labels";
import { buildAppliedLabels } from "./applied-labels";
import { AppDatabaseLinksService } from "./app-database-links.service";
import { AppSecretRefsService } from "./app-secret-refs.service";
import {
  buildConfigSnapshot,
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
  adoptedCompose,
  composeVolumes,
  composeServiceNames,
  parseContainers,
} from "../deploy/compose-script";
import { parseComposeAdopt, type ComposeAdopt } from "../deploy/compose-adopt";
import {
  generateWebhookSecret,
  generateWebhookToken,
} from "../webhooks/webhook-verify";
import { type TemplateMeta } from "../templates/catalog";
import { TemplateCatalogService } from "../catalog/template-catalog.service";
import { publicManifest, toManifest, validateConfigMountServiceName, validateConfigMountTarget, validateInstallFields, type FormField, type PublicManifest } from "../templates/template-manifest";
import { resolveVariables } from "../templates/template-resolver";
import { rewriteHostPorts, substituteSelfUrls } from "../templates/install-compose";
import { assertSafeCompose, assertSafeEnvFiles } from "../deploy/compose-safety";
import { resolveAlias, validatePushName, validateTagTemplate } from "../deploy/push-ref";
import { composeHookPlan } from "../deploy/compose-hooks";
import {
  buildComposePreviewScript,
  composePreviewCloneRoot,
  parsePreviewError,
  classifyPreviewError,
  PREVIEW_UNSUPPORTED_MARKER,
  redactResolvedCompose,
  type ComposePreviewResult,
} from "../deploy/compose-preview";
import {
  buildComposeGitRenderScript,
  buildComposeGitUpScript,
  parseRenderedCompose,
  composeGitCloneDir,
} from "../deploy/compose-git";
import { PortAllocatorService } from "./port-allocator.service";
import { domainSsl, probeSsl } from "./ssl-probe";
import { AiService } from "./ai.service";
import { TeamDefaultsService } from "../teams/team-defaults.service";
import { normalizeTags } from "../common/tags";
import { appLinks, appUrl, primaryHostPort } from "../common/app-url";
import { magicDomain } from "./magic-domain";
import { inferComposeWeb } from "../deploy/compose-web";
import { appIdOfContainer, liveContainerOf, reduceHealth, UNKNOWN_HEALTH, CONTAINER_STATE_MAX_AGE_MS, type AppContainerHealth } from "./container-health";
import { purgeMoveSource } from "../app-moves/app-move-archive";
import { cpusetExceedsTarget, gpusUnavailableOnTarget, hasHostMounts, privilegedOptionsCarried } from "../app-moves/move-target-fit";
import { cpusetMax } from "./dto";
import { computeImageUpdateView, isImageCheckSubject, ImageUpdateViewSchema, loadLiveImageMany, type LiveImage } from "./image-update";
import { ImageUpdateService } from "./image-update.service";
import { LogDrainPushService } from "../log-drains/log-drain-push.service";
import type { CreateAppInput, SetLimitsInput, SetSourceInput, SetBuildInput, SetContainerCommandInput, SetCustomLabelsInput, AppLabelsView, AppRuntimeState } from "./dto";

const DEPLOY_TIMEOUT_MS = 300_000; // builds can be slow
// stop/start/restart (non-swarm) run no build but a compose restart of several services with a stop grace
// easily exceeds the 20s default; give it headroom so a slow-but-successful restart isn't killed mid-way.
const LIFECYCLE_TIMEOUT_MS = 120_000;
const DEFAULT_DEPLOY_IMAGE_KEEP = 5; // versioned images retained for rollback when an app sets no imagesToKeep
// Default rolling health-gate timing (not yet configurable per app).
// Raw docker flags that make two overlapping containers impossible (port map, own
// network/name/ip, or a shared volume mount) → the app can't roll, so we fall back to hard cutover.
// -v/--volume/--mount: an adopted container carries its named volume this way; two containers writing
// one volume during a rolling overlap would corrupt it, so such apps must hard-cutover.
const RISKY_DOCKER_OPTS = /(^|\s)(--ip6?|-p|--publish|--network|--name|-v|--volume|--mount)(\s|=|$)/;
/** One externally-openable address of an app (always http or https). */
export const AppLinkSchema = z.object({
  kind: z.enum(["primary", "alias", "service", "port"]),
  url: z.string(),
  /** Hostname of a domain-backed link; null for a raw IP:port link. */
  host: z.string().nullable(),
  /** The compose service (`service` links) or `service:containerPort` (`port` links); null otherwise. */
  label: z.string().nullable(),
});

/** Per-call extras `view()` can fold in when the caller already loaded them (list/get batch the service-domain read). */
interface ViewExtras {
  serviceDomains?: { service: string; hostname: string; port: number }[];
  /** Aggregated container health (list/get batch the ContainerState read); absent = `unknown`. */
  health?: AppContainerHealth;
  /** The app's live (latest successful) deploy digest, for the image-update state; absent = no baseline. */
  imageLive?: LiveImage | null;
  /** The app's live (non-terminal) move, when the caller loaded it; absent = no move. */
  move?: { id: string; phase: string } | null;
}

export const AppViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  source: z.enum(["IMAGE", "GIT", "COMPOSE"]),
  image: z.string().nullable(),
  gitUrl: z.string().nullable(),
  gitBranch: z.string().nullable(),
  gitCommit: z.string().nullable(), // pinned commit SHA; null = deploy the branch HEAD
  gitSubmodules: z.boolean(),
  gitLfs: z.boolean(),
  gitShallowClone: z.boolean(),
  disableBuildCache: z.boolean(),
  injectEnvAsBuildArgs: z.boolean(),
  sourceCommitMode: z.enum(["OFF", "RUNTIME", "BUILD"]),
  gitSourceId: z.string().nullable(), // linked GitHub App installation (private-repo token minting), if any
  buildType: z.enum(["NIXPACKS", "DOCKERFILE", "STATIC", "RAILPACK", "HEROKU"]),
  buildCommand: z.string().nullable(),
  nixpacksInstallCmd: z.string().nullable(),
  nixpacksBuildCmd: z.string().nullable(),
  nixpacksStartCmd: z.string().nullable(),
  dockerfilePath: z.string().nullable(), // DOCKERFILE build: path to the Dockerfile inside the repo
  dockerBuildTarget: z.string().nullable(), // DOCKERFILE build: multi-stage target stage
  inlineDockerfile: z.string().nullable(), // DOCKERFILE build: inline Dockerfile text — WRITER-ONLY in view() (may embed tokens)
  hasInlineDockerfile: z.boolean(), // visible to everyone: an inline Dockerfile overrides the repository's
  baseDirectory: z.string().nullable(), // GIT: repo-relative build context/root for monorepos (null = repo root)
  watchPaths: z.array(z.string()), // monorepo deploy-trigger globs (empty = deploy on every push)
  autoDeploy: z.boolean(), // per-app push-to-deploy switch
  imageUpdate: ImageUpdateViewSchema.nullable(), // IMAGE apps only: upstream digest vs deployed digest (null otherwise)
  move: z.object({ id: z.string(), phase: z.string() }).nullable(), // live app move (get/list only); drives the web lock. null = none
  outputDir: z.string().nullable(),
  composeFile: z.string().nullable(),
  composePath: z.string().nullable(), // COMPOSE-from-git: repo-relative path to the compose file (null = pasted compose)
  composeAdopt: z
    .object({
      project: z.string(),
      workingDir: z.string(),
      files: z.array(z.string()),
      services: z.array(z.object({ name: z.string(), image: z.string(), ports: z.array(z.number()) })),
    })
    .nullable(), // COMPOSE adopted in place from a project already running on the server (writer-only: host paths); null = Tugra's own compose
  healthCmd: z.string().nullable(),
  healthCheckType: z.string().nullable(),
  healthCheckPath: z.string().nullable(),
  healthCheckPort: z.number().nullable(),
  healthCheckMethod: z.string().nullable(),
  healthCheckScheme: z.string().nullable(),
  healthCheckResponseText: z.string().nullable(),
  healthInterval: z.number().nullable(),
  healthTimeout: z.number().nullable(),
  healthRetries: z.number().nullable(),
  healthStartPeriod: z.number().nullable(),
  healthExpectedStatus: z.number().nullable(),
  memoryMb: z.number().nullable(),
  cpus: z.number().nullable(),
  reserveMemoryMb: z.number().nullable(),
  reserveCpus: z.number().nullable(),
  memorySwapMb: z.number().int().nullable(),
  pidsLimit: z.number().int().nullable(),
  shmSizeMb: z.number().int().nullable(),
  cpuShares: z.number().int().nullable(),
  cpusetCpus: z.string().nullable(),
  gpus: z.string().nullable(),
  deployTimeoutSec: z.number().nullable(),
  dockerOptions: z.string().nullable(),
  allowPrivilegedDockerOptions: z.boolean(),
  preDeployCommand: z.string().nullable(), // write-gated in view() (exec-power, may embed internal paths)
  postDeployCommand: z.string().nullable(),
  composeHookService: z.string().nullable(), // COMPOSE: the service the hooks run in — write-gated in view()
  composeServices: z.array(z.string()), // COMPOSE (pasted) service names for the hook picker — write-gated; [] for git-compose / other
  // Container command override (exec-form argv) — write-gated in view() (args can embed credentials).
  containerEntrypoint: z.array(z.string()).nullable(),
  containerCommand: z.array(z.string()).nullable(),
  // Operator custom container labels {key: value} — write-gated in view() (values can be tokens); null = none.
  customLabels: z.record(z.string(), z.string()).nullable(),
  restartPolicy: z.string().nullable(), // Docker restart policy; null = the "unless-stopped" default
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
  pushImageName: z.string().nullable(), // custom pushed repo path (null = tugra_<id>)
  pushImageTag: z.string().nullable(), // mutable alias tag template (null = no alias)
  buildServerId: z.string().nullable(),
  clusterId: z.string().nullable(),
  replicas: z.number().nullable(),
  placement: z.object({ constraints: z.array(PlacementConstraintSchema), spreadLabelKey: z.string().nullable() }),
  constraintServerId: z.string().nullable(),
  deployStrategy: z.string(),
  rollbackOnFailure: z.boolean(),
  imagesToKeep: z.number().nullable(),
  postCutoverSoakSec: z.number(), // ROLLING: seconds to keep the previous container after cutover for an auto-revert (0 = off)
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
  // Aggregated Docker container health (from the container-health poll). `unknown` = no fresh data (never alarms).
  containerHealth: z.object({
    state: z.enum(["healthy", "unhealthy", "starting", "none", "unknown"]),
    checkType: z.enum(["CMD", "HTTP", "NONE"]),
    containers: z.number().int(),
    observedAt: z.string().nullable(),
  }),
  hostPort: z.number().nullable(),
  containerPort: z.number().nullable(),
  extraPorts: z.array(z.object({ hostPort: z.number(), containerPort: z.number(), protocol: z.enum(["tcp", "udp"]) })),
  networkAliases: z.array(z.string()),
  stopGracePeriodSec: z.number().nullable(), // graceful-stop window; null = Docker default (10s)
  drainSec: z.number().nullable(), // ROLLING only: seconds both containers serve before the old is stopped
  restartMaxRetries: z.number().nullable(), // on-failure retry cap
  containerAlias: z.string().nullable(), // stable DNS name on every network the app joins
  networks: z.array(z.string()), // extra user Docker networks
  networkingLocked: z.boolean(), // a raw --network in Docker options owns networking: alias/networks can't be set (only cleared)
  // Where other containers reach this app; null when unknown (compose / swarm / an operator-owned --network).
  internalHost: z.object({ host: z.string(), port: z.number(), networks: z.array(z.string()), aliases: z.array(z.string()) }).nullable(),
  domain: z.string().nullable(),
  extraDomains: z.array(z.string()), // additional alias hostnames routed to the same container
  domainRedirect: z.string().nullable(),
  securityHeaders: z.boolean(),
  gzip: z.boolean(),
  forwardAuth: z.string().nullable(),
  ipAllowlist: z.array(z.string()),
  basicAuthUsers: z.array(z.string()), // usernames only — password hashes are never returned
  pathPrefix: z.string().nullable(),
  stripPrefix: z.boolean(),
  dnsChallenge: z.boolean(), // custom-domain certificate issued with DNS-01 per host (see setDomainOptions)
  rateLimit: z.object({ average: z.number(), burst: z.number(), period: z.enum(["1s", "1m", "1h"]) }).nullable(),
  redirects: z.array(z.object({ regex: z.string(), replacement: z.string(), permanent: z.boolean() })),
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
  /** Every openable address, primary first: the primary URL, multi-domain aliases, per-service compose domains and
   *  published compose host ports. Per-service domains are included on `GET /apps` and `GET /apps/:id` only; other
   *  responses carry the primary and aliases. Never secret. */
  links: z.array(AppLinkSchema),
  webhookToken: z.string().nullable(),
  webhookSecret: z.string().nullable(),
  isPreview: z.boolean(),
  previewEnabled: z.boolean(),
  previewExcludeKeys: z.array(z.string()),
  previewLimit: z.number().nullable(),
  prNumber: z.number().nullable(),
  prProvider: z.enum(["github", "gitlab", "gitea", "forgejo", "bitbucket", "bitbucket-server"]).nullable(),
  prHeadSha: z.string().nullable(),
  parentAppId: z.string().nullable(),
  tags: z.array(z.string()),
  volumeBackupEnabled: z.boolean(),
  volumeBackupIntervalHours: z.number().nullable(),
  volumeBackupRetention: z.number(),
  volumeBackupDestinationId: z.string().nullable(),
  envCount: z.number(),
  canWrite: z.boolean(),
  canDeploy: z.boolean(), // apps:deploy — the viewer may trigger deploys / run the image-update check (gates those UI actions)
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
    state: z.enum(["ok", "expiring", "error", "none"]),
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
/** The writer-facing summary of an adopted compose project (host paths, service names and images; never file content). */
function adoptedView(app: { composeAdopt?: unknown }) {
  const a = parseComposeAdopt(app.composeAdopt);
  return a ? { project: a.project, workingDir: a.workingDir, files: a.files.map((f) => f.path), services: a.services.map((x) => ({ name: x.name, image: x.image, ports: x.ports })) } : null;
}

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

/** Safely read the stored basicAuthUsers JSON into a typed [{user, hash}] list (defensive: it is our own
 *  data, but JSON columns are untyped). Drops any malformed entry; returns null when there are none. */
function parseBasicAuthUsers(raw: unknown): { user: string; hash: string }[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.filter(
    (u): u is { user: string; hash: string } =>
      !!u && typeof u === "object" && typeof (u as { user?: unknown }).user === "string" && typeof (u as { hash?: unknown }).hash === "string",
  );
  return out.length ? out.map((u) => ({ user: u.user, hash: u.hash })) : null;
}

/** Safely read the stored extraPorts JSON into a typed list (JSON columns are untyped). Drops malformed
 *  entries + any non-tcp/udp protocol; returns [] when there are none. */
function parseExtraPorts(raw: unknown): { hostPort: number; containerPort: number; protocol: "tcp" | "udp" }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is { hostPort: number; containerPort: number; protocol: string } =>
      !!p && typeof p === "object" && typeof (p as { hostPort?: unknown }).hostPort === "number" && typeof (p as { containerPort?: unknown }).containerPort === "number",
    )
    .map((p) => ({ hostPort: p.hostPort, containerPort: p.containerPort, protocol: p.protocol === "udp" ? "udp" as const : "tcp" as const }));
}

/** Safely read the stored rateLimit JSON into a typed value (JSON columns are untyped). Returns null when
 *  absent or malformed. */
function parseRateLimit(raw: unknown): { average: number; burst: number; period: "1s" | "1m" | "1h" } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { average?: unknown; burst?: unknown; period?: unknown };
  if (typeof r.average !== "number" || typeof r.burst !== "number") return null;
  const period = r.period === "1m" || r.period === "1h" ? r.period : "1s";
  return { average: r.average, burst: r.burst, period };
}

/** Safely read the stored redirects JSON into a typed [{regex, replacement, permanent}] list (JSON columns
 *  are untyped). Drops any malformed entry; returns [] when there are none. */
function parseRedirects(raw: unknown): { regex: string; replacement: string; permanent: boolean }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (rd): rd is { regex: string; replacement: string; permanent?: unknown } =>
        !!rd && typeof rd === "object" && typeof (rd as { regex?: unknown }).regex === "string" && typeof (rd as { replacement?: unknown }).replacement === "string",
    )
    .map((rd) => ({ regex: rd.regex, replacement: rd.replacement, permanent: rd.permanent === true }));
}

/** 409 "a deployment is already running" — a distinct class so a programmatic caller (the fleet rollout engine)
 *  can tell "retry later" apart from every other conflict. Same HTTP shape as before for interactive callers. */
export class AppBusyException extends ConflictException {
  constructor() {
    super("a deployment is already running");
  }
}

/** Added to the agent timeout (+ soak budget) for a durable deploy's recovery deadline: an unadopted row past it
 *  settles as interrupted. Generous — the agent itself kills the command at ITS timeout, long before. */
export const DISPATCH_DEADLINE_SLACK_MS = 120_000;
/** Build-server phase output kept in the dispatch plan (head: the commit marker is printed right after the clone). */
const BUILD_LOG_HEAD_BYTES = 16 * 1024;

@Injectable()
export class ApplicationsService {
  // In-flight deploy commands by deployment id → the agent server + reqId currently running, so a RUNNING
  // deploy can be cancelled (the reqId's process group is SIGKILLed on the agent). Set when executeDeploy
  // dispatches a deploy-capability command, cleared when the deploy finishes. Non-swarm only — a swarm
  // rollout doesn't go through sendCommand, so it is never tracked here (and so can't be cancelled yet).
  private readonly activeDeployCommands = new Map<string, { serverId: string; reqId: string }>();
  // Deployment ids for which a cancel was requested — executeDeploy records the result as CANCELLED (not
  // FAILED) and skips auto-rollback classification + the failure notification.
  private readonly cancelRequested = new Set<string>();
  private readonly logger = new Logger(ApplicationsService.name);
  // Registered by DeployRecoveryService: fired when a dispatched deploy's lease is released because the agent's
  // socket dropped mid-command, so adoption can start at once if the agent is already back (the reconnect hook
  // alone can miss it: adoptSocket rejects our pending BEFORE the hook fires).
  private leaseReleasedHook?: (serverId: string) => void;

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
    private readonly secretRefs: AppSecretRefsService,
    private readonly moduleRef: ModuleRef,
    private readonly lease: DeployLeaseService,
    private readonly imageUpdate: ImageUpdateService,
    private readonly logDrainPush: LogDrainPushService,
  ) {}

  /** DeployRecoveryService registers here (see leaseReleasedHook). */
  setLeaseReleasedHook(fn: (serverId: string) => void): void {
    this.leaseReleasedHook = fn;
  }

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
      if (!gs || !(await this.canLinkGitSource(userId, gs, server.teamId))) throw new BadRequestException("git source not found in this team");
      this.assertSourceHost(gs, dto.gitUrl);
    }

    const source = dto.source ?? "IMAGE";
    // Per-variable flags + the line-break/NUL invariant, validated against the real source (zod ran context-free).
    const createMeta = normalizeFlags(dto.envFlags ?? {}, Object.keys(dto.env ?? {}));
    const createIssues = validateEnvFlags(dto.env ?? {}, createMeta, { source, mode: "write" });
    if (createIssues.length) throw new BadRequestException(createIssues[0].message);
    // COMPOSE is either pasted (composeFile) or sourced from git (gitUrl + composePath) — the DTO guarantees
    // exactly one. A git-compose stack has no stored YAML to validate here; it is cloned, rendered and
    // validated (assertSafeCompose over the rendered config) at deploy time instead.
    const isGitCompose = source === "COMPOSE" && !!dto.gitUrl;
    // A user-pasted compose must be validated for host escape, ALWAYS. templateSlug is client-settable on
    // this endpoint, so exempting it (the old `!dto.templateSlug`) let a caller skip the guard by pairing an
    // arbitrary composeFile with any slug. Curated templates install through a separate, server-controlled
    // path (installTemplate) that builds the compose from the trusted catalog manifest and never trusts a
    // client composeFile — so they do not need (and must not get) an exemption here.
    if (source === "COMPOSE" && dto.composeFile) assertSafeCompose(dto.composeFile);
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
        postCutoverSoakSec: defaultSoakFor(source), // new apps soak by default (30 s; compose never rolls → 0); existing rows untouched
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
        envMetaEnc: this.encryptMeta(createMeta),
        gitTokenEnc: dto.gitToken ? this.crypto.encrypt(dto.gitToken) : null,
        gitSshKeyEnc: sshKey ? this.crypto.encrypt(sshKey.privateKeyOpenSsh) : null,
        gitSshPublicKey: sshKey?.publicKey ?? null,
        hostPort: dto.hostPort ?? null,
        // Defense in depth: the HTTP create path is zod-bounded (1..65535), but internal callers (the
        // importer) call create() directly with a raw value, so coerce an out-of-range/missing port to the
        // default 80 rather than persist a value that would break `docker run -p`/the Traefik port label.
        containerPort: dto.containerPort && dto.containerPort >= 1 && dto.containerPort <= 65535 ? dto.containerPort : 80,
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

  /**
   * Register a compose project that already runs on the server as a Tugra compose app, WITHOUT deploying or touching a
   * container: the row carries the project name, working dir and host config files (see deploy/compose-adopt.ts), so
   * later deploys run `docker compose -p <project>` on those same files. Called by the migrator, which has already
   * validated the registration against a fresh inspect of the host and enforced owner/admin.
   */
  async createAdoptedCompose(
    userId: string,
    input: { serverId: string; name: string; environmentId?: string; adopt: ComposeAdopt; running: boolean },
  ): Promise<AppView> {
    const server = await this.prisma.server.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException("server not found");
    await this.access.requirePermission(userId, server.teamId, "apps:config");
    if (input.environmentId) await this.assertEnvInTeam(input.environmentId, server.teamId);
    const environmentId = input.environmentId ?? (await this.teamDefaults.resolveDefaultEnvironmentId(server.teamId));
    const app = await this.prisma.application.create({
      data: {
        name: input.name,
        environmentId,
        source: "COMPOSE",
        postCutoverSoakSec: defaultSoakFor("COMPOSE"),
        gitBranch: "main",
        buildType: "NIXPACKS",
        composeAdopt: input.adopt as unknown as Prisma.InputJsonValue,
        serverId: input.serverId,
        teamId: server.teamId,
        env: {} as Prisma.InputJsonValue,
        envEnc: this.crypto.encrypt(JSON.stringify({})),
        envMetaEnc: this.encryptMeta(normalizeFlags({}, [])),
        containerPort: 80,
        domain: null,
        https: true,
        exposeMode: "none",
        domainKind: "none",
        certType: "http",
        status: input.running ? AppStatus.RUNNING : AppStatus.STOPPED,
        tags: normalizeTags(["adopted"]),
        webhookToken: generateWebhookToken(),
        webhookSecret: this.crypto.encrypt(generateWebhookSecret()),
      },
    });
    return this.finishCreate(app, userId, server.teamId, false, server.publicIp ?? server.publicIpv6);
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
  async clone(userId: string, id: string, input: { name?: string; serverId?: string; environmentId?: string }): Promise<{ app: AppView; warnings: string[] }> {
    const src = await this.require(userId, id);
    if (src.isPreview) throw new BadRequestException("a preview app can't be cloned");
    // A copy would be a compose app with no file (the adopted files live on the host and belong to the one project).
    if (adoptedCompose(src)) throw new BadRequestException("a stack adopted in place can't be cloned");
    await this.access.requirePermission(userId, src.teamId, "apps:config");
    // Target environment: the source's own by default, or a chosen one that must be in the same team
    // (environment clone places the copy in a new environment).
    const environmentId = input.environmentId ?? src.environmentId;
    if (input.environmentId && input.environmentId !== src.environmentId) {
      await this.assertEnvAccess(userId, input.environmentId, src.teamId);
    }
    // Target server: the source's own by default, or a chosen one that MUST be in the same team (no
    // cross-team clone). A different target resets the server-bound topology (cluster/placement/host ports).
    const targetServerId = input.serverId ?? src.serverId;
    const server = await this.prisma.server.findUnique({ where: { id: targetServerId } });
    if (!server) throw new NotFoundException("server not found");
    if (server.teamId !== src.teamId) throw new ForbiddenException("target server is in another team");
    const crossServer = server.id !== src.serverId;

    const warnings: string[] = [];
    if (crossServer) warnings.push("cloned_to_server");
    if (crossServer && src.clusterId) warnings.push("cluster_config_reset");
    // Host bind mounts point at paths on the SOURCE machine; carried over, but they may not exist (or hold
    // different data) on the target — docker would create an empty dir. Flag it so the operator checks.
    if (crossServer && hasHostMounts(src.hostMounts)) warnings.push("host_mounts_copied");
    if (privilegedOptionsCarried(src)) {
      warnings.push("privileged_options_dropped");
    }
    // Custom container labels are not privilege-bearing, so (unlike dockerOptions) they carry over to a classic or
    // swarm clone. A COMPOSE app cannot hold them (labels live in its YAML), so a stray value is dropped with a flag.
    const srcCustomLabels = this.storedCustomLabels(src.customLabels);
    if (srcCustomLabels && src.source === "COMPOSE") warnings.push("custom_labels_dropped");
    // CPU pinning is host-specific: a cpuset naming a core the target doesn't have would fail the first deploy.
    // Reset it only when the target's core count is known and the set doesn't fit (unknown → Docker decides).
    const cpusetReset = crossServer && cpusetExceedsTarget(src.cpusetCpus, server.cpuCores);
    if (cpusetReset) warnings.push("cpuset_reset");
    // GPUs are host hardware: a GPU request is KEPT (never reset) but flagged when the target is known to have no
    // usable NVIDIA GPU. An unprobed target (NULL inventory) is unknown and never warns.
    if (crossServer && gpusUnavailableOnTarget(src, server.gpuInventory)) warnings.push("gpus_unavailable_on_target");
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
          description: src.description,
          teamId: src.teamId,
          serverId: server.id,
          environmentId,
          buildServerId: src.buildServerId,
          // Same server keeps the stateful swarm pin; a cross-server clone resets it — the cluster/placement/
          // constraint topology and replica count belong to the source server's set, not the new standalone one.
          clusterId: crossServer ? null : src.clusterId,
          replicas: crossServer ? 1 : src.replicas,
          placement: crossServer ? Prisma.JsonNull : jsonOrNull(src.placement),
          constraintServerId: crossServer ? null : src.constraintServerId,
          templateSlug: src.templateSlug,
          source: src.source,
          image: src.image,
          gitUrl: src.gitUrl,
          gitBranch: src.gitBranch,
          gitCommit: src.gitCommit, // clone keeps the pinned commit (same repo)
          gitSourceId: src.gitSourceId,
          buildType: src.buildType,
          dockerfilePath: src.dockerfilePath,
          dockerBuildTarget: src.dockerBuildTarget,
          inlineDockerfile: src.inlineDockerfile, // the clone builds the same way (pushImageName/pushImageTag are NOT copied: unique repo + a mutable alias must not be shared)
          baseDirectory: src.baseDirectory,
          gitSubmodules: src.gitSubmodules,
          gitLfs: src.gitLfs,
          gitShallowClone: src.gitShallowClone,
          disableBuildCache: src.disableBuildCache,
          injectEnvAsBuildArgs: src.injectEnvAsBuildArgs,
          sourceCommitMode: src.sourceCommitMode,
          buildCommand: src.buildCommand,
          outputDir: src.outputDir,
          nixpacksInstallCmd: src.nixpacksInstallCmd,
          nixpacksBuildCmd: src.nixpacksBuildCmd,
          nixpacksStartCmd: src.nixpacksStartCmd,
          watchPaths: src.watchPaths, // keep the clone's monorepo deploy-trigger globs
          autoDeploy: src.autoDeploy,
          imageUpdateCheck: src.imageUpdateCheck, // the opt-out is config; the probe state stays at its defaults
          composeFile: src.composeFile,
          composePath: src.composePath, // keep a cloned git-compose app git-sourced
          healthCmd: src.healthCmd,
          healthCheckType: src.healthCheckType,
          healthCheckPath: src.healthCheckPath,
          healthCheckPort: src.healthCheckPort,
          healthCheckMethod: src.healthCheckMethod,
          healthCheckScheme: src.healthCheckScheme,
          healthCheckResponseText: src.healthCheckResponseText,
          healthInterval: src.healthInterval,
          healthTimeout: src.healthTimeout,
          healthRetries: src.healthRetries,
          healthStartPeriod: src.healthStartPeriod,
          healthExpectedStatus: src.healthExpectedStatus,
          memoryMb: src.memoryMb,
          cpus: src.cpus,
          reserveMemoryMb: src.reserveMemoryMb,
          reserveCpus: src.reserveCpus,
          memorySwapMb: src.memorySwapMb,
          pidsLimit: src.pidsLimit,
          shmSizeMb: src.shmSizeMb,
          cpuShares: src.cpuShares,
          cpusetCpus: cpusetReset ? null : src.cpusetCpus,
          gpus: src.gpus,
          deployTimeoutSec: src.deployTimeoutSec,
          preDeployCommand: src.preDeployCommand,
          composeHookService: src.composeHookService,
          postDeployCommand: src.postDeployCommand,
          containerEntrypoint: jsonOrNull(src.containerEntrypoint),
          containerCommand: jsonOrNull(src.containerCommand),
          customLabels: srcCustomLabels && src.source !== "COMPOSE" ? (srcCustomLabels as Prisma.InputJsonValue) : Prisma.DbNull,
          restartPolicy: src.restartPolicy,
          restartMaxRetries: src.restartMaxRetries,
          stopGracePeriodSec: src.stopGracePeriodSec,
          drainSec: src.drainSec,
          networks: src.networks ?? [],
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
          envMetaEnc: src.envMetaEnc,
          buildArgsEnc: src.buildArgsEnc,
          buildSecretsEnc: src.buildSecretsEnc,
          // The clone resets to non-privileged (allowPrivilegedDockerOptions defaults false), so NEVER copy
          // host-privileged options into it — they'd be unrunnable (deploy re-validates) and a silent escalation.
          dockerOptions: src.allowPrivilegedDockerOptions ? null : src.dockerOptions,
          // Node-local DB-network opt-in is an invariant with same-server managed-DB links (not cloned), so a
          // cross-server clone would hold dbNetwork=true with zero links on a server that may have no managed
          // DB — reset it (the operator re-enables it after linking a DB on the new server).
          dbNetwork: crossServer ? false : src.dbNetwork,
          // A copied host port would clash on the same server; cleared (re-allocation is a follow-up).
          hostPort: null,
          // Network aliases are reset, NOT copied: a duplicate alias on the shared user-defined network
          // would round-robin between the source and the clone. The operator re-adds any it wants.
          networkAliases: [],
          // The stable container alias is reset for the same reason (and (serverId, containerAlias) is unique, so a
          // same-server clone would violate the index).
          containerAlias: null,
          containerPort: src.containerPort,
          domain: expose.domain,
          https: expose.https,
          exposeMode: expose.exposeMode,
          domainKind: expose.domainKind,
          certType: expose.certType,
          domainRedirect: src.domainRedirect,
          securityHeaders: src.securityHeaders,
          gzip: src.gzip,
          forwardAuth: src.forwardAuth,
          ipAllowlist: src.ipAllowlist,
          basicAuthUsers: src.basicAuthUsers ?? Prisma.JsonNull, // clone the auth users (hashes only)
          pathPrefix: src.pathPrefix,
          stripPrefix: src.stripPrefix,
          rateLimit: src.rateLimit ?? Prisma.JsonNull,
          redirects: src.redirects ?? Prisma.JsonNull, // clone the custom redirect rules
          deployStrategy: src.deployStrategy,
          rollbackOnFailure: src.rollbackOnFailure,
          imagesToKeep: src.imagesToKeep,
          postCutoverSoakSec: src.postCutoverSoakSec,
          tags: src.tags,
          iconUpdatedAt: icon ? new Date() : null,
          // A fresh webhook (the token is unique; sharing it would double-trigger + collide on the unique index).
          webhookToken: generateWebhookToken(),
          webhookSecret: this.crypto.encrypt(generateWebhookSecret()),
          volumeBackupIntervalHours: src.volumeBackupIntervalHours,
          volumeBackupRetention: src.volumeBackupRetention,
          volumeBackupDestinationId: src.volumeBackupDestinationId,
          volumeBackupCron: src.volumeBackupCron,
          volumeBackupRetentionDays: src.volumeBackupRetentionDays,
          volumeBackupMaxSizeGb: src.volumeBackupMaxSizeGb,
          // Defaults left as-is: status NEW (not deployed), isPreview/previewEnabled false, cert* null,
          // tunnelExposed false, volumeBackupEnabled false.
        },
      });
      if (icon) {
        await tx.appIcon.create({ data: { appId: app.id, mime: icon.mime, data: icon.data, sizeBytes: icon.sizeBytes } });
      }
      // Per-volume backup policies come along; the clone itself stays volumeBackupEnabled:false, so they are inert
      // (no job is scheduled for them until the operator enables volume backups on the clone).
      const policies = await tx.volumeBackupPolicy.findMany({ where: { appId: src.id } });
      if (policies.length > 0) {
        await tx.volumeBackupPolicy.createMany({
          data: policies.map((p) => ({
            appId: app.id,
            volumeName: p.volumeName,
            enabled: p.enabled,
            intervalHours: p.intervalHours,
            cron: p.cron,
            retention: p.retention,
            retentionDays: p.retentionDays,
            maxSizeGb: p.maxSizeGb,
          })),
        });
      }
      const tasks = await tx.scheduledTask.findMany({ where: { appId: src.id } });
      if (tasks.length > 0) {
        // Copied DISABLED, so the clone never double-runs the source's crons until the user enables them.
        await tx.scheduledTask.createMany({
          data: tasks.map((t) => ({ appId: app.id, name: t.name, schedule: t.schedule, command: t.command, timeoutSec: t.timeoutSec, enabled: false })),
        });
        warnings.push("tasks_disabled");
      }
      return app;
    });

    await this.access.grantResourceAccess(userId, src.teamId, created.id);
    await this.monitors.createForApp(created).catch(() => undefined);
    await this.audit.log({ actor: userId, action: "app.clone", target: created.id, meta: { sourceId: src.id, environmentId } });
    const perms = await this.access.membershipPermissions(userId, src.teamId);
    const app = this.view(created, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, undefined, server.publicIp ?? server.publicIpv6);
    return { app, warnings };
  }

  /** Generate (or rotate) an ed25519 SSH deploy key for an ssh:// / git@ repo. Returns only the PUBLIC key
   *  + fingerprint — the private key is encrypted at rest and never leaves the server. The operator adds the
   *  public key to the repo as a read-only deploy key, then deploys. */
  async generateGitSshKey(userId: string, id: string): Promise<{ publicKey: string; fingerprint: string }> {
    const app = await this.requireWrite(userId, id);
    const gitSourced = app.source === "GIT" || (app.source === "COMPOSE" && !!app.composePath && !!app.gitUrl);
    if (!gitSourced || !isSshGitUrl(app.gitUrl ?? "")) {
      throw new BadRequestException("a deploy key applies to a Git-sourced app with an ssh:// or git@ repository URL");
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
          postCutoverSoakSec: 0, // a compose app never rolls, so a soak window would only mislead
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
    const healthById = await this.loadHealthMany(apps);
    // Per-resource scoping: a restricted member only sees apps in projects they're granted.
    const visible = apps.filter((a) => canAccessResource(access.get(a.teamId), a.id, ctxByEnv.get(a.environmentId)?.projectId ?? null));
    // Image-update state: ONE batched live-digest query for the enabled IMAGE apps of the page (no N+1).
    const liveById = await this.loadImageLiveMany(visible);
    // Per-service domains feed the `links` field: one batched read for the visible compose apps, none otherwise.
    const domainsByApp = await this.loadServiceDomainsMany(visible.filter((a) => a.source === "COMPOSE").map((a) => a.id));
    // Live app moves of the page in ONE query (the web lock + list badge); none for almost every app.
    const moves = visible.length
      ? await this.prisma.appMove.findMany({ where: { appId: { in: visible.map((a) => a.id) }, phase: { notIn: APP_MOVE_TERMINAL } }, select: { appId: true, id: true, phase: true } })
      : [];
    const moveByApp = new Map(moves.map((m) => [m.appId, { id: m.id, phase: m.phase as string }]));
    const views = visible.map((a) =>
      this.view(a, perms.get(a.teamId)?.has("apps:config") ?? false, perms.get(a.teamId)?.has("apps:deploy") ?? false, ctxByEnv.get(a.environmentId), ipByServer.get(a.serverId) ?? null, { serviceDomains: domainsByApp.get(a.id) ?? [], health: healthById.get(a.id), imageLive: liveById.get(a.id), move: moveByApp.get(a.id) ?? null }),
    );
    // `?q`: in-memory substring filter over non-secret fields of the already-authorized views.
    return filterByQuery(views, q, (a) => [a.name, a.domain, a.image, a.gitUrl, a.templateSlug]);
  }

  async get(userId: string, id: string): Promise<AppView> {
    const app = await this.require(userId, id);
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    const ctx = await loadProjectCtx(this.prisma, app.environmentId);
    // Per-service domains are non-secret routing facts every viewer sees as links; reading them is not write-gated
    // (only the dedicated service-domains endpoint is). Only a compose app can have any.
    const serviceDomains = app.source === "COMPOSE" ? await this.loadServiceDomains(app.id) : [];
    return this.view(app, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, ctx, await this.serverIp(app.serverId), { serviceDomains, health: await this.loadHealth(app), imageLive: await this.loadImageLive(app), move: await findActiveMove(this.prisma, app.id) });
  }

  async deploy(userId: string, id: string, opts?: { noCache?: boolean }, idempotencyKey?: string) {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    // No 409 on a busy app any more: submitDeploy queues it and runs it when the current deploy finishes.
    // idempotencyKey (the client's Idempotency-Key header) is the DURABLE at-most-once enqueue backstop; it is
    // null for every non-interactive caller (webhook/preview/first-deploy/MCP) → no constraint → unchanged.
    // The `rollout:` namespace is reserved for the fleet rollout engine's dispatch keys (same (appId, key) index).
    if (idempotencyKey?.trim().startsWith("rollout:")) throw new BadRequestException("Idempotency-Key values starting with 'rollout:' are reserved");
    // `move:` is the app-move runner's own dispatch namespace (move:<moveId> = the deploy a move runs on the target).
    if (idempotencyKey?.trim().startsWith("move:")) throw new BadRequestException("Idempotency-Key values starting with 'move:' are reserved");
    return this.submitDeploy(app, userId, opts?.noCache ?? false, idempotencyKey ?? null);
  }

  /**
   * Build the app's image on its own server WITHOUT starting anything (guided-migration "early build": the image layers are
   * cached long before the downtime window, so the later real deploy only starts it). Only a classic GIT build on the app's own
   * server is built; everything else (image pulls, compose stacks, swarm services, apps with a separate build server) has no
   * local build to warm and answers `{ built: false, reason }`. It creates NO deployment row, never touches the running
   * container and is safe to repeat (docker's cache makes a repeat cheap). The image keeps one fixed local tag
   * (`<container>:prebuild`), so repeats never accumulate tags.
   */
  async prebuild(userId: string, id: string): Promise<{ built: boolean; reason?: "not-git" | "swarm" | "build-server" }> {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    if (app.source !== "GIT") return { built: false, reason: "not-git" };
    if (app.clusterId) return { built: false, reason: "swarm" };
    if (app.buildServerId) return { built: false, reason: "build-server" };
    assertSafeDockerOptions(app.dockerOptions, { allowPrivileged: app.allowPrivilegedDockerOptions });
    this.assertStoredCustomLabels(app);
    const spec = this.toSpec(app);
    this.logAutoMultiline(app.id, (await this.attachResolvedEnv(app, spec, { withBuild: true })).autoMultiline);
    spec.buildSecrets = this.appBuildSecrets(app);
    if (app.buildType === "DOCKERFILE" && app.injectEnvAsBuildArgs) injectableBuildArgs(spec);
    if (app.gitSourceId) spec.gitToken = await this.gitSources.cloneToken(app.gitSourceId, app.gitUrl);
    const res = await this.agentWs.sendCommand(app.serverId, buildBuildOnlyScript(spec, "prebuild", app.disableBuildCache), "deploy", this.deployTimeoutMs(app));
    if (res.exitCode !== 0) {
      await this.audit.log({ actor: userId, action: "app.prebuild_failed", target: app.id, meta: { exitCode: res.exitCode } });
      throw new ServiceUnavailableException(`the early build failed (exit ${res.exitCode})`);
    }
    await this.audit.log({ actor: userId, action: "app.prebuild", target: app.id });
    return { built: true };
  }

  /** One RUNNING deploy per app at a time (keeps the live-log stream unambiguous). Still used by rollback and
   *  the config-edit guards; the deploy queue enforces the same invariant via claimNext + the partial index. */
  private async ensureNoActiveDeploy(appId: string): Promise<void> {
    const running = await this.prisma.deployment.findFirst({
      where: { appId, status: "RUNNING" },
    });
    if (running) throw new AppBusyException();
    await assertNoActiveMove(this.prisma, appId); // a live move pauses every config-edit path that calls this
  }

  /** Create the RUNNING row for a rollback. Rollback doesn't go through the deploy queue, so it relies on the
   *  one-running-per-app partial unique index as the backstop — map its violation (a deploy claimed RUNNING
   *  in the race after ensureNoActiveDeploy) to a clean 409 instead of a raw Prisma error. */
  private async createRollbackDeployment(appId: string, extra: { idempotencyKey?: string; trigger?: string; requestedBy?: string } = {}): Promise<Deployment> {
    try {
      return await this.prisma.deployment.create({
        data: {
          appId,
          status: "RUNNING",
          kind: "ROLLBACK",
          trigger: extra.trigger ?? "rollback",
          startedAt: new Date(),
          ownerId: this.lease.bootId,
          heartbeatAt: new Date(),
          phase: "CLAIMED",
          ...(extra.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}),
          ...(extra.requestedBy ? { requestedBy: extra.requestedBy } : {}),
        },
      });
    } catch (e) {
      // The idempotency-key violation is the detached caller's to handle (it adopts the existing row).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && !String(e.meta?.target ?? "").includes("idempotencyKey")) {
        throw new AppBusyException();
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
  async upsertPreview(
    parent: Application,
    prNumber: number,
    headRef: string,
    opts?: { provider?: PrProvider; headSha?: string | null; onlyIfHeadChanged?: boolean },
  ) {
    if (!parent.previewEnabled || !parent.domain) return;
    // A move is relocating the parent: a preview created now would land on the old server and block the move's
    // preflight (previews_exist). The webhook is answered; the preview is simply skipped until the move is over.
    if (await findActiveMove(this.prisma, parent.id)) {
      await this.audit.log({ actor: "webhook:pr", action: "preview.skipped", target: parent.id, meta: { prNumber, reason: "app-move-in-progress" } });
      return;
    }
    // Previews clone the parent's git repo by branch; a COMPOSE / IMAGE parent would produce a broken preview
    // (composePath is not copied, an image has no branch). The API refuses enabling them, this guards old rows.
    if (parent.source !== "GIT" || !parent.gitUrl) {
      await this.audit.log({ actor: "webhook:pr", action: "preview.skipped", target: parent.id, meta: { prNumber, reason: "unsupported-source" } });
      return;
    }
    const existing = await this.prisma.application.findFirst({
      where: { parentAppId: parent.id, prNumber },
    });
    // Preview cap: when the parent limits concurrent previews and this is a NEW one at the cap, evict the
    // oldest preview(s) first so a flood of open PRs can't spin unbounded preview containers. The newest PR
    // always gets a preview; limit <= 0 / null = unlimited (unchanged).
    if (!existing && parent.previewLimit && parent.previewLimit > 0) {
      const current = await this.prisma.application.findMany({
        where: { parentAppId: parent.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, prNumber: true },
      });
      const evict = current.slice(0, Math.max(0, current.length - (parent.previewLimit - 1)));
      for (const e of evict) {
        if (e.prNumber != null) {
          await this.removePreviewByPr(parent.id, e.prNumber).catch(async (err: unknown) => {
            // An eviction that fails (agent offline) keeps its row and so keeps counting toward the cap — surface it.
            try {
              await this.audit.log({
                actor: "webhook:pr",
                action: "preview.evict_failed",
                target: parent.id,
                meta: { parentAppId: parent.id, prNumber: e.prNumber, error: String(err instanceof Error ? err.message : err).slice(0, 300) },
              });
            } catch {
              /* never let the audit trail turn an eviction failure into a rejection */
            }
          });
        }
      }
    }
    const previewDomain = `pr${prNumber}.${this.baseDomain(parent.domain)}`;
    const headSha = opts?.headSha ?? null;
    const refLabel = opts?.provider === "gitlab" ? "MR !" : "PR #";
    // Two near-simultaneous deliveries for the SAME PR would both miss `existing` and both create. A per-(parent, PR)
    // advisory xact lock serialises just that pair (unrelated PRs don't wait): the loser re-finds the winner's row.
    const { preview, skip } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`preview:${parent.id}:${prNumber}`}))`;
      const found = await tx.application.findFirst({
        where: { parentAppId: parent.id, prNumber, isPreview: true },
      });
      if (found && opts?.onlyIfHeadChanged && headSha && found.prHeadSha === headSha) {
        return { preview: found, skip: true };
      }
      if (found) {
        // Re-sync the head branch (a PR can be retargeted) and the ingress container port (the parent's may
        // have been edited after this preview was created) before redeploying — a preview tracks its parent.
        const updated = await tx.application.update({
          where: { id: found.id },
          data: {
            gitBranch: headRef,
            gitCommit: null, // a preview tracks the PR head, never a pinned commit
            containerPort: parent.containerPort,
            ...(opts?.provider ? { prProvider: opts.provider } : {}),
            prHeadSha: headSha,
          },
        });
        return { preview: updated, skip: false };
      }
      // Copy the parent's env MINUS any keys it marks preview-excluded, so prod secrets never land in an
      // ephemeral preview. No exclusions → reuse the parent blob verbatim (byte-identical to before).
      const exclude = parent.previewExcludeKeys ?? [];
      const previewEnv =
        exclude.length && parent.envEnc ? Object.fromEntries(Object.entries(this.appEnv(parent)).filter(([k]) => !exclude.includes(k))) : null;
      const previewEnvEnc = previewEnv ? this.crypto.encrypt(JSON.stringify(previewEnv)) : parent.envEnc;
      // The flags follow the surviving keys; no exclusions -> the parent's blob verbatim (byte-identical to the env).
      const previewEnvMetaEnc = previewEnv ? this.encryptMeta(pruneMeta(this.loadMetaOrConflict(parent), Object.keys(previewEnv))) : parent.envMetaEnc;
      const created = await tx.application.create({
        data: {
          name: `${parent.name} · ${refLabel}${prNumber}`,
          teamId: parent.teamId,
          serverId: parent.serverId,
          environmentId: parent.environmentId,
          source: parent.source,
          postCutoverSoakSec: 0, // a preview is disposable and redeploys per push; a default soak would only slow every PR push
          image: parent.image,
          gitUrl: parent.gitUrl,
          gitSourceId: parent.gitSourceId, // keep the GitHub-App link so a private-repo preview can mint a clone token
          gitBranch: headRef,
          // gitCommit deliberately not copied: a preview builds the PR head, not the parent's pinned commit.
          buildType: parent.buildType,
          dockerfilePath: parent.dockerfilePath,
          dockerBuildTarget: parent.dockerBuildTarget,
          inlineDockerfile: parent.inlineDockerfile, // a preview must build with the parent's inline Dockerfile, not the repo default
          baseDirectory: parent.baseDirectory, // a monorepo preview must build the same subdirectory as its parent
          // a preview builds the parent's way (shallow/no-cache/build-args/source-commit) EXCEPT submodules and LFS:
          // the preview builds a PR author's head, and its .gitmodules / .lfsconfig can point at attacker-chosen
          // repos on the same git host, which the app's token would authenticate to. So previews never clone either.
          gitSubmodules: false,
          gitLfs: false,
          gitShallowClone: parent.gitShallowClone,
          disableBuildCache: parent.disableBuildCache,
          injectEnvAsBuildArgs: parent.injectEnvAsBuildArgs,
          sourceCommitMode: parent.sourceCommitMode,
          buildCommand: parent.buildCommand,
          outputDir: parent.outputDir,
          // A preview must build the same way as its parent — carry the Nixpacks command overrides too
          // (build config, no collision; else the preview would fall back to Nixpacks auto-detect).
          nixpacksInstallCmd: parent.nixpacksInstallCmd,
          nixpacksBuildCmd: parent.nixpacksBuildCmd,
          nixpacksStartCmd: parent.nixpacksStartCmd,
          // A preview must start the same command as its parent.
          containerEntrypoint: (parent.containerEntrypoint ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          containerCommand: (parent.containerCommand ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          restartPolicy: parent.restartPolicy, // a preview runs with the same restart policy as its parent
          restartMaxRetries: parent.restartMaxRetries, // …and the same on-failure cap (else an on-failure preview is unbounded)
          stopGracePeriodSec: parent.stopGracePeriodSec,
          // NOT copied: containerAlias (collides), networks (like dbNetwork, previews don't inherit), drainSec (previews never drain).

          composeFile: parent.composeFile,
          healthCmd: parent.healthCmd,
          healthCheckType: parent.healthCheckType,
          healthCheckPath: parent.healthCheckPath,
          healthCheckPort: parent.healthCheckPort,
          healthCheckMethod: parent.healthCheckMethod,
          healthCheckScheme: parent.healthCheckScheme,
          healthCheckResponseText: parent.healthCheckResponseText,
          memoryMb: parent.memoryMb,
          cpus: parent.cpus,
          reserveMemoryMb: parent.reserveMemoryMb,
          reserveCpus: parent.reserveCpus,
          memorySwapMb: parent.memorySwapMb,
          pidsLimit: parent.pidsLimit,
          shmSizeMb: parent.shmSizeMb,
          cpuShares: parent.cpuShares,
          cpusetCpus: parent.cpusetCpus,
          gpus: parent.gpus,
          volumes: (parent.volumes ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          gitTokenEnc: parent.gitTokenEnc,
          gitSshKeyEnc: parent.gitSshKeyEnc, // preview clones the same repo → reuse the parent's deploy key
          gitSshPublicKey: parent.gitSshPublicKey,
          registryAuthEnc: parent.registryAuthEnc,
          env: {} as Prisma.InputJsonValue,
          envEnc: previewEnvEnc,
          envMetaEnc: previewEnvMetaEnc,
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
          prProvider: opts?.provider ?? null,
          prHeadSha: headSha,
        },
      });
      return { preview: created, skip: false };
    });
    if (skip) {
      await this.audit.log({
        actor: "webhook:pr",
        action: "preview.skipped",
        target: preview.id,
        meta: { parentAppId: parent.id, prNumber, reason: "head-unchanged" },
      });
      return undefined;
    }
    await this.audit.log({
      actor: "webhook:pr",
      action: "preview.deploy",
      target: preview.id,
      meta: { parentAppId: parent.id, prNumber, headRef, provider: opts?.provider ?? null, headSha },
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
    const healthById = await this.loadHealthMany(previews);
    return previews.map((p) =>
      this.view(p, parentPerms?.has("apps:config") ?? false, parentPerms?.has("apps:deploy") ?? false, undefined, ipByServer.get(p.serverId) ?? null, { health: healthById.get(p.id) }),
    );
  }

  /** Toggle per-PR previews on a parent app — requires a domain to build URLs. Optionally set the env keys
   *  to drop from a preview's copied env (so prod secrets never leak into an ephemeral preview). */
  async setPreviewEnabled(userId: string, id: string, enabled: boolean, excludeEnvKeys?: string[], limit?: number | null): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (enabled && app.source !== "GIT") {
      throw new BadRequestException("previews need a Git-built app");
    }
    if (enabled && !app.domain) {
      throw new BadRequestException("set a domain on the app before enabling previews");
    }
    await this.prisma.application.update({
      where: { id },
      data: {
        previewEnabled: enabled,
        ...(excludeEnvKeys !== undefined ? { previewExcludeKeys: excludeEnvKeys } : {}),
        ...(limit !== undefined ? { previewLimit: limit } : {}),
      },
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
    // Also reclaim the preview's OWN images: a closed PR's tugra_<previewId>:* tags would otherwise linger on
    // the host forever (the scoped cleanup never touches tagged images). A COMPOSE preview has no single tag.
    const steps = [buildRemoveScript(app, this.appVolumes(app))];
    if (app.source !== "COMPOSE") steps.push(buildAppImagesRemoveScript(app));
    // Fail closed: if the teardown can't reach the agent (offline / timed out / capability not granted) or
    // reports a failure, keep the DB row so the leak stays visible and a later delete / PR event / reconcile
    // retries it — never delete the record while the container, volumes and images may still be on the host
    // (that was an unrecoverable orphan). The scripts end in `|| true`, so the real signal is a thrown error.
    let res: { exitCode: number; output: string };
    try {
      res = await this.agentWs.sendCommand(app.serverId, steps.join("\n"), "deploy");
    } catch (e) {
      await this.audit.log({ actor, action: "preview.remove_failed", target: app.id, meta: { reason: e instanceof Error ? e.message : "teardown unreachable" } });
      throw new ServiceUnavailableException("preview teardown did not converge — the preview is unchanged");
    }
    if (res.exitCode !== 0) {
      await this.audit.log({ actor, action: "preview.remove_failed", target: app.id, meta: { exitCode: res.exitCode } });
      throw new ServiceUnavailableException(`preview teardown failed (exit ${res.exitCode}) — the preview is unchanged`);
    }
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
      !(Array.isArray(app.extraPorts) && app.extraPorts.length > 0) && // extra published ports can't overlap → recreate
      !(Array.isArray(app.networkAliases) && app.networkAliases.length > 0) && // a rollout container would share the alias with the old one and round-robin to the not-yet-healthy copy → recreate
      !app.containerAlias && // same reason: the rollout copy would carry the live copy's alias and DNS-round-robin to the not-yet-healthy one → recreate
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
   *
   * `idempotencyKey` (the client's raw Idempotency-Key header, or null) gives this enqueue a DURABLE at-most-once
   * guarantee that COMPLEMENTS — does not replace — the IdempotencyInterceptor. The interceptor is the fast
   * in-flight HTTP replay while Redis is healthy on a single hub; the (appId, idempotencyKey) unique index is
   * the backstop that still dedupes after a Redis flush / outage / hub crash. A null key stores NULL, which
   * Postgres treats as DISTINCT from every other NULL, so the keyless path is byte-identical to before.
   */
  private async submitDeploy(
    app: Application,
    actor: string,
    noCache = false,
    idempotencyKey: string | null = null,
    // detach: when our row is claimed, run it in the background and return the RUNNING row at once (fleet
    // rollouts never await a build). trigger: override the derived origin label (e.g. "rollout").
    opts: { detach?: boolean; trigger?: string } = {},
  ) {
    const QUEUE_CAP = 10; // max QUEUED deploys per app (Coolify caps per server at 25)
    const trigger = opts.trigger ?? this.triggerOf(actor);
    // Normalize: a blank/whitespace/non-string header behaves as absent (keyless fail-open), never throws.
    const key = typeof idempotencyKey === "string" && idempotencyKey.trim() ? idempotencyKey.trim() : null;

    // Fast idempotent pre-check: a retry of an ALREADY-enqueued keyed deploy returns the existing row even when
    // the queue is at cap, so a legitimate retry never trips the "queue full" guard. Not the authority — the
    // unique index + the P2002 branch below is, because of the TOCTOU window between this read and the insert.
    if (key) {
      const prior = await this.prisma.deployment.findUnique({
        where: { appId_idempotencyKey: { appId: app.id, idempotencyKey: key } },
      });
      if (prior) return prior;
    }

    // A move's own deploys (`move:<id>`, `move:<id>:rb`: at most two per move, minted only by the move runner because
    // deploy() rejects client keys with that prefix) bypass the cap. While a move is live every other deploy queues but
    // claimNext holds it back, so the cap can be full exactly when the cutover or the rollback needs to enqueue.
    const isMoveDeploy = key !== null && key.startsWith("move:");
    if (!isMoveDeploy && (await this.prisma.deployment.count({ where: { appId: app.id, status: "QUEUED" } })) >= QUEUE_CAP) {
      throw new ConflictException("deploy queue is full — wait for queued deploys to run");
    }

    // Durable at-most-once ENQUEUE. Two concurrent duplicate submits resolve to exactly one row: the loser
    // catches P2002 on the idempotencyKey index and returns the winner's row (an idempotent 200, never a 500).
    // The P2002 branch is gated on `key`, so a keyless insert takes the exact original path with one extra
    // always-null column — no behavior change. The bounded loop (<=3 attempts) handles the only null-after-P2002
    // case: the conflicting row was deleted (cancel+prune) between our insert and the re-read, freeing the key.
    let dep: Deployment;
    for (let attempt = 0; ; attempt++) {
      try {
        dep = await this.prisma.deployment.create({
          data: { appId: app.id, status: "QUEUED", trigger, requestedBy: actor, noCache, idempotencyKey: key },
        });
        break;
      } catch (e) {
        if (
          key &&
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002" &&
          String(e.meta?.target ?? "").includes("idempotencyKey") // never swallow the one-running-per-app conflict
        ) {
          const existing = await this.prisma.deployment.findUnique({
            where: { appId_idempotencyKey: { appId: app.id, idempotencyKey: key } },
          });
          if (existing) return existing; // idempotent response — the durable at-most-once win
          if (attempt < 2) continue; // RACE: conflicting row deleted in the gap → key free again → re-insert
        }
        throw e;
      }
    }
    if (trigger === "webhook" || trigger === "preview") {
      await this.prisma.deployment.updateMany({
        where: { appId: app.id, status: "QUEUED", trigger, id: { not: dep.id } },
        data: { status: "CANCELLED", exitCode: -1, logs: "Superseded by a newer push" },
      });
    }
    const claimed = await this.claimNext(app.id);
    // We own the claim only if OUR row was promoted to RUNNING — run it inline + await so the idle-path
    // contract (caller gets the finished deployment) holds. The app we were handed is freshly fetched, so
    // pass it straight through. Otherwise our row stays QUEUED and drains later (with a reloaded app).
    if (claimed?.id === dep.id) {
      if (opts.detach) {
        // Same fire-and-forget shape as drain(): executeDeploy records its own terminal status and chains the
        // next drain in its finally, so nothing is lost by not awaiting it.
        void this.executeDeploy(claimed, app, actor, noCache).catch(() => undefined);
        return claimed;
      }
      return this.executeDeploy(claimed, app, actor, noCache);
    }
    return this.prisma.deployment.findUnique({ where: { id: dep.id } });
  }

  // ── fleet rollout seams (rollouts/rollout-engine.service.ts) ──

  /**
   * Enqueue a deploy on behalf of `userId` WITHOUT awaiting the build: returns the QUEUED or RUNNING row at
   * once. Authorized like an interactive deploy — team permission apps:deploy AND the caller's per-resource
   * scoping (require) — on EVERY call, so a rollout whose initiator lost access fails closed at the next
   * dispatch. `key` is the durable at-most-once enqueue key (rollout:<id>:<app>:<attempt>).
   */
  async deployDetached(userId: string, appId: string, opts: { key: string; noCache?: boolean }): Promise<Deployment> {
    await this.require(userId, appId);
    const app = await this.requireWrite(userId, appId, "apps:deploy");
    const dep = await this.submitDeploy(app, userId, opts.noCache ?? false, opts.key, { detach: true, trigger: "rollout" });
    if (!dep) throw new NotFoundException("deployment not found");
    // The key dedupes against ANY prior row with that key. Interactive clients cannot mint a reserved key (see
    // deploy()), but refuse to adopt a foreign row regardless: a rollout must only ever judge its own deploy.
    if (dep.trigger !== "rollout" || dep.requestedBy !== userId) throw new ConflictException("idempotency key collision: that deploy was not started by this rollout");
    return dep;
  }

  // ── app move seams (app-moves/app-move-runner.service.ts) ──
  // The move runner never edits deploy rows or builds lifecycle scripts itself: it asks for the SAME builders and the SAME
  // queue the rest of the app uses, so a moved app deploys/stops/starts exactly like an unmoved one.

  /** The stop / start / remove-container-keep-volumes scripts for the app on whichever host it currently lives, built by the
   *  same builders stop()/start()/remove() use, and the timeout the lifecycle actions use. */
  async moveLifecycle(app: Application): Promise<{ stop: string; start: string; removeContainer: string; timeoutMs: number }> {
    // Defence in depth: the preflight refuses these, but a `down` here would remove the user's real containers.
    if (adoptedCompose(app)) throw new BadRequestException("a stack adopted in place cannot be moved");
    const compose = app.source === "COMPOSE";
    const spec = compose ? await this.composeOpSpec(app) : null;
    return {
      stop: compose ? buildComposeStopScript(spec!) : buildStopScript(app),
      start: compose ? buildComposeStartScript(spec!) : buildStartScript(app),
      // keep the volumes: the source's data is the archive until the move's retention ends
      removeContainer: compose ? buildComposeDownScript(spec!, { volumes: false }) : buildRemoveScript(app, [], {}),
      timeoutMs: this.lifecycleTimeoutMs(app),
    };
  }

  /** Enqueue the deploy a move runs (on the target after the cutover; `move:<id>:rb` on the source after a rollback).
   *  The key is the move's own: claimNext admits ONLY move deploys while the move is live. Returns the QUEUED/RUNNING row. */
  async submitMoveDeploy(appId: string, actor: string, key: string): Promise<Deployment> {
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) throw new NotFoundException("application not found");
    const dep = await this.submitDeploy(app, actor, false, key, { detach: true, trigger: "move" });
    if (!dep) throw new NotFoundException("deployment not found");
    return dep;
  }

  /** After a move ends, run whatever deploys queued up while the app was locked. Fire-and-forget safe. */
  async drainApp(appId: string): Promise<void> {
    await this.drain(appId);
  }

  /** Re-sync everything derived from "which server is the app on": log drains, tunnel ingress (when exposed) and the
   *  uptime monitor. Best-effort per step; returns the failed step names so the move can record a warning. */
  async syncAfterMove(appId: string, serverIds: string[]): Promise<string[]> {
    const failed: string[] = [];
    const app = await this.prisma.application.findUnique({ where: { id: appId } });
    if (!app) return failed;
    await this.logDrainPush.pushForServers(serverIds).catch(() => failed.push("log_drains"));
    if (app.tunnelExposed) {
      for (const id of [...new Set(serverIds)]) await this.syncTunnelIngress(id).catch(() => failed.push("tunnel"));
    }
    await this.syncMonitor(appId).catch(() => failed.push("monitor"));
    return failed;
  }

  /** System-side cancel of ANY non-terminal deploy of a move (the move's authority replaces a user's): a QUEUED row is
   *  cancelled by CAS; a RUNNING one has its in-flight agent command killed (executeDeploy then records CANCELLED).
   *  Returns true when the row was cancelled or its kill was delivered. */
  async cancelMoveDeployment(depId: string, note: string): Promise<boolean> {
    if (await this.cancelQueuedDeploymentSystem(depId, note)) return true;
    const live = this.activeDeployCommands.get(depId);
    if (live) {
      this.cancelRequested.add(depId);
      return this.agentWs.cancelCommand(live.serverId, live.reqId);
    }
    const row = await this.prisma.deployment.findUnique({ where: { id: depId } });
    if (row && isSwarmDispatch(row)) return false;
    if (row?.status === "RUNNING" && row.agentReqId && row.agentServerId && (row.phase === "DISPATCHED" || row.phase === "RECOVERING")) {
      return this.agentWs.cancelCommand(row.agentServerId, row.agentReqId);
    }
    return false;
  }

  /** System-side cancel of a still-QUEUED deploy (the caller's authority is the rollout row that dispatched it).
   *  Compare-and-set on QUEUED: a row that already started is left alone and false is returned. */
  async cancelQueuedDeploymentSystem(depId: string, note: string): Promise<boolean> {
    const { count } = await this.prisma.deployment.updateMany({
      where: { id: depId, status: "QUEUED" },
      data: { status: "CANCELLED", exitCode: -1, logs: note },
    });
    return count === 1;
  }

  /** The newest SUCCESS deployment whose artifact is still rollbackable (same predicate as deployments()) — the
   *  baseline a rollout records before it touches the app. Null when none. */
  async rolloutBaseline(appId: string): Promise<string | null> {
    const app = await this.prisma.application.findUnique({ where: { id: appId }, select: { source: true, serverId: true } });
    if (!app) return null;
    const isCompose = app.source === "COMPOSE";
    const rows = await this.prisma.deployment.findMany({
      where: { appId, status: "SUCCESS" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, imageTag: true, registryImage: true, imageDigest: true, configSnapshot: true, runServerId: true },
    });
    const hit = rows.find((d) =>
      isCompose ? !!(d.configSnapshot as ConfigSnapshot | null)?.composeFile : !!(d.imageTag || d.registryImage || d.imageDigest) && !predatesMove(d, app.serverId),
    );
    return hit?.id ?? null;
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
      // App move: while a move is live ONLY its own deploy (idempotencyKey move:<id>) is claimable — it runs ahead of
      // older queued rows, and every other queued deploy waits until the move ends (the runner drains afterwards).
      // Without a live move the queue is unchanged, except that a `move:` deploy whose move is already over is never
      // run (a stale row from a rolled-back move).
      const mv = await findActiveMove(tx, appId);
      const moveFilter: Prisma.DeploymentWhereInput = mv
        ? { idempotencyKey: { in: [`move:${mv.id}`, `move:${mv.id}:rb`] } }
        : { OR: [{ idempotencyKey: null }, { NOT: { idempotencyKey: { startsWith: "move:" } } }] };
      const tried: string[] = []; // rows whose CAS lost to a cancel — skip them so the loop always terminates
      for (;;) {
        const next = await tx.deployment.findFirst({
          where: { appId, status: "QUEUED", id: { notIn: tried }, ...moveFilter },
          orderBy: { createdAt: "asc" },
        });
        if (!next) return null;
        const { count } = await tx.deployment.updateMany({
          where: { id: next.id, status: "QUEUED" },
          // The lease stamp: THIS process owns the row from here (DeployLeaseService.bootId). A restarted hub has
          // a different bootId, so it can tell its own live rows from a dead process's orphans.
          data: { status: "RUNNING", startedAt: new Date(), ownerId: this.lease.bootId, heartbeatAt: new Date(), phase: "CLAIMED" },
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
   * Re-drive every app on this server that still has a QUEUED deploy — called when the server's agent
   * (re)connects to the gateway (registered in ApplicationsModule.onModuleInit). This is the SAFE HALF of
   * surviving a hub restart: a QUEUED row has startedAt=null and has dispatched NOTHING to the agent
   * (executeDeploy, the only sender, runs only on a RUNNING row), so re-driving it is a byte-identical
   * NORMAL deploy — not a resume — with zero double-apply risk. (An interrupted RUNNING deploy is never
   * re-run here: DeployRecoveryService adopts its journaled outcome, or boot re-queues/reaps it.)
   *
   * It fans out one private drain() per distinct app — zero new queue logic — so the one-RUNNING-per-app
   * invariant is never bypassed: drain → claimNext takes SELECT ... FOR UPDATE on the Application row and
   * returns null (no-op) if any deploy is already RUNNING, and the deployment_one_running_per_app partial
   * index is the DB backstop. A deploy for an app that is already RUNNING is simply skipped.
   *
   * STRICT ONLINE GATE: a deploy may also need a SEPARATE build server. We drive a drain ONLY when every
   * server the deploy needs is online (the app's run server AND, if different, its build server). Otherwise
   * the row is left QUEUED and re-drives when the other server reconnects and fires this hook too — so a
   * drain is never attempted against an offline agent (no "agent offline" failures in the normal path).
   *
   * CLUSTERED (swarm) apps are EXCLUDED here (clusterId: null filter): a swarm deploy targets the dynamically-
   * resolved cluster manager, not Application.serverId, so this per-server online gate can't gate them. They have
   * their own, equally strict gate in redriveQueuedClusteredForServer (same hook), which asks the swarm layer for a
   * manager that is actually reachable.
   *
   * Flapping is harmless: each (re)connect re-fires this, and drain/claimNext no-op when a deploy is already
   * RUNNING, so no debounce is needed. Best-effort — any error is swallowed (the sweep is the backstop).
   */
  async redriveQueuedForServer(serverId: string): Promise<void> {
    // The OR mirrors cleanup-runner.service.ts: an app whose SEPARATE build server reconnects is re-driven too.
    // clusterId: null — only single-server apps; clustered (swarm) QUEUED rows re-drive via redriveQueuedClusteredForServer.
    const rows = await this.prisma.deployment.findMany({
      where: { status: "QUEUED", application: { clusterId: null, OR: [{ serverId }, { buildServerId: serverId }] } },
      select: { appId: true, application: { select: { serverId: true, buildServerId: true } } },
      distinct: ["appId"],
    });
    for (const row of rows) {
      const runServerId = row.application.serverId;
      const buildServerId = row.application.buildServerId;
      const runOnline = this.agentWs.isOnline(runServerId);
      const buildOnline = !buildServerId || buildServerId === runServerId || this.agentWs.isOnline(buildServerId);
      if (!runOnline || !buildOnline) continue; // leave QUEUED — re-drives when the other server reconnects
      void this.drain(row.appId).catch(() => undefined);
    }
  }

  /**
   * The swarm half of the reconnect re-drive (same hook, same safety argument): re-drive every CLUSTERED app that has a
   * QUEUED deploy — a never-started or restart-re-queued row has dispatched nothing to the cluster, so driving it is a
   * normal deploy, and drain/claimNext keep one RUNNING per app. A swarm deploy targets the cluster MANAGER (resolved
   * fresh, with failover), not Application.serverId, so the gate is different: the manager must be reachable NOW
   * (SwarmDeployService.liveManager — resolves AND has a live agent socket) and, for a GIT app with a separate build
   * server, that server must be online too. Otherwise the row stays QUEUED and re-drives when the missing node
   * reconnects and fires this hook (any member of the cluster, or the build server, triggers the re-check); the stale
   * sweep is the backstop for a cluster that never comes back. Best-effort, errors swallowed.
   */
  async redriveQueuedClusteredForServer(serverId: string): Promise<void> {
    const srv = await this.prisma.server.findUnique({ where: { id: serverId }, select: { clusterId: true } }).catch(() => null);
    const or: Prisma.ApplicationWhereInput[] = [{ buildServerId: serverId }];
    if (srv?.clusterId) or.push({ clusterId: srv.clusterId });
    const rows = await this.prisma.deployment.findMany({
      where: { status: "QUEUED", application: { clusterId: { not: null }, OR: or } },
      select: { appId: true, application: { select: { clusterId: true, buildServerId: true } } },
      distinct: ["appId"],
    });
    for (const row of rows) {
      const clusterId = row.application.clusterId;
      if (!clusterId) continue;
      const buildServerId = row.application.buildServerId;
      if (buildServerId && !this.agentWs.isOnline(buildServerId)) continue; // re-drives when the build server reconnects
      if (!(await this.swarmDeploy.liveManager(clusterId))) continue; // re-drives when a manager is reachable
      void this.drain(row.appId).catch(() => undefined);
    }
  }

  /**
   * Backstop sweep: cancel QUEUED deploys older than maxAgeMs whose app has NO RUNNING deploy, so a row whose
   * server's agent never reconnects does not linger QUEUED forever. Driven hourly by
   * DeployQueueSweepSchedulerService. The `deployments none RUNNING` guard is what keeps this safe alongside
   * the reconnect re-drive: a QUEUED row that is legitimately WAITING behind an active RUNNING deploy (it
   * drains normally via executeDeploy's finally) is NOT cancelled — only genuinely-stranded rows are. Filters
   * status:QUEUED ONLY, so it never touches a RUNNING/SUCCESS/FAILED row. Server-existence-agnostic, so it
   * uniformly covers server-offline-forever, server-deleted-orphan (Application.serverId is a loose FK, so a
   * deleted server orphans its apps and their QUEUED rows never re-drive), and any stuck-QUEUED bug. (A
   * DELETED app needs no sweep: Deployment.application is onDelete:Cascade, so its QUEUED rows are gone.)
   * Returns the number of rows cancelled. maxAgeMs is generous so a merely-rebooting server is never swept.
   */
  async sweepStaleQueued(maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const { count } = await this.prisma.deployment.updateMany({
      where: {
        status: "QUEUED",
        createdAt: { lt: cutoff },
        application: { deployments: { none: { status: "RUNNING" } } },
      },
      data: {
        status: "CANCELLED",
        exitCode: -1,
        logs: "Queued deploy cancelled: its server's agent (or its cluster's swarm manager) did not reconnect in time. Re-deploy.",
      },
    });
    return count;
  }

  /**
   * Cancel a deploy. A QUEUED one is a compare-and-set on status=QUEUED. A RUNNING one is cancelled by
   * killing the in-flight agent command's process group (SIGKILL): executeDeploy then records it CANCELLED
   * (not FAILED), skips auto-rollback and the failure notification, and leaves the app's running state
   * untouched (the previous container was never swapped out mid-build). Only a non-swarm RUNNING deploy with
   * a tracked in-flight command can be cancelled — a swarm rollout (or a RUNNING row orphaned by a hub
   * restart, with no live command) still 409s. Scoped by the already-authorized appId → no IDOR.
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
    if (row.status === "RUNNING") {
      // A swarm rollout is not cancellable even when adopted from the journal: killing the agent's poll script would
      // report CANCELLED while Swarm keeps rolling the service out (the live path refuses it for the same reason).
      if (isSwarmDispatch(row)) throw new ConflictException("this running deployment can't be cancelled (a swarm rollout can't be interrupted)");
      // In-memory handle for a command this process dispatched; else the row's persisted handle for a durable
      // command owned by a dead process / being adopted (the agent kills it and journals `killed`, so adoption
      // settles it CANCELLED).
      const live = this.activeDeployCommands.get(depId);
      const active =
        live ??
        (row.agentReqId && row.agentServerId && (row.phase === "DISPATCHED" || row.phase === "RECOVERING") ? { serverId: row.agentServerId, reqId: row.agentReqId } : null);
      if (!active) throw new ConflictException("this running deployment can't be cancelled (no cancellable step is in flight)");
      // Live command: mark intent BEFORE sending the kill so executeDeploy's result handler sees CANCELLED, then
      // kill the command's process group on the agent. The deployment flips to CANCELLED when the command returns.
      // Row handle (a durable deploy owned by a dead hub / being adopted): the agent journals the kill and adoption
      // settles it CANCELLED — but only if the signed kill actually reaches the agent, so an offline agent is a 503
      // (retry when it is back), never a silent "cancelled" that the deploy then outlives.
      if (live) this.cancelRequested.add(depId);
      const delivered = this.agentWs.cancelCommand(active.serverId, active.reqId);
      if (!live && !delivered) throw new AgentOfflineException("The agent is offline — the running deploy can be cancelled once it reconnects.");
      await this.audit.log({ actor: userId, action: "app.deploy.cancel", target: appId });
      return row;
    }
    throw new ConflictException("deployment already finished");
  }

  /** Execute one already-CLAIMED (RUNNING) deploy: build/run on the agent and record the result. The caller
   *  supplies a FRESH app (submitDeploy passes the just-fetched one for the inline path; drain reloads it, so
   *  config edited while the deploy sat QUEUED is picked up). On EVERY exit path it drains the app's queue
   *  (starts the next QUEUED deploy), so deploys for one app run one-at-a-time, FIFO. */
  private async executeDeploy(dep: Deployment, app: Application, actor: string, noCacheRequested: boolean) {
    const noCache = noCacheRequested || app.disableBuildCache; // the persistent setting ORs with the per-deploy rebuild
    this.deployLogs.begin(app.id);
    // Was the app live before this deploy, and did we get as far as sending the deploy command? Used so a
    // failure BEFORE the container swap (a build/render/validate step — the live container/stack was never
    // touched) leaves a still-serving app RUNNING instead of flipping it to FAILED.
    const wasRunning = app.status === AppStatus.RUNNING;
    let swapAttempted = false;
    // True once the main deploy command's reqId is persisted on the row (durable dispatch) — the catch may then
    // release the lease for adoption instead of writing FAILED on a mere socket drop.
    let dispatched = false;
    // The agent the durable main command went to: app.serverId for the classic paths, the cluster MANAGER for a swarm
    // deploy (set by the swarm dispatch hook) — the lease-released hook must wake the adopter of THAT agent.
    let dispatchServerId = app.serverId;
    try {
      // Fail-closed: re-validate the STORED dockerOptions against the app's CURRENT privileged flag on every
      // deploy. If the owner revoked the override (or a path stored privileged options without the flag), the
      // deploy fails here instead of silently running --privileged/host binds again. No-op for COMPOSE/null.
      assertSafeDockerOptions(app.dockerOptions, { allowPrivileged: app.allowPrivilegedDockerOptions });
      this.assertStoredCustomLabels(app);
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
      this.logAutoMultiline(app.id, (await this.attachResolvedEnv(app, spec, { withBuild: true })).autoMultiline); // shared vars + app env (app wins) + flags; build-time vars
      spec.buildSecrets = this.appBuildSecrets(app); // BuildKit secret mounts (DOCKERFILE builds)
      // injectEnvAsBuildArgs: fail early (pre-swap, any path) if the env cannot ride argv; prepSteps recomputes the same pure result.
      if (app.source === "GIT" && app.buildType === "DOCKERFILE" && app.injectEnvAsBuildArgs) injectableBuildArgs(spec);
      await this.hydrateCertSpec(app, spec);
      await this.hydrateDnsChallenge(app, spec);
      // Private repo via a connected git source: a GitHub App mints a fresh installation token, a Gitea/Forgejo/
      // Codeberg source supplies its stored access token (GIT build or git-compose). The credential is pinned to
      // the source's own host (cloneToken refuses a repo URL anywhere else) and reaches git via GIT_ASKPASS only.
      if (app.gitSourceId && (app.source === "GIT" || isGitCompose)) {
        spec.gitToken = await this.gitSources.cloneToken(app.gitSourceId, app.gitUrl);
      }
      // Push the built image to the app's team registry (build-time), if configured.
      if (app.pushToRegistry && app.registryId && !isCompose) {
        const reg = await this.prisma.registry.findFirst({ where: { id: app.registryId, teamId: app.teamId } });
        if (reg) {
          const auth: RegistryAuth = { url: reg.url ?? undefined, user: reg.username, token: this.crypto.decrypt(reg.passwordEnc) };
          // Optional mutable alias next to the immutable :<deploymentId> tag (resolved + re-validated now; a throw is a
          // pre-swap FAILED because swapAttempted is still false).
          let alias: PushAlias | undefined;
          if (app.pushImageTag) {
            try {
              alias = resolveAlias(app.pushImageTag, { branch: app.gitBranch || "main", source: app.source === "GIT" ? "GIT" : "IMAGE" }, dep.id);
            } catch (e) {
              this.deployLogs.push(app.id, `${(e as Error).message}\n`);
              throw e;
            }
          }
          if (app.pushImageName) {
            const bad = validatePushName(app.pushImageName);
            if (bad) {
              this.deployLogs.push(app.id, `TUGRA: the custom image name is not valid (${bad})\n`);
              throw new Error(`TUGRA: the custom image name is not valid (${bad})`);
            }
          }
          spec.registryPush = { auth, tag: registryImageRef(reg, app, dep.id), ...(alias ? { alias } : {}) };
        }
      }
      // Capture the pushed ref before it is cleared (build-server path nulls registryPush) so
      // the deployment records it → a later rollback can pull it even after local prune.
      const registryRef = spec.registryPush?.tag ?? null;
      // Swarm: did the previous deploy carry custom labels? Read BEFORE this deployment's snapshot is written (and
      // excluding it) so a label removal/reset strips the stale container labels exactly once.
      if (app.clusterId && !isCompose) spec.customLabelsScrub = await this.prevSnapshotHadCustomLabels(app.id, dep.id);
      // Record a redacted config snapshot so the Deployments view can diff it.
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: { configSnapshot: buildConfigSnapshot(spec) as object, ...(noCache !== noCacheRequested ? { noCache } : {}) },
      });
      // ── Swarm service deploy: the app targets a cluster's swarm, not a single server. Delegate
      // the command build + dispatch (to the manager) + async-rollout classification to SwarmDeployService,
      // then apply the SAME exit-code contract (0 converged / 3 auto-rolled-back / other failed). ──
      if (app.clusterId) {
        // The swarm dispatch issues a mutating `docker service update`; a throw after this is not a safe
        // pre-swap failure, so the catch below must not preserve the old status.
        swapAttempted = true;
        const sd = await this.swarmDeploy.deploy(app, spec, dep.id, {
          noCache,
          timeoutMs: this.deployTimeoutMs(app),
          onChunk: (chunk) => this.deployLogs.push(app.id, chunk),
          // Hub-restart survival (only used when the manager's agent journals commands; an older agent keeps the
          // legacy path and boot reaps it as before). Two checkpoints, both compare-and-set on OUR lease:
          //  - prepare: build/inspect begin; nothing live is touched until dispatch, so a restart RE-QUEUES the row;
          //  - beforeDispatch: the one mutating `docker service` command is about to go out as a durable command; a
          //    restart from here ADOPTS its real outcome from the agent's journal (never re-sent → no double-apply).
          durable: {
            prepare: async () => {
              const { count } = await this.prisma.deployment.updateMany({
                where: { id: dep.id, status: "RUNNING", ownerId: this.lease.bootId, phase: "CLAIMED" },
                data: { phase: "PREPARING" },
              });
              if (count !== 1) throw new Error("deploy lease lost before the swarm build started");
            },
            beforeDispatch: async ({ managerId, reqId, timeoutMs, buildLog }) => {
              const plan: DispatchPlan = {
                v: 1,
                rolling: false,
                recreate: false,
                isCompose: false,
                isGitCompose: false,
                hadPrev: false,
                swarm: true,
                gitSourced: app.source === "GIT",
                runTag: null, // no local retag on a swarm — the registry ref is the artifact
                registryRef,
                wasRunning,
                postDeploy: false,
                buildLogHead: buildLog ? buildLog.slice(0, BUILD_LOG_HEAD_BYTES) : null,
              };
              const { count } = await this.prisma.deployment.updateMany({
                where: { id: dep.id, status: "RUNNING", ownerId: this.lease.bootId },
                data: {
                  phase: "DISPATCHED",
                  agentReqId: reqId,
                  agentServerId: managerId,
                  deadlineAt: new Date(Date.now() + timeoutMs + DISPATCH_DEADLINE_SLACK_MS),
                  dispatchPlan: plan as unknown as Prisma.InputJsonValue,
                },
              });
              if (count !== 1) throw new Error("deploy lease lost before dispatch");
              dispatched = true;
              dispatchServerId = managerId;
            },
          },
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
        // The deploy server only pulls (no clone there), so hand it the built SHA for the runtime SOURCE_COMMIT env.
        const bc = app.source === "GIT" ? parseCommit(br.output) : null; // marker is hex-validated; gated on GIT so output can't forge one
        if (bc) spec.sourceCommit = bc.sha;
        // The deploy server pulls the just-pushed image instead of building it.
        spec.registryPull = { auth: spec.registryPush.auth, ref: spec.registryPush.tag };
        spec.registryPush = null;
      }
      // COMPOSE-from-git: clone + render the stack on the agent, then VALIDATE the rendered config on the hub
      // (assertSafeCompose, with the clone as the allowed root) BEFORE running anything. The up script re-clones
      // and refuses to run unless the stack still renders to the exact digest we validated (a TOCTOU lock).
      let gitComposeUp: string | null = null;
      if (isGitCompose) {
        // The render re-clones (rm -rf's the clone dir, which can be the live stack's build/bind source), so
        // from here a failure is no longer a safe pre-swap failure.
        swapAttempted = true;
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
        // COMPOSE pre/post-deploy hooks: validate the hook service against the RENDERED stack (hard gate; a missing
        // service throws -> FAILED with the message in the deploy log). The up script is sha-locked to this render.
        const hooks = composeHookPlan(spec, rendered.compose);
        gitComposeUp = buildComposeGitUpScript(spec, rendered.sha, noCache, hooks, rendered.compose);
      }
      const command = isGitCompose
        ? gitComposeUp!
        : isCompose
          ? buildComposeUpScript(spec, noCache)
          : rolling
            ? buildRollingDeployScript(spec, dep.id, { build: true, noCache, probe: resolveHealthProbe(spec), soak: resolveSoak(spec), ...resolveHealthGate(spec) })
          : recreate
            ? buildRecreateDeployScript(spec, dep.id, {
                build: true,
                noCache,
                prevVersion: prev?.id ?? null,
                prevCommit: prev?.commitSha ?? null,
                probe: resolveHealthProbe(spec),
                ...resolveHealthGate(spec),
              })
            : buildRunScript(spec, dep.id, true, noCache);
      // The main deploy command runs on the live server from here; a throw after this (agent offline, timeout)
      // is not a safe pre-swap failure, so the catch keeps FAILED.
      swapAttempted = true;
      // A rolling deploy with a post-cutover soak runs the whole soak window INSIDE this one command; extend
      // the agent timeout by the soak budget (window + probe time + margin) or the agent would SIGKILL the
      // watch mid-soak → ambiguous state (new live, __prev stopped, no revert decision). Zero for every other
      // path, so their timeout is unchanged.
      // The drain sleep and graceful stops (stopGracePeriodSec) also run inside this one command → budget them too.
      const mainTimeoutMs = this.deployTimeoutMs(app) + (rolling ? this.soakBudgetMs(spec) : 0) + this.opsBudgetMs(spec, rolling);
      // DURABLE dispatch (hub-crash recovery): when the agent journals commands (cmd_journal_v1), persist the
      // command's reqId + a frozen outcome plan on the row with a compare-and-set BEFORE the frame goes out, so a
      // hub that dies mid-deploy can re-adopt this exact command (DeployRecoveryService) instead of failing it
      // blind. An old agent takes the legacy path untouched (no reqId → boot reaps as before).
      const durable = this.agentWs.agentSupports(app.serverId, AGENT_FEATURE_CMD_JOURNAL);
      const onChunk = (chunk: string) => this.deployLogs.push(app.id, chunk);
      const onStart = (reqId: string) => this.activeDeployCommands.set(dep.id, { serverId: app.serverId, reqId });
      const r = !durable
        ? await this.agentWs.sendCommand(app.serverId, command, "deploy", mainTimeoutMs, onChunk, onStart) // legacy call shape, unchanged
        : await this.agentWs.sendCommand(app.serverId, command, "deploy", mainTimeoutMs, onChunk, onStart, {
              reqId: `dep-${dep.id}`,
              durable: true,
              beforeSend: async (reqId) => {
                // rolling only consults the DB on exit 3 in the live path; the plan needs the answer up front.
                const hadPrev = recreate
                  ? !!prev
                  : rolling
                    ? !!(await this.prisma.deployment.findFirst({ where: { appId: app.id, status: "SUCCESS", imageTag: { not: null }, id: { not: dep.id } }, select: { id: true } }))
                    : false;
                const plan: DispatchPlan = {
                  v: 1,
                  rolling,
                  recreate,
                  isCompose,
                  isGitCompose,
                  hadPrev,
                  gitSourced: app.source === "GIT" || isGitCompose,
                  runTag: isCompose ? null : runTag(app, dep.id),
                  registryRef,
                  wasRunning,
                  postDeploy: !isCompose && !!spec.postDeployCommand?.trim(),
                  buildLogHead: buildLog ? buildLog.slice(0, BUILD_LOG_HEAD_BYTES) : null,
                };
                const { count } = await this.prisma.deployment.updateMany({
                  where: { id: dep.id, status: "RUNNING", ownerId: this.lease.bootId },
                  data: {
                    phase: "DISPATCHED",
                    agentReqId: reqId,
                    agentServerId: app.serverId,
                    deadlineAt: new Date(Date.now() + mainTimeoutMs + DISPATCH_DEADLINE_SLACK_MS),
                    dispatchPlan: plan as unknown as Prisma.InputJsonValue,
                  },
                });
                if (count !== 1) throw new Error("deploy lease lost before dispatch");
                dispatched = true;
              },
            });
      // Cancelled mid-flight: the agent SIGKILLed the build (its process group), so record CANCELLED — not
      // FAILED — and skip auto-rollback + the failure notification. The previous container (if any) was
      // never swapped out, so the app's running state is untouched; leave its status as-is.
      if (this.cancelRequested.has(dep.id)) {
        await this.prisma.deployment.update({
          where: { id: dep.id },
          data: {
            status: "CANCELLED",
            logs: `${(buildLog ? `${buildLog}\n${r.output}` : r.output)}\nCancelled by user`.slice(0, 65536),
            exitCode: r.exitCode,
            ...this.finishStamp(dep),
          },
        });
        this.deployLogs.finish(app.id, { status: "FAILED", exitCode: r.exitCode, deploymentId: dep.id });
        if (!isCompose) await this.agentWs.sendCommand(app.serverId, buildImageRemoveScriptForTags(app.id, [runTag(app, dep.id), registryRef], await this.ownedVersionsFor(app, [runTag(app, dep.id), registryRef])), "cleanup").catch(() => undefined);
        await this.audit.log({ actor, action: "app.deploy.cancel", target: app.id });
        return this.prisma.deployment.findUnique({ where: { id: dep.id } });
      }
      // Exit-code contract from the rolling/recreate scripts: 0 = healthy & live, 3 = new
      // version failed its health gate and the PREVIOUS one is serving (auto-rollback),
      // anything else = hard failure. Only rolling/recreate emit exit 3, and only when a
      // previous live version actually existed — so a plain hard-cutover build or a first
      // deploy that merely happens to exit 3 is a hard fail (not a false "kept the previous
      // version" that would leave the app wrongly marked RUNNING).
      const code = r.exitCode;
      // hadPrev: recreate only exits 3 when it had a previous image to restore; rolling consults the DB (only on
      // exit 3, as before — the lookup is not paid on the common path).
      const hadPrev =
        code === 3 && !isCompose
          ? recreate
            ? !!prev
            : rolling
              ? !!(await this.prisma.deployment.findFirst({ where: { appId: app.id, status: "SUCCESS", imageTag: { not: null }, id: { not: dep.id } } }))
              : false
          : false;
      // exit 4 = POST-CUTOVER auto-revert: the rolling soak switched traffic, the new version then failed its
      // soak, and the script already `docker start`-ed __prev — so the previous version is PROVABLY live. No
      // DB re-derivation needed (that is exactly why the code is distinct from the pre-cutover exit 3, whose
      // old container was merely left untouched). Rolling-only; a compose/hard-cutover build never emits it.
      // decideDeployOutcome is the ONE exit-code contract, shared with the hub-restart adoption path.
      const { ok, rolledBack } = decideDeployOutcome(code, { rolling, recreate, isCompose, hadPrev });
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
        // Detached + self-contained (its own per-row try/catch): a slow agent or a prisma hiccup inside the
        // prune must never delay the deploy result/drain or flip this already-SUCCESS deploy to FAILED.
        void this.pruneImages(app).catch(() => undefined);
      } else if (!isCompose) {
        // A failed/rolled-back deploy built tugra_<id>:<depId> (and maybe pushed the registry ref) but it
        // never went live → reap BOTH local tags so repeated failed push-enabled deploys don't leak a full
        // image each (the row records neither tag, so no later prune can find them).
        await this.agentWs
          .sendCommand(app.serverId, buildImageRemoveScriptForTags(app.id, [runTag(app, dep.id), registryRef], await this.ownedVersionsFor(app, [runTag(app, dep.id), registryRef])), "cleanup")
          .catch(() => undefined);
      }
    } catch (e) {
      // The agent's socket dropped while our DURABLE main command was running there. The command keeps running
      // on the agent (its journal has it), so this is NOT a failure: release the lease (ownerId → null, phase
      // RECOVERING) and write nothing else — no FAILED row, no Application.status — and let DeployRecoveryService
      // adopt the exact command when the agent is back (now, if it already reconnected; else on its reconnect
      // hook / the ticker; past deadlineAt it settles as interrupted). A requested cancel is NOT excluded: the
      // signed kill may never have reached the agent (the socket was already gone), and a durable command outlives
      // the drop — so the journal, not our intent, decides: killed → CANCELLED on adoption, else the real outcome.
      if (e instanceof AgentDisconnectedException && dispatched) {
        const released = await this.prisma.deployment
          .updateMany({ where: { id: dep.id, status: "RUNNING", ownerId: this.lease.bootId }, data: { ownerId: null, phase: "RECOVERING" } })
          .catch(() => ({ count: 0 }));
        if (released.count === 1) {
          this.logger.warn(`deploy ${dep.id} (app ${app.id}): agent ${app.serverId} disconnected mid-command — lease released for adoption`);
          this.deployLogs.push(app.id, "TUGRA: connection to the agent dropped; the deploy keeps running there and is re-adopted when it reconnects\n");
          this.leaseReleasedHook?.(dispatchServerId);
          // finally still runs (clears the cancel registry; drain is a no-op while this row stays RUNNING).
          return this.prisma.deployment.findUnique({ where: { id: dep.id } });
        }
      }
      // Best-effort: a build-server / git-compose failure throws with output that may still carry the commit
      // marker. GIT or git-compose only, so a pasted-IMAGE/COMPOSE failure message can't forge one. (isGitCompose
      // lives in the try scope, so the discriminator is inlined here.)
      const gitSourced = app.source === "GIT" || (app.source === "COMPOSE" && !!app.composePath && !!app.gitUrl);
      const cc = gitSourced && e instanceof Error ? parseCommit(e.message) : null;
      // A cancel can surface here too (the killed command dropped the socket / threw) — record CANCELLED,
      // leave the app status untouched, and send no failure notification.
      if (this.cancelRequested.has(dep.id)) {
        await this.prisma.deployment.update({
          where: { id: dep.id },
          data: {
            status: "CANCELLED",
            logs: `${e instanceof Error ? e.message : "cancelled"}\nCancelled by user`.slice(0, 65536),
            commitSha: cc?.sha ?? null,
            commitMessage: cc?.message ?? null,
            ...this.finishStamp(dep),
          },
        });
        this.deployLogs.finish(app.id, { status: "FAILED", exitCode: -1, deploymentId: dep.id });
        await this.audit.log({ actor, action: "app.deploy.cancel", target: app.id });
      } else {
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
        // A throw BEFORE anything touched the live container or stack (e.g. a build-server build on another
        // machine) leaves a running app serving — don't write status at all (and don't clobber a concurrent
        // Stop/Start). Once the git-compose render, a swarm dispatch or the main deploy command has started,
        // swapAttempted is true and a throw stays FAILED (conservative: the live state is then unknown).
        if (swapAttempted || !wasRunning) {
          await this.prisma.application.update({
            where: { id: app.id },
            data: { status: AppStatus.FAILED },
          });
        }
        this.deployLogs.finish(app.id, { status: "FAILED", exitCode: -1, deploymentId: dep.id });
        this.notifyDeploy(app, dep, "deploy_failed").catch(() => {});
      }
    } finally {
      // Clear the cancel registry for this deployment (terminal now, whatever happened).
      this.activeDeployCommands.delete(dep.id);
      this.cancelRequested.delete(dep.id);
      // Whatever happened (success, failure, or the early swarm return), start the next queued deploy for
      // this app. The row is already terminal here, so claimNext's RUNNING-count check won't see this one.
      void this.drain(app.id);
    }
    await this.audit.log({ actor, action: "app.deploy", target: app.id });
    return this.prisma.deployment.findUnique({ where: { id: dep.id } });
  }

  /**
   * Settle a deploy this process ADOPTED after a hub restart / socket drop, from the agent's journaled result of
   * the exact command that was dispatched — judged by the plan frozen at dispatch, never by today's config.
   * Mirrors executeDeploy's terminal block (status, kind, tags, digest/commit markers, app status, live-log
   * finish, notification, image prune/cleanup, queue drain). Every write is a CAS on (RUNNING, ownerId = us),
   * so a row somebody else settled meanwhile is left alone. No-op when the app is gone (row cascaded).
   */
  async finalizeAdopted(dep: Deployment, result: { exitCode: number; output: string; killed: boolean }): Promise<void> {
    const app = await this.prisma.application.findUnique({ where: { id: dep.appId } });
    if (!app) return;
    const plan = isDispatchPlan(dep.dispatchPlan) ? dep.dispatchPlan : null;
    if (!plan) {
      await this.settleInterrupted(dep, "the dispatch plan recorded for this deploy is unreadable");
      return;
    }
    // A build-server deploy's commit marker + build log live in the build phase (buildLogHead), as on the live path.
    const output = (plan.buildLogHead ? `${plan.buildLogHead}\n${result.output}` : result.output).slice(0, 65536);
    this.cancelRequested.delete(dep.id);
    const ownerGuard = { id: dep.id, status: "RUNNING" as const, ownerId: this.lease.bootId };
    const clear = { ownerId: null, phase: null };
    // A swarm deploy retags nothing locally (the registry is the artifact), so there is nothing to reap on any server.
    const tagsToReap = plan.isCompose || plan.swarm ? [] : [plan.runTag, plan.registryRef].filter((x): x is string => !!x);
    if (result.killed) {
      // A command_cancel killed it (requested before the hub died, or via the row's handle afterwards): CANCELLED,
      // never FAILED, no auto-rollback bookkeeping, app status untouched — the live path's exact semantics.
      const { count } = await this.prisma.deployment.updateMany({
        where: ownerGuard,
        data: { status: "CANCELLED", logs: `${output}\nCancelled by user`.slice(0, 65536), exitCode: result.exitCode, ...this.finishStamp(dep), ...clear },
      });
      if (count !== 1) return;
      this.deployLogs.finish(app.id, { status: "FAILED", exitCode: result.exitCode, deploymentId: dep.id });
      if (tagsToReap.length) await this.agentWs.sendCommand(app.serverId, buildImageRemoveScriptForTags(app.id, tagsToReap, await this.ownedVersionsFor(app, tagsToReap)), "cleanup").catch(() => undefined);
      await this.audit.log({ actor: dep.requestedBy ?? "system", action: "app.deploy.cancel", target: app.id });
      void this.drain(app.id);
      return;
    }
    const { ok, rolledBack } = decideDeployOutcome(result.exitCode, plan);
    const cc = plan.gitSourced ? parseCommit(output) : null;
    const { count } = await this.prisma.deployment.updateMany({
      where: ownerGuard,
      data: {
        status: ok ? "SUCCESS" : "FAILED",
        kind: rolledBack ? "AUTO_ROLLBACK" : "DEPLOY",
        logs: output,
        exitCode: result.exitCode,
        imageTag: ok && !plan.isCompose ? plan.runTag : null,
        registryImage: ok ? plan.registryRef : null,
        imageDigest: ok && !plan.isCompose ? (plan.swarm ? parseServiceImageDigest(output) : parseImageDigest(output)) : null,
        commitSha: cc?.sha ?? null,
        commitMessage: cc?.message ?? null,
        ...this.finishStamp(dep),
        ...clear,
      },
    });
    if (count !== 1) return;
    // The main command always ran on the live server (swapAttempted), so — exactly like the live path — the app
    // reflects the verdict: ok or rolled back → RUNNING, else FAILED.
    await this.prisma.application.update({ where: { id: app.id }, data: { status: ok || rolledBack ? AppStatus.RUNNING : AppStatus.FAILED } }).catch(() => undefined);
    // Post-deploy hook (classic path): the live path runs it after the status write; an adopted SUCCESS must too, or
    // e.g. migrations silently never run. Best-effort, never changes the verdict; output appended like the live path.
    if (ok && !plan.isCompose && plan.postDeploy && app.postDeployCommand?.trim()) {
      const pr = await this.agentWs
        .sendCommand(app.serverId, buildPostDeployScript(this.toSpec(app)), "deploy", this.deployTimeoutMs(app), (chunk) => this.deployLogs.push(app.id, chunk))
        .catch((e) => ({ output: e instanceof Error ? e.message : "post-deploy hook failed to run", exitCode: -1 }));
      if (pr?.output) await this.prisma.deployment.update({ where: { id: dep.id }, data: { logs: `${output}\n${pr.output}`.slice(0, 65536) } }).catch(() => undefined);
    }
    this.deployLogs.finish(app.id, { status: ok ? "SUCCESS" : "FAILED", exitCode: result.exitCode, deploymentId: dep.id });
    this.notifyDeploy(app, dep, ok ? "deploy_success" : rolledBack ? "deploy_rolled_back" : "deploy_failed").catch(() => {});
    if (ok && !plan.isCompose && !plan.swarm) void this.pruneImages(app).catch(() => undefined);
    else if (tagsToReap.length) await this.agentWs.sendCommand(app.serverId, buildImageRemoveScriptForTags(app.id, tagsToReap, await this.ownedVersionsFor(app, tagsToReap)), "cleanup").catch(() => undefined);
    await this.audit.log({ actor: dep.requestedBy ?? "system", action: "app.deploy", target: app.id });
    void this.drain(app.id);
  }

  /**
   * A dispatched deploy whose outcome can NOT be recovered (the agent restarted mid-command, has no journal of it,
   * never answered, or the deadline passed): the SAME terminal shape the boot reap writes (FAILED, exit -1, the
   * interrupted note) plus a one-line detail, so every consumer (rollouts: "interrupted → halt", the UI note)
   * keeps working. Application.status is deliberately NOT written — the live state is unknown and a serving app
   * must never be flipped to FAILED on hub-side uncertainty. Drains the app's queue so later QUEUED rows proceed.
   */
  async settleInterrupted(dep: { id: string; appId: string }, detail: string): Promise<boolean> {
    const { count } = await this.prisma.deployment.updateMany({
      where: { id: dep.id, status: "RUNNING" },
      data: { status: "FAILED", exitCode: -1, logs: `${INTERRUPTED_DEPLOY_NOTE}\n${detail}`, ownerId: null, phase: null },
    });
    if (count !== 1) return false;
    this.cancelRequested.delete(dep.id);
    this.logger.warn(`deploy ${dep.id} (app ${dep.appId}) settled as interrupted: ${detail}`);
    this.deployLogs.finish(dep.appId, { status: "FAILED", exitCode: -1, deploymentId: dep.id });
    void this.drain(dep.appId);
    return true;
  }

  /** Re-run a previous successful deployment's image without rebuilding/pulling. */
  async rollback(userId: string, id: string, targetDeploymentId: string) {
    const app = await this.requireMutate(userId, id, "apps:deploy");
    await this.ensureNoActiveDeploy(id); // don't race a running deploy/rollback (both write app.composeFile for compose)
    // Fail-closed, same as executeDeploy: a rollback re-runs the stored dockerOptions via `docker run`, so
    // re-validate them against the app's CURRENT privileged flag (covers the classic AND swarm paths, since
    // the clusterId branch below is reached only after this). A revoked override can never run here.
    assertSafeDockerOptions(app.dockerOptions, { allowPrivileged: app.allowPrivilegedDockerOptions });
    this.assertStoredCustomLabels(app);
    const target = await this.prisma.deployment.findFirst({
      where: { id: targetDeploymentId, appId: id, status: "SUCCESS" },
    });
    // Swarm app: roll the service back to the target deployment's image ref (no rebuild), not a classic run.
    if (app.clusterId) return this.rollbackSwarm(userId, app, target);
    const plan = await this.resolveRollbackSource(app, target);
    const dep = await this.createRollbackDeployment(app.id);
    await this.executeRollback(dep, app, plan, userId, targetDeploymentId);
    return this.prisma.deployment.findUnique({ where: { id: dep.id } });
  }

  /**
   * Fleet-rollout seam: the same classic rollback, but DETACHED — the RUNNING rollback row is returned at once
   * and the agent command runs in the background (the rollout engine judges the row later). Authorized like an
   * interactive rollback on every call (membership + per-resource scoping + apps:deploy). `key` makes the
   * dispatch at-most-once via the (appId, idempotencyKey) index: a retry after a crash finds the existing row.
   * A busy app (one RUNNING deploy per app) is a 409 the caller retries later. Swarm apps are refused (they are
   * never rollout targets).
   */
  async rollbackDetached(userId: string, appId: string, targetDeploymentId: string, opts: { key: string }): Promise<Deployment> {
    await this.require(userId, appId);
    const app = await this.requireMutate(userId, appId, "apps:deploy");
    if (app.clusterId) throw new ConflictException("swarm apps cannot be rolled back by a rollout");
    const prior = await this.prisma.deployment.findUnique({ where: { appId_idempotencyKey: { appId, idempotencyKey: opts.key } } });
    if (prior) {
      if (prior.trigger !== "rollout" || prior.requestedBy !== userId) throw new ConflictException("idempotency key collision: that rollback was not started by this rollout");
      return prior;
    }
    await this.ensureNoActiveDeploy(appId);
    assertSafeDockerOptions(app.dockerOptions, { allowPrivileged: app.allowPrivilegedDockerOptions });
    this.assertStoredCustomLabels(app);
    const target = await this.prisma.deployment.findFirst({ where: { id: targetDeploymentId, appId, status: "SUCCESS" } });
    const plan = await this.resolveRollbackSource(app, target);
    let dep: Deployment;
    try {
      dep = await this.createRollbackDeployment(app.id, { idempotencyKey: opts.key, trigger: "rollout", requestedBy: userId });
    } catch (e) {
      // Lost the key race (a concurrent identical dispatch) → adopt its row; the one-RUNNING-per-app 409 propagates.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && String(e.meta?.target ?? "").includes("idempotencyKey")) {
        const existing = await this.prisma.deployment.findUnique({ where: { appId_idempotencyKey: { appId, idempotencyKey: opts.key } } });
        if (existing) return existing;
      }
      throw e;
    }
    void this.executeRollback(dep, app, plan, userId, targetDeploymentId).catch(() => undefined);
    return dep;
  }

  /** How a classic (non-swarm) rollback re-materializes the target: the compose snapshot, or the retained local
   *  tag / a registry pull / the recorded digest. Resolved BEFORE any row is written, so an impossible rollback
   *  never touches the app's status. */
  private async resolveRollbackSource(
    app: Application,
    target: Deployment | null,
  ): Promise<{ isCompose: boolean; composeFile: string | null; registryPull: { auth: RegistryAuth; ref: string } | null; target: Deployment }> {
    const isCompose = app.source === "COMPOSE";
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
      // A deploy that ran on the app's PREVIOUS server (an app move happened since) and only has a local tag there
      // cannot be re-run here. NULL runServerId (legacy rows, every deploy since the last move) behaves as before.
      if (predatesMove(target, app.serverId)) {
        throw new ConflictException({ statusCode: 409, message: "that deployment ran on the app's previous server and only exists there as a local image — it can no longer be rolled back to", code: "rollback_predates_move" });
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
    return { isCompose, composeFile, registryPull, target: target! };
  }

  /** Run a prepared classic rollback against its already-created RUNNING row: agent command → terminal row →
   *  app status → drain. Shared by the interactive (awaited) and the detached (rollout) paths. */
  private async executeRollback(
    dep: Deployment,
    app: Application,
    plan: { isCompose: boolean; composeFile: string | null; registryPull: { auth: RegistryAuth; ref: string } | null; target: Deployment },
    userId: string,
    targetDeploymentId: string,
  ): Promise<void> {
    const { isCompose, composeFile, registryPull, target } = plan;
    // A throw BEFORE the agent command (proxy, spec, env, offline agent) never touched the live container: a still-
    // serving app must not be flipped to FAILED for it (mirrors executeDeploy's swapAttempted/wasRunning guard).
    const wasRunning = app.status === AppStatus.RUNNING;
    let dispatched = false;
    this.deployLogs.begin(app.id);
    try {
      if (app.domain) await this.proxy.ensureProxy(app.serverId);
      // For compose, derive the spec from the RESTORED compose file so its computed routing
      // (composeWebService + containerPort, which toSpec infers from the compose YAML) matches the
      // container actually being deployed — else a domain-routed app's Traefik override/labels would
      // point at the CURRENT version's service/port against the old container (silent 502 / phantom service).
      const spec = this.toSpec(isCompose ? { ...app, composeFile: composeFile! } : app);
      if (isCompose) spec.serviceDomains = await this.loadServiceDomains(app.id); // keep per-service routes on rollback
      this.logAutoMultiline(app.id, (await this.attachResolvedEnv(app, spec, { withBuild: false })).autoMultiline);
      await this.hydrateCertSpec(app, spec); // le-dns wildcard labels must match a normal deploy
      await this.hydrateDnsChallenge(app, spec);
      // A rollback re-runs a PRIOR image; never re-run deploy hooks (e.g. a migration) against it — a
      // registry/digest rollback is build=true, which would otherwise emit the pre-deploy step.
      spec.preDeployCommand = null;
      spec.postDeployCommand = null;
      spec.composeHookService = null;
      let command: string;
      if (isCompose) {
        command = buildComposeUpScript(spec);
      } else {
        // registryPull → build=true so prepSteps PULLS + tags; else build=false re-runs the local tag.
        if (registryPull) spec.registryPull = registryPull;
        // IMAGE app whose local tag was pruned + no registry push: reconstruct byte-exact by pulling
        // the recorded upstream digest (spec.registryAuth carries any private-registry credentials).
        else if (!target.imageTag && target.imageDigest) {
          spec.registryPull = { auth: spec.registryAuth, ref: target.imageDigest };
        }
        if (app.source === "GIT") spec.sourceCommit = target.commitSha ?? null; // no clone in this script: hub-injected, hex-validated at emission
        command = buildRunScript(spec, target.id, !!spec.registryPull);
      }
      dispatched = true;
      const r = await this.agentWs.sendCommand(
        app.serverId,
        command,
        "deploy",
        this.deployTimeoutMs(app) + this.opsBudgetMs(spec, false), // buildRunScript now contains a graceful stop
        (chunk) => this.deployLogs.push(app.id, chunk),
      );
      const ok = r.exitCode === 0;
      // The rollback script refuses (exit 7) when the target's LOCAL image is gone, WITHOUT removing the live
      // container (see buildRunScript), so the current version keeps serving. Don't flip a still-serving app
      // to FAILED in that case — the rollback failed, but nothing went down.
      const refusedImageGone = !ok && (r.exitCode === 7 || r.output.includes("TUGRA_ROLLBACK: image"));
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
          logs: `rolled back to ${target.id}\n${r.output.slice(0, 65000)}`,
          exitCode: r.exitCode,
          // Compose has no single rollback tag; record a snapshot so the rollback is itself a future
          // rollback target (mirrors the imageTag an IMAGE rollback records).
          imageTag: ok && !isCompose ? runTag(app, target.id) : null,
          registryImage: ok && !isCompose ? target.registryImage : null,
          // Carry the digest forward so the rollback deploy is itself a byte-exact rollback target.
          imageDigest: ok && !isCompose ? target.imageDigest : null,
          // Rollback re-runs a prior image (no clone) → show the commit that is now live, carried from the target.
          commitSha: ok && !isCompose ? target.commitSha : null,
          commitMessage: ok && !isCompose ? target.commitMessage : null,
          ...(ok && isCompose ? { configSnapshot: buildConfigSnapshot(spec) as object } : {}),
          ...this.finishStamp(dep),
        },
      });
      await this.prisma.application.update({
        where: { id: app.id },
        data: { status: ok ? AppStatus.RUNNING : refusedImageGone ? app.status : AppStatus.FAILED },
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
      if (dispatched || !wasRunning) {
        await this.prisma.application.update({
          where: { id: app.id },
          data: { status: AppStatus.FAILED },
        });
      }
      this.deployLogs.finish(app.id, { status: "FAILED", exitCode: -1, deploymentId: dep.id });
    } finally {
      // Rollback occupied the single RUNNING slot; resume any deploys that queued behind it.
      void this.drain(app.id);
    }
    await this.audit.log({
      actor: userId,
      action: "app.rollback",
      target: app.id,
      meta: { targetDeploymentId },
    });
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
      spec.customLabelsScrub = await this.prevSnapshotHadCustomLabels(app.id, dep.id);
      this.logAutoMultiline(app.id, (await this.attachResolvedEnv(app, spec, { withBuild: false })).autoMultiline);
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

  /** Keep the newest N rollback images (per-app imagesToKeep, else DEFAULT_DEPLOY_IMAGE_KEEP); remove older. */
  private async pruneImages(app: Application): Promise<void> {
    // Don't prune while a deploy or rollback is in flight for this app: the prune works off a snapshot, and a
    // concurrent rollback could start running a tag this prune is about to rmi. At most one RUNNING row per
    // app (partial unique index); the next successful deploy re-prunes. Fail closed — a count error skips.
    const inFlight = await this.prisma.deployment.count({ where: { appId: app.id, status: "RUNNING" } }).catch(() => 1);
    if (inFlight > 0) return;
    // Operator-tunable retention, clamped to 1..20 (1 is safe: the live version is always the newest SUCCESS row).
    const keep = Math.min(20, Math.max(1, app.imagesToKeep ?? DEFAULT_DEPLOY_IMAGE_KEEP));
    const kept = await this.prisma.deployment.findMany({
      where: { appId: app.id, status: "SUCCESS", imageTag: { not: null } },
      orderBy: { createdAt: "desc" },
    });
    const stale = kept.slice(keep);
    // A rollback row records its TARGET's tag, so several rows can share ONE tag. Never rmi a tag a RETAINED
    // (newest-N) row still points to — that would strip a live or rollbackable image out from under it; for
    // such a stale row just drop our record of it instead.
    const protectedTags = new Set<string>();
    for (const w of kept.slice(0, keep)) {
      if (w.imageTag) protectedTags.add(w.imageTag);
      if (w.registryImage) protectedTags.add(w.registryImage);
    }
    const owned = await this.ownedVersionsFor(app, stale.flatMap((d) => [d.imageTag, d.registryImage])); // undefined (no query) unless a custom ref / name is involved
    for (const d of stale) {
      try {
        // A pushed build leaves TWO local tags on the host — the local tugra_<id>:<v> and the registry ref —
        // so `rmi` both to actually free the layers (removing one only untags). registryImage stays as a DB
        // field so a rollback can still PULL it from the registry even though its local copy is gone.
        const targets = [d.imageTag, d.registryImage].filter((t): t is string => !!t && !protectedTags.has(t));
        if (targets.length > 0) {
          const r = await this.agentWs
            .sendCommand(app.serverId, buildImageRemoveScriptForTags(app.id, targets, owned), "cleanup", 60_000)
            .catch(() => null);
          // Forget the local tag only on a confirmed success, so a transient offline/timeout/non-zero doesn't
          // lose the rollback record while the image is still on disk — the next prune re-selects this stale
          // row and retries (an already-absent tag counts as success, so it converges).
          if (!r || r.exitCode !== 0) continue;
        }
        await this.prisma.deployment.update({ where: { id: d.id }, data: { imageTag: null } });
      } catch {
        // one stale row's failure must never abort the rest or throw out of the (detached) prune
      }
    }
  }

  /** The app's OWN deployment ids, for `buildImageRemoveScriptForTags`' custom-name guard: with a custom pushed repo
   *  name the local registry tags no longer sit in `tugra_<id>:`, so a tag is only removable when its version (the
   *  part after the last ":") is one of these Tugra-generated ids. Driven by the CANDIDATE tags, not by the app's
   *  current pushImageName: clearing the name must not strand the old custom-named tags (their rows keep the old
   *  registry ref). No custom ref among the tags and no custom name -> `undefined` and no query, so every other
   *  cleanup script stays byte-identical. */
  private async ownedVersionsFor(
    app: { id: string; pushImageName?: string | null },
    tags: Array<string | null | undefined> = [],
  ): Promise<ReadonlySet<string> | undefined> {
    const seg = `${containerName({ id: app.id })}:`;
    const custom = !!app.pushImageName || tags.some((t) => !!t && !t.startsWith(seg) && !t.includes(`/${seg}`));
    if (!custom) return undefined;
    const rows = await this.prisma.deployment.findMany({ where: { appId: app.id }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
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
    return this.view(updated, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, undefined, await this.serverIp(updated.serverId), { imageLive: await this.loadImageLive(updated) });
  }

  async stop(userId: string, id: string): Promise<void> {
    const app = await this.requireMutate(userId, id, "apps:deploy");
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
      const cmd = app.source === "COMPOSE" ? buildComposeStopScript(await this.composeOpSpec(app)) : buildStopScript(app);
      const res = await this.agentWs.sendCommand(app.serverId, cmd, "deploy", this.lifecycleTimeoutMs(app));
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`stop failed (exit ${res.exitCode}) — the app's status is unchanged`);
    }
    await this.prisma.application.update({
      where: { id },
      data: { status: AppStatus.STOPPED },
    });
    await this.audit.log({ actor: userId, action: "app.stop", target: id });
  }

  async start(userId: string, id: string): Promise<void> {
    const app = await this.requireMutate(userId, id, "apps:deploy");
    if (app.clusterId) {
      const res = await this.swarmDeploy.scale(app, Math.max(1, app.replicas ?? 1));
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`start did not converge (exit ${res.exitCode}) — the app's status is unchanged`);
    } else {
      // `docker start`/`compose start` exit non-zero when the container/project is gone — verify instead of
      // falsely reporting RUNNING (see stop()). Pre-check online for a clean 503 rather than an opaque 500.
      if (!this.agentWs.isOnline(app.serverId)) throw new ServiceUnavailableException("agent offline");
      const cmd = app.source === "COMPOSE" ? buildComposeStartScript(await this.composeOpSpec(app)) : buildStartScript(app);
      const res = await this.agentWs.sendCommand(app.serverId, cmd, "deploy", LIFECYCLE_TIMEOUT_MS);
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`start failed (exit ${res.exitCode}) — the app's status is unchanged`);
    }
    await this.prisma.application.update({ where: { id }, data: { status: AppStatus.RUNNING } });
    await this.audit.log({ actor: userId, action: "app.start", target: id });
  }

  async restart(userId: string, id: string): Promise<void> {
    const app = await this.requireMutate(userId, id, "apps:deploy");
    if (app.clusterId) {
      // Swarm restart = a forced rolling recreation of all tasks (async; the builder polls to convergence).
      const res = await this.swarmDeploy.restart(app);
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`restart did not converge (exit ${res.exitCode}) — the app's status is unchanged`);
    } else {
      // `docker restart`/`compose restart` exit non-zero when the container/project is gone — verify instead of
      // falsely reporting RUNNING (see stop()). Pre-check online for a clean 503 rather than an opaque 500.
      if (!this.agentWs.isOnline(app.serverId)) throw new ServiceUnavailableException("agent offline");
      const cmd = app.source === "COMPOSE" ? buildComposeRestartScript(await this.composeOpSpec(app)) : buildRestartScript(app);
      const res = await this.agentWs.sendCommand(app.serverId, cmd, "deploy", this.lifecycleTimeoutMs(app));
      if (res.exitCode !== 0) throw new ServiceUnavailableException(`restart failed (exit ${res.exitCode}) — the app's status is unchanged`);
    }
    await this.prisma.application.update({ where: { id }, data: { status: AppStatus.RUNNING } });
    await this.audit.log({ actor: userId, action: "app.restart", target: id });
  }

  /**
   * The user-named networks this app may take down with it: its own `networks[]` minus anything reserved, minus
   * any name another app on the same server still lists (server-wide, stricter than the cross-team alias rule).
   * Empty for an app with a raw `--network` (the operator owns its networking). The script additionally gates on
   * the Tugra ownership label, so a hand-made or pre-label network is never removed.
   */
  private async removableNetworks(app: Application): Promise<string[]> {
    if (hasNetworkOpt(app.dockerOptions)) return [];
    const candidates = [...new Set(app.networks ?? [])].filter((n) => n !== APPS_NETWORK && isUserNetworkNameAllowed(n));
    if (!candidates.length) return [];
    const others = await this.prisma.application.findMany({
      where: { serverId: app.serverId, id: { not: app.id }, networks: { hasSome: candidates } },
      select: { networks: true },
    });
    const shared = new Set(others.flatMap((o) => o.networks ?? []));
    return candidates.filter((n) => !shared.has(n));
  }

  async remove(
    userId: string,
    id: string,
    opts: { keepVolumes?: boolean; removeImages?: boolean; pruneNetworks?: boolean; pruneBuildCache?: boolean } = {},
  ): Promise<void> {
    const app = await this.requireMutate(userId, id);
    // Refuse before any side effect (never a silent ignore): a compose stack removes its own networks on `down`,
    // swarm cleanup isn't wired, and only built apps have a build cache to prune.
    if (opts.pruneNetworks && (app.source === "COMPOSE" || app.clusterId)) {
      throw new BadRequestException(app.clusterId ? "network cleanup isn't supported for swarm apps" : "a compose stack removes its own networks when it comes down");
    }
    if (opts.pruneBuildCache && (app.source === "IMAGE" || app.clusterId)) {
      throw new BadRequestException(app.clusterId ? "build cache cleanup isn't supported for swarm apps" : "only apps built on this host have a build cache to prune");
    }
    const prunedNetworks = opts.pruneNetworks ? await this.removableNetworks(app) : [];
    // Outcome of the remove script (the only thing that carries the network cleanup) — recorded in the audit
    // as fact, separately from what was merely planned.
    let removeScriptOk = false;
    if (app.clusterId) {
      // Swarm: remove the service cluster-wide (Swarm tears down every task on every node). Per-node image
      // cleanup isn't wired for swarm, so removeImages is a classic-only option (ignored here).
      await this.swarmDeploy.remove(app).catch(() => undefined);
    } else {
      // keepVolumes: leave the app's named volumes / compose volumes on the host (the user opted to keep
      // their data). Default removes them — deleting an app frees its disk, as before.
      // A project adopted in place is the user's own: deleting the app only UNREGISTERS it. Its containers, volumes and
      // files are left exactly as they are (no compose down, no volume removal).
      const unregisterOnly = app.source === "COMPOSE" && !!adoptedCompose(app);
      let cmd =
        app.source === "COMPOSE"
          ? buildComposeDownScript(await this.composeOpSpec(app), { volumes: !opts.keepVolumes })
          : buildRemoveScript(app, opts.keepVolumes ? [] : this.appVolumes(app), { networks: prunedNetworks });
      // removeImages: also drop the app's OWN locally-stored image tags (tugra_<appId>:*) to reclaim disk.
      // IMAGE/GIT only — a COMPOSE app's images are its upstream/compose-built tags, not in this namespace,
      // so we never risk removing a shared base image.
      if (opts.removeImages && app.source !== "COMPOSE") {
        cmd += "\n" + buildAppImagesRemoveScript(app);
      }
      if (!unregisterOnly) {
        const res = await this.agentWs.sendCommand(app.serverId, cmd, "deploy").catch(() => undefined);
        removeScriptOk = res?.exitCode === 0;
      }
    }
    // Build cache is host-global (no per-app purge): prune dangling records on the host that actually builds this
    // app — its build server for a non-compose app, else the run server. Dispatched AFTER the row is deleted
    // (so layers just orphaned by the app are included) and DETACHED: a prune can take minutes and must never
    // hold the DELETE open. Best-effort: an offline host never blocks the delete.
    const pruneHost = opts.pruneBuildCache ? (app.source !== "COMPOSE" && app.buildServerId ? app.buildServerId : app.serverId) : null;
    // Drop the app's uploaded custom cert from the proxy's /dynamic (best-effort; classic apps only — a
    // clustered app's cert lives on the manager's swarm proxy, a separate path).
    if (app.certPem && !app.clusterId) {
      await this.agentWs.sendCommand(app.serverId, buildCustomCertRemoveScript(app.id), "deploy").catch(() => undefined);
    }
    await this.monitors.removeForApp(id).catch(() => undefined);
    // A COMPLETED app move keeps the app's old data on its previous server until the archive is purged; deleting the
    // app must not strand it (best-effort: an offline server is simply left to the move's own sweeper, which keeps
    // running because AppMove rows have no foreign key to the app). With keepVolumes the user asked to KEEP the data:
    // the archive is a copy of it, so it stays too, and the sweeper reclaims it after `archiveUntil` as usual.
    if (!opts.keepVolumes) {
      const archives = await this.prisma.appMove.findMany({ where: { appId: id, phase: "COMPLETED", sourcePurgedAt: null } });
      for (const m of archives) await purgeMoveSource({ prisma: this.prisma as never, agentWs: this.agentWs as never }, m, { stampWhenLive: false }).catch(() => undefined);
    }
    // Best-effort: remove the Cloudflare records Tugra auto-created for this app BEFORE the Domain rows cascade
    // away (otherwise they'd dangle at the provider). Never blocks deletion — the user already passed requireWrite.
    await this.dns.purgeDomains(userId, id).catch(() => undefined);
    // The app's log drains cascade away with the row: resolve the servers they were shipping from BEFORE the
    // delete, re-push their (now smaller) drain sets AFTER it.
    const drainTargets = await this.logDrainPush.targetServerIds(app).catch(() => [] as string[]);
    await this.prisma.application.delete({ where: { id } });
    void this.logDrainPush.pushForServers(drainTargets).catch(() => undefined);
    let buildCacheDispatched = false;
    if (pruneHost && this.agentWs.isOnline(pruneHost)) {
      buildCacheDispatched = true;
      void this.agentWs
        .sendCommand(pruneHost, buildBuildCachePruneScript(), "deploy", 300_000)
        .then((r) => {
          if (r.exitCode !== 0) this.logger.warn(`build-cache prune after deleting app ${id} exited ${r.exitCode}`);
        })
        .catch((e: unknown) => this.logger.warn(`build-cache prune after deleting app ${id} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    // Drop the deleted app's stale rule from its server's tunnel ingress (recomputed from DB truth).
    if (app.tunnelExposed) await this.syncTunnelIngress(app.serverId);
    // Intent (planned / requested) is recorded apart from outcome (dispatched) — a command that never ran or
    // an offline host must not read as done.
    await this.audit.log({
      actor: userId,
      action: "app.remove",
      target: id,
      ...(opts.pruneNetworks || opts.pruneBuildCache
        ? {
            meta: {
              networksPlanned: prunedNetworks,
              networksDispatched: removeScriptOk && prunedNetworks.length > 0,
              pruneBuildCacheRequested: !!opts.pruneBuildCache,
              buildCacheDispatched,
            },
          }
        : {}),
    });
  }

  /** Compensating delete for a create() that must be undone before any deploy ran (e.g. the
   *  migrator's adopt when its `docker rename` fails): drop the monitor + row, run NO docker —
   *  a deploy:false app never touched the host, and the foreign container must stay intact. */
  async discardUndeployed(appId: string): Promise<void> {
    await this.monitors.removeForApp(appId).catch(() => undefined);
    await this.prisma.application.delete({ where: { id: appId } }).catch(() => undefined);
  }

  async deployments(userId: string, id: string, opts: { slim?: boolean } = {}) {
    // Writer-only: each row carries the raw build/deploy `logs`, which can contain secrets (DSN, tokens,
    // .env dumps in build output) — same rationale as appLogs/listContainers. A VIEWER must not read them.
    const app = await this.requireWrite(userId, id);
    const isCompose = app.source === "COMPOSE";
    const rows = await this.prisma.deployment.findMany({
      where: { appId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    // Diff each deploy's config against the immediately older one (rows are newest-first, so the previous
    // deploy is the next index). `slim` drops the heavy `logs` column for the list view (rollout/hasLogs are
    // computed first); the detail endpoint serves the full log of one row.
    return rows.map((d, i) => toDeploymentRow(d, { isCompose, prevSnapshot: (rows[i + 1]?.configSnapshot as ConfigSnapshot | null) ?? null, slim: opts.slim, currentServerId: app.serverId }));
  }

  /**
   * ONE deployment with everything the detail page shows: the shared row (full log, diff, rollbackable) plus
   * derived facts — the diff base (nearest OLDER row with a snapshot, not just the list's neighbour), whether it
   * is the current version, whether it can be cancelled right now, the derived finish time, who asked for it
   * (display name, never a raw id) and an honest note (interrupted / recovering / auto-rollback / cancelled).
   * Writer-only like the list; 404 for a depId that does not belong to this app (no cross-app reads).
   */
  async deploymentDetail(userId: string, id: string, depId: string) {
    const app = await this.requireWrite(userId, id);
    const d = await this.prisma.deployment.findFirst({ where: { id: depId, appId: id } });
    if (!d) throw new NotFoundException("deployment not found");
    const [base, latestSuccess, user] = await Promise.all([
      this.prisma.deployment.findFirst({
        where: { appId: id, createdAt: { lt: d.createdAt }, configSnapshot: { not: Prisma.DbNull } },
        orderBy: { createdAt: "desc" },
        select: { id: true, createdAt: true, configSnapshot: true },
      }),
      this.prisma.deployment.findFirst({ where: { appId: id, status: "SUCCESS" }, orderBy: { createdAt: "desc" }, select: { id: true } }),
      d.requestedBy && !["webhook", "webhook:pr", "system"].includes(d.requestedBy)
        ? this.prisma.user.findUnique({ where: { id: d.requestedBy }, select: { name: true, email: true } }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const row = toDeploymentRow(d, { isCompose: app.source === "COMPOSE", prevSnapshot: (base?.configSnapshot as ConfigSnapshot | null) ?? null, currentServerId: app.serverId });
    const cancellable =
      d.status === "QUEUED" ||
      (d.status === "RUNNING" && !isSwarmDispatch(d) && (this.activeDeployCommands.has(d.id) || (!!d.agentReqId && !!d.agentServerId && (d.phase === "DISPATCHED" || d.phase === "RECOVERING"))));
    const finishedAt = finishedAtOf(d);
    return {
      ...row,
      // The base is meaningful only when THIS row has a snapshot to diff (a QUEUED/legacy row without one shows no diff).
      diffBase: base && d.configSnapshot ? { id: base.id, createdAt: base.createdAt } : null,
      isCurrent: latestSuccess?.id === d.id,
      cancellable,
      finishedAt,
      actor: classifyActor(d, user ? (user.name?.trim() || user.email || null) : null),
      note: classifyNote(d),
    };
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
      buildLogsScript(app.source === "COMPOSE" ? await this.composeOpSpec(app) : this.toSpec(app), tail),
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
    const dockerName = this.resolveFsVolume(app, volumeName);
    const rel = assertSafeFsPath(path);
    const targetServer = this.resolveFsVolumeHost(app);
    return this.agentWs.sendFsReq(targetServer, "list", dockerName, rel);
  }

  /** The docker volume name behind one of the app's browsable volume KEYS (400 for anything else). */
  private resolveFsVolume(app: Application, volumeName: string): string {
    if (app.source === "COMPOSE") {
      // Only a Tugra-owned, auto-named compose volume (tugra_<id>_<key>) is browsable — never an
      // external or custom-named volume, which could point at another app's or a host volume.
      const cv = composeVolumes(app).find((v) => v.key === volumeName);
      if (!cv || !cv.browsable) throw new BadRequestException("unknown volume for this app");
      return cv.dockerName;
    }
    const declared =
      Array.isArray(app.volumes) &&
      (app.volumes as Array<{ name?: string }>).some((v) => v?.name === volumeName);
    if (!declared) throw new BadRequestException("unknown volume for this app");
    return appVolumeName(app, volumeName);
  }

  /** The server whose agent holds the app's volumes. A swarm (clustered) app's stateful volume lives on the node
   *  it is PINNED to (constraintServerId), not on app.serverId (the cluster's entry/manager) — targeting serverId
   *  would browse the wrong host's filesystem. 400 when unpinned, 503 when that agent is offline. */
  private resolveFsVolumeHost(app: Application): string {
    let targetServer = app.serverId;
    if (app.clusterId) {
      if (!app.constraintServerId) throw new BadRequestException("clustered app has no pinned node to browse");
      targetServer = app.constraintServerId;
    }
    if (!this.agentWs.isOnline(targetServer)) throw new ServiceUnavailableException("agent offline");
    return targetServer;
  }

  /** The browsable volume KEYS of an app (what the `volume` request parameter may be). */
  fsVolumeKeys(app: Application): string[] {
    if (app.source === "COMPOSE") return composeVolumes(app).filter((v) => v.browsable).map((v) => v.key);
    return Array.isArray(app.volumes)
      ? (app.volumes as Array<{ name?: string }>).map((v) => v?.name).filter((n): n is string => typeof n === "string")
      : [];
  }

  /**
   * Resolve a file-manager target (one declared volume OR the live container filesystem) to the server, scope and
   * subject the agent is signed for. `mutating` additionally refuses while a deploy is queued/running.
   *
   * Volume branch = the listFiles resolution verbatim (permission, browsable-compose rule, declared volumes,
   * clustered pin, offline). Container branch additionally needs the team permission `terminal` (the terminal's
   * gate; the daemon-side reads and writes are container-root, see ContainerFilesController), refuses clustered apps and never-deployed apps, and only resolves containers that
   * belong to this app (single container: derived; compose: the `tugra_<id>` project prefix + charset).
   */
  async resolveFsTarget(
    userId: string,
    id: string,
    target: { volume?: string; container?: string },
    opts: { mutating: boolean },
  ): Promise<{ app: Application; serverId: string; scope: "volume" | "container"; subject: string }> {
    const app = await this.requireWrite(userId, id);
    let serverId: string;
    let scope: "volume" | "container";
    let subject: string;
    if (target.container !== undefined) {
      await this.access.requirePermission(userId, app.teamId, "terminal");
      if (app.clusterId) throw new BadRequestException({ statusCode: 400, message: "the container filesystem is not available for clustered apps", code: "unsupported_clustered" });
      if (app.status === AppStatus.NEW) throw new ConflictException({ statusCode: 409, message: "app has not been deployed yet", code: "not_deployed" });
      subject = app.source === "COMPOSE" ? this.resolveLogTarget(app, target.container) : containerName(app);
      if (/__(rollout|prev)$/.test(subject)) throw new BadRequestException("invalid container for this app");
      if (!this.agentWs.isOnline(app.serverId)) throw new ServiceUnavailableException("agent offline");
      serverId = app.serverId;
      scope = "container";
    } else {
      subject = this.resolveFsVolume(app, target.volume ?? "");
      serverId = this.resolveFsVolumeHost(app);
      scope = "volume";
    }
    if (opts.mutating) await this.assertNoActiveDeploy(app.id);
    return { app, serverId, scope, subject };
  }

  /**
   * 409 `deploy_in_progress` while a deployment of the app is queued or running (file changes are paused). Also called
   * right before an upload is dispatched, because the body can take minutes to stage. Best-effort by nature: a deploy
   * may still start right after the check, which only shrinks the window from minutes to milliseconds.
   */
  async assertNoActiveDeploy(appId: string): Promise<void> {
    const active = await this.prisma.deployment.findFirst({ where: { appId, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
    if (active) throw new ConflictException({ statusCode: 409, message: "a deploy is in progress — file changes are paused until it finishes", code: "deploy_in_progress" });
    await assertNoActiveMove(this.prisma, appId); // a move is copying the volumes: file changes would be lost or torn
  }

  /**
   * Everything the file-manager meta endpoint needs about an app, behind the same `apps:config` writer check as
   * every other file route. `canTerminal` is the non-throwing form of the container route's permission.
   */
  async fsContext(userId: string, id: string): Promise<{
    app: Application;
    canTerminal: boolean;
    volumeKeys: string[];
    volumeServerId: string | null;
    deployInProgress: boolean;
  }> {
    const app = await this.requireWrite(userId, id);
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    const volumeServerId = app.clusterId ? app.constraintServerId : app.serverId;
    const active = await this.prisma.deployment.findFirst({ where: { appId: app.id, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
    return {
      app,
      canTerminal: !!perms?.has("terminal"),
      volumeKeys: this.fsVolumeKeys(app),
      volumeServerId: volumeServerId ?? null,
      deployInProgress: !!active,
    };
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
    this.assertHasContainerLogs(app);
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
    this.assertHasContainerLogs(app);
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
    this.assertHasContainerLogs(app);
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

  /**
   * A NEW app has never been deployed, so there is no container (or swarm service) to read logs
   * from: `docker logs` would only answer "No such container", and a follow stream would re-emit
   * that line on every reconnect. Refuse up front with a clear 409 instead of relaying daemon noise.
   */
  private assertHasContainerLogs(app: Pick<Application, "status">): void {
    if (app.status === "NEW") throw new ConflictException("app has not been deployed yet — no container logs");
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
   * Last-known container state + recent crash/OOM episodes for the app (the "why does it keep restarting"
   * timeline), read from the container-health poll's ContainerState / ContainerEvent tables. Read-level
   * (`require` — any team member, incl. READER) and DB-only (no agent round-trip). The raw pre-crash log
   * tail is gated: returned only to a caller that both holds `apps:config` AND may read secrets
   * (`includeLog`); everyone else gets `logTail: null` + `logRedacted: true`, since the tail is unredacted
   * container output that can carry secrets.
   */
  async runtimeState(userId: string, id: string, includeLog: boolean): Promise<AppRuntimeState> {
    const app = await this.require(userId, id);
    const serverIds = app.clusterId
      ? (await this.prisma.server.findMany({ where: { clusterId: app.clusterId }, select: { id: true } })).map((s) => s.id)
      : [app.serverId];
    // The same airtight prefix match the metrics path uses: the delimiter (`-`/`.`) keeps a sibling app
    // whose id merely starts with this one's from leaking in; swarm task containers carry a `.` suffix.
    // The `__rollout` candidate is the rolling-deploy's not-yet-live container — its crash/OOM is exactly
    // the "why did my new version fail to come up" case, so match it too (exact, so still sibling-safe).
    const nameMatch = this.containerNameFilter(app, { withRollout: true });
    const canLog = includeLog && ((await this.access.membershipPermissions(userId, app.teamId))?.has("apps:config") ?? false);

    const [states, events] = await Promise.all([
      this.prisma.containerState.findMany({
        where: { serverId: { in: serverIds }, OR: nameMatch },
        select: { containerName: true, status: true, exitCode: true, oomKilled: true, restartCount: true, health: true, startedAt: true, finishedAt: true },
        orderBy: { containerName: "asc" }, // stable row order so the web badges don't reshuffle between polls
      }),
      this.prisma.containerEvent.findMany({
        where: { serverId: { in: serverIds }, OR: nameMatch },
        orderBy: [{ ts: "desc" }, { id: "desc" }], // id tiebreaker keeps same-timestamp episodes deterministic
        take: 20,
      }),
    ]);

    return {
      containers: states.map((s) => ({
        containerName: s.containerName,
        status: s.status,
        exitCode: s.exitCode,
        oomKilled: s.oomKilled,
        restartCount: s.restartCount,
        health: s.health,
        startedAt: s.startedAt ? s.startedAt.toISOString() : null,
        finishedAt: s.finishedAt ? s.finishedAt.toISOString() : null,
      })),
      events: events.map((e) => ({
        id: e.id,
        containerName: e.containerName,
        ts: e.ts.toISOString(),
        kind: e.kind,
        exitCode: e.exitCode,
        oomKilled: e.oomKilled,
        restartCount: e.restartCount,
        restartDelta: e.restartDelta,
        reason: e.reason,
        logTail: canLog ? e.logTail : null,
        logRedacted: !canLog && e.logTail != null,
      })),
    };
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

  /**
   * Replace the app's env. `flags` OMITTED keeps the stored per-variable flags (pruned to the keys that survive,
   * so an old client that only knows `env` never loses them); PRESENT is an authoritative replace (`{}` clears).
   * Both columns are written in ONE update so they can never drift. The line-break / NUL / flag invariants are
   * enforced here (not just in zod) so MCP, the importer and every other writer get them too.
   */
  async setEnv(userId: string, id: string, env: Record<string, string>, flags?: Record<string, FlagInput>): Promise<void> {
    const app = await this.requireMutate(userId, id);
    if (Object.keys(env).length) this.assertNotAdopted(app, "environment variables");
    const keys = Object.keys(env);
    let oldMeta: EnvMeta | null = null;
    try {
      oldMeta = this.loadMeta(app);
    } catch (e) {
      if (!(e instanceof EnvMetaCorruptError)) throw e;
    }
    let meta: EnvMeta;
    if (flags === undefined) {
      if (!oldMeta) throw new ConflictException("stored variable flags are unreadable; resend the full set with an explicit flags object");
      meta = pruneMeta(oldMeta, keys);
    } else {
      meta = normalizeFlags(flags, keys);
    }
    const issues = validateEnvFlags(env, meta, { source: app.source, buildSecretKeys: new Set(Object.keys(this.appBuildSecrets(app))), mode: "write" });
    if (issues.length) throw new BadRequestException(issues[0].message);
    await this.prisma.application.update({
      where: { id },
      data: { envEnc: this.crypto.encrypt(JSON.stringify(env)), envMetaEnc: this.encryptMeta(meta) },
    });
    const hadFlags = !!oldMeta && Object.keys(oldMeta).length > 0;
    const hasFlags = Object.keys(meta).length > 0;
    await this.audit.log({
      actor: userId,
      action: "app.env.update",
      target: id,
      ...(hadFlags || hasFlags ? { meta: { keys: keys.length, flagged: Object.keys(meta).length } } : {}), // COUNTS ONLY: no names, no values
    });
  }

  /** Per-variable flags (writer-only: names and usage are not shown to read-only roles). Full booleans per entry. */
  async getEnvFlags(userId: string, id: string) {
    const app = await this.requireWrite(userId, id);
    const meta = this.loadMetaOrConflict(app);
    const flags: Record<string, { buildTime: boolean; runtime: boolean; literal: boolean; multiline: boolean }> = {};
    for (const k of Object.keys(meta)) {
      const f = meta[k];
      flags[k] = { buildTime: f.buildTime === true, runtime: f.runtime !== false, literal: f.literal === true, multiline: f.multiline === true };
    }
    return {
      flags,
      applicable: { buildTime: app.source === "GIT", literal: app.source === "COMPOSE" },
      limits: { multilineValueBytes: ML_VALUE_MAX_BYTES, multilineKeys: ML_KEYS_MAX, multilineTotalBytes: ML_TOTAL_MAX_BYTES, buildTotalBytes: BUILD_FLAG_TOTAL_MAX_BYTES },
    };
  }

  /**
   * Opt an app into (or out of) the node-local managed-DB network (tugra-net) so its container resolves
   * `tugra_db_<id>` by name. Turning it ON is refused unless the app can actually use that node-local bridge:
   * a classic (non-swarm) app, not COMPOSE (those declare their own networks), with no conflicting --network
   * in docker options, and at least one managed database on the SAME server. Takes effect on the NEXT deploy
   * (no live reattach); turning it OFF is always allowed (the next deploy drops the network). Writer-gated.
   */
  async setDbNetwork(userId: string, id: string, on: boolean): Promise<void> {
    const app = await this.requireMutate(userId, id);
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
    await this.requireMutate(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: { buildArgsEnc: this.crypto.encrypt(JSON.stringify(buildArgs)) },
    });
    await this.audit.log({ actor: userId, action: "app.build_args.update", target: id });
  }

  /** Build-time SECRETS (BuildKit --secret mounts). Writer-only like the raw env/build args. */
  async getBuildSecrets(userId: string, id: string): Promise<Record<string, string>> {
    const app = await this.requireWrite(userId, id);
    return this.appBuildSecrets(app);
  }

  /** Only a DOCKERFILE build can consume a secret mount (`RUN --mount=type=secret`); refuse elsewhere so a value
   *  is never stored believing it is protected when the builder would silently ignore it. */
  async setBuildSecrets(userId: string, id: string, buildSecrets: Record<string, string>): Promise<void> {
    const app = await this.requireMutate(userId, id);
    if (Object.keys(buildSecrets).length && (app.source !== "GIT" || app.buildType !== "DOCKERFILE")) {
      throw new BadRequestException("build secrets are mounted by Dockerfile builds only (RUN --mount=type=secret); this app's builder cannot consume them");
    }
    await this.prisma.application.update({
      where: { id },
      data: { buildSecretsEnc: Object.keys(buildSecrets).length ? this.crypto.encrypt(JSON.stringify(buildSecrets)) : null },
    });
    // Keys only — never the values.
    await this.audit.log({ actor: userId, action: "app.build_secrets.update", target: id, meta: { keys: Object.keys(buildSecrets) } });
  }

  async rename(userId: string, id: string, name: string): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({ where: { id }, data: { name } });
    await this.audit.log({ actor: userId, action: "app.name.update", target: id });
  }

  /** Set the app's free-text description (operator note). Trimmed; empty → null. Display-only metadata,
   *  so it never touches the deploy spec. */
  async setDescription(userId: string, id: string, description: string | null): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({ where: { id }, data: { description: description?.trim() || null } });
    await this.audit.log({ actor: userId, action: "app.description.update", target: id });
  }

  async setDockerOptions(userId: string, id: string, dockerOptions: string | null): Promise<void> {
    const app = await this.requireMutate(userId, id);
    // Validate at set-time (clear 400 now, not a failed deploy later): reject an unterminated quote AND any
    // host-escaping flag (--privileged, docker.sock/host-path bind, host namespaces, host devices,
    // non-allowlisted --cap-add) — UNLESS the instance owner opted this app in (flag read from the DB row,
    // never the request, so a member can't self-grant). The traefik.*/--name/--env-file blocks still apply.
    // Shell-injection itself is neutralized at deploy time by dockerOptionsArgs.
    assertSafeDockerOptions(dockerOptions, { allowPrivileged: app.allowPrivilegedDockerOptions });
    // A DB-network-linked app manages its own --network; a conflicting one here would be ambiguous.
    if (app.dbNetwork && hasNetworkOpt(dockerOptions)) {
      throw new BadRequestException("this app is linked to the managed-DB network — remove --network here, or unlink the DB network first");
    }
    // Extra networks / a stable alias are attached by Tugra itself; a raw --network would make that ambiguous.
    if ((app.networks?.length || app.containerAlias) && hasNetworkOpt(dockerOptions)) {
      throw new BadRequestException("remove the extra networks / alias first, or drop --network here");
    }
    // A raw `--entrypoint` here would collide with a structured container-entrypoint override (docker takes
    // the LAST one — order-dependent). Refuse rather than silently depend on flag order. (The reverse
    // direction is checked in setContainerCommand.)
    if (this.argv(app.containerEntrypoint) && tokenizeDockerOptions(dockerOptions).some((t) => /^--entrypoint(=|$)/.test(t))) {
      throw new BadRequestException("this app has a container entrypoint override — clear it before adding --entrypoint to Docker options");
    }
    // A raw `--label` that collides with a structured custom label would make the result flag-order dependent.
    // Refuse (never rewrite the string). Not applicable on swarm, where dockerOptions is not applied. The reverse
    // direction is checked in setCustomLabels.
    const stored = !app.clusterId ? this.storedCustomLabels(app.customLabels) : null;
    if (stored) {
      const have = new Set(Object.keys(stored).map((k) => k.toLowerCase()));
      const hit = dockerOptionLabels(dockerOptions).find((l) => have.has(l.key.toLowerCase()));
      if (hit) throw new BadRequestException(`label "${hit.key}" is a custom label; remove it there first`);
    }
    await this.prisma.application.update({ where: { id }, data: { dockerOptions } });
    await this.audit.log({ actor: userId, action: "app.docker_options.update", target: id });
  }

  /** Replace the app's custom container labels (classic docker-run + swarm). `{}` is "Reset to defaults": Tugra's
   *  own labels are derived on every deploy and never stored, so a reset just clears the column. Write-gated;
   *  refused for COMPOSE (labels live in the compose YAML) and previews; the audit record carries the key NAMES
   *  and count, never the values (values can be tokens). Applies on the next deploy. */
  async setCustomLabels(userId: string, id: string, input: SetCustomLabelsInput): Promise<void> {
    const app = await this.requireMutate(userId, id);
    if (app.source === "COMPOSE") throw new BadRequestException("compose apps declare labels in the compose file");
    if (app.isPreview) throw new BadRequestException("preview apps do not support custom labels");
    await this.ensureNoActiveDeploy(id);
    const clean = assertSafeCustomLabels(input.labels, { dockerOptions: app.clusterId ? null : app.dockerOptions });
    const keys = Object.keys(clean).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted = Object.fromEntries(keys.map((k) => [k, clean[k]]));
    await this.prisma.application.update({
      where: { id },
      data: { customLabels: keys.length ? (sorted as Prisma.InputJsonValue) : Prisma.DbNull },
    });
    await this.audit.log({ actor: userId, action: "app.custom_labels.update", target: id, meta: { count: keys.length, keys } });
  }

  /** Every label Tugra applies to this app (read-only, derived from the same builders the deploy scripts use) plus
   *  the operator's custom labels. Writer-only. Never calls the secret-decrypting toSpec. */
  async getAppLabels(userId: string, id: string): Promise<AppLabelsView> {
    const app = await this.requireWrite(userId, id);
    const compose = app.source === "COMPOSE";
    const web = compose ? this.composeWeb(app) : null;
    // le-dns wildcard / custom resolver come from the server config (hydrateCertSpec); reuse it on a throwaway shell.
    const certCfg: { wildcardDomain?: string | null; customCertResolver?: string | null } = {};
    await this.hydrateCertSpec(app, certCfg as unknown as AppSpec);
    // Per-host DNS-01 (dnsChallenge): the preview must show the same resolver the deploy will use.
    const dnsCfg: { certType?: string; dnsPerHost?: boolean; wildcardDomain?: string | null } = {};
    await this.hydrateDnsChallenge(app, dnsCfg as unknown as AppSpec, true);
    return buildAppliedLabels({
      source: app.source,
      clusterId: app.clusterId,
      isPreview: app.isPreview,
      label: {
        id: app.id,
        source: app.source,
        domain: app.domain,
        domainRedirect: (app.domainRedirect as "www" | "root" | null) ?? null,
        pathPrefix: app.pathPrefix ?? null,
        stripPrefix: app.stripPrefix ?? true,
        certType: dnsCfg.certType ?? app.certType,
        ...(dnsCfg.dnsPerHost ? { dnsPerHost: true } : {}),
        wildcardDomain: dnsCfg.dnsPerHost ? null : (certCfg.wildcardDomain ?? null),
        customCertResolver: certCfg.customCertResolver ?? null,
        // Presence only: the PEM/key never enter the view. A clustered app is never given a custom cert (as in toSpec).
        certPem: !app.clusterId && app.certPem ? "present" : null,
        certKey: !app.clusterId && app.certKeyEnc ? "present" : null,
        containerPort: web?.port ?? app.containerPort,
        securityHeaders: app.securityHeaders,
        gzip: app.gzip,
        forwardAuth: app.forwardAuth,
        ipAllowlist: app.ipAllowlist ?? [],
        basicAuthUsers: parseBasicAuthUsers(app.basicAuthUsers),
        rateLimit: parseRateLimit(app.rateLimit),
        redirects: parseRedirects(app.redirects),
        extraDomains: app.extraDomains ?? [],
        rollingHealthPath: null,
        dbNetwork: !!app.dbNetwork && !app.clusterId,
        networks: compose || app.clusterId ? [] : (app.networks ?? []),
        containerAlias: !compose && !app.clusterId ? app.containerAlias : null,
        dockerOptions: app.dockerOptions,
      },
      composeWebService: web?.service ?? null,
      serviceDomains: compose ? await this.loadServiceDomains(app.id) : [],
      configMounts: compose ? this.appConfigMounts(app) : [],
      customLabels: compose ? null : this.storedCustomLabels(app.customLabels),
      rollingEligible: !compose && !app.clusterId && this.rollingEligible(app),
    });
  }

  /**
   * Flip the per-app host-privilege gate. INSTANCE-OWNER ONLY, over a session — enforced by the controller's
   * JwtAuthGuard + InstanceOwnerGuard (never a PAT, never an apps:config member), so a stolen/low-scope token
   * can't grant host root. Turning it OFF re-validates the stored dockerOptions strictly and CLEARS them if
   * they'd no longer pass, so a revoked override can never leave privileged flags runnable on the next deploy.
   */
  async setAllowPrivilegedDockerOptions(ownerId: string, id: string, allow: boolean): Promise<void> {
    const app = await this.prisma.application.findUnique({ where: { id } });
    if (!app) throw new NotFoundException("app not found");
    let clearedOptions = false;
    if (!allow && app.dockerOptions) {
      try {
        assertSafeDockerOptions(app.dockerOptions); // strict (no override) — do the stored options still pass?
      } catch {
        clearedOptions = true; // they're privileged → clear them so a later redeploy can't run them
      }
    }
    await this.prisma.application.update({
      where: { id },
      data: { allowPrivilegedDockerOptions: allow, ...(clearedOptions ? { dockerOptions: null } : {}) },
    });
    await this.audit.log({ actor: ownerId, action: "app.allow_privileged_docker_options.update", target: id, meta: { allow, clearedOptions } });
  }

  /** Set the pre/post-deploy hook commands. Arbitrary shell, so: write-gated, trimmed (empty → null to
   *  clear the hook), and the audit record carries only lengths — never the command text. Execution runs
   *  in a container of the app image at deploy time (shell-quoted, exit-normalized), never on the host. */
  async setDeployHooks(
    userId: string,
    id: string,
    pre: string | null,
    post: string | null,
    composeHookService?: string | null,
  ): Promise<void> {
    const app = await this.requireMutate(userId, id);
    const norm = (s: string | null) => {
      const trimmed = (s ?? "").trim();
      return trimmed ? trimmed : null;
    };
    const preDeployCommand = norm(pre);
    const postDeployCommand = norm(post);
    const hooked = !!(preDeployCommand || postDeployCommand);
    const isCompose = app.source === "COMPOSE";
    // Hooks only execute on the single-server path (classic: preDeploySteps / buildPostDeployScript; compose: the
    // compose up script). Reject setting them where they'd silently never run — but always allow clearing (both
    // null) so stale values can be removed after an app is moved to a cluster.
    if (hooked && (app.clusterId || app.isPreview)) {
      throw new BadRequestException("deploy hooks are only supported on single-server, non-preview apps");
    }
    if (!isCompose && composeHookService != null) {
      throw new BadRequestException("a hook service applies only to compose apps");
    }
    const data: Prisma.ApplicationUncheckedUpdateInput = { preDeployCommand, postDeployCommand };
    let service: string | null = null;
    if (isCompose) {
      if (hooked) {
        service = composeHookService !== undefined ? composeHookService : app.composeHookService;
        if (!service) throw new BadRequestException("a service is required for a compose hook");
        // A pasted compose is stored on the hub, so the service can be checked now; a git-compose is validated at
        // deploy time (the names are only known from the rendered repo file).
        if (!app.composePath) {
          const names = composeServiceNames(app.composeFile);
          if (!names.includes(service)) {
            throw new BadRequestException(`service "${service}" is not in the compose file (services: ${names.join(", ") || "none"})`);
          }
        }
      }
      data.composeHookService = service; // clearing both hooks also clears the service
    }
    await this.prisma.application.update({ where: { id }, data });
    await this.audit.log({
      actor: userId,
      action: "app.deploy_hooks.update",
      target: id,
      meta: {
        preLen: preDeployCommand?.length ?? 0,
        postLen: postDeployCommand?.length ?? 0,
        ...(isCompose ? { service } : {}),
      },
    });
  }

  /** Set the container ENTRYPOINT/CMD override (exec-form argv) for a classic IMAGE/GIT app. Replace
   *  semantics: null = image default; containerEntrypoint [] clears the image entrypoint. Write-gated; the
   *  audit record carries only arg counts + total length, never the argv (it can embed credentials). Refused
   *  on compose/cluster/preview apps — the override is consumed only by the classic docker-run path
   *  (runContainerArgs); swarm services are a deferred follow-up. Clearing (both null) is always allowed so a
   *  stale override can be removed after an app moves to a cluster. */
  async setContainerCommand(userId: string, id: string, input: SetContainerCommandInput): Promise<void> {
    const app = await this.requireMutate(userId, id);
    const setting = input.containerEntrypoint !== null || input.containerCommand !== null;
    if (setting && (app.source === "COMPOSE" || app.clusterId || app.isPreview)) {
      throw new BadRequestException("a container command override is only supported on single-server Image and Git apps");
    }
    // A structured entrypoint and a raw dockerOptions `--entrypoint` can't coexist (docker takes the last —
    // order-dependent). The reverse direction is checked in setDockerOptions.
    if (
      input.containerEntrypoint !== null &&
      tokenizeDockerOptions(app.dockerOptions).some((t) => /^--entrypoint(=|$)/.test(t))
    ) {
      throw new BadRequestException("remove --entrypoint from Custom Docker options before setting an entrypoint override here");
    }
    await this.ensureNoActiveDeploy(id);
    await this.prisma.application.update({
      where: { id },
      data: {
        containerEntrypoint: input.containerEntrypoint ?? Prisma.JsonNull,
        containerCommand: input.containerCommand ?? Prisma.JsonNull,
      },
    });
    await this.audit.log({
      actor: userId,
      action: "app.container_command.update",
      target: id,
      meta: {
        epArgc: input.containerEntrypoint?.length ?? 0,
        cmdArgc: input.containerCommand?.length ?? 0,
        len: (input.containerEntrypoint ?? []).join("").length + (input.containerCommand ?? []).join("").length,
      },
    });
  }

  /** A stack adopted in place runs exactly the user's own files: Tugra-side settings that would be written into an override
   *  (env, domains, mounts, networks) do not apply to it, so they are refused loudly instead of being silently ignored. */
  private assertNotAdopted(app: { composeAdopt?: unknown }, what: string): void {
    if (adoptedCompose(app)) throw new BadRequestException(`${what} are not applied to a stack adopted in place; change them in the stack's own files on the server`);
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
    const app = await this.requireMutate(userId, id);
    if (app.source !== "COMPOSE") throw new BadRequestException("not a compose app");
    if (adoptedCompose(app)) throw new BadRequestException("this stack was adopted from files on the server; edit them there (Tugra runs them as they are)");
    assertSafeCompose(composeFile);
    // A saved deploy hook targets one service: refuse a file that drops it (the hook would fail every deploy).
    if ((app.preDeployCommand || app.postDeployCommand) && app.composeHookService && !composeServiceNames(composeFile).includes(app.composeHookService)) {
      throw new BadRequestException(`the compose file removes service "${app.composeHookService}" used by a deploy hook`);
    }
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
  /**
   * May `userId` link this Git source to an app in `teamId`? A team's own source: yes (the caller already holds
   * apps:config there). A source shared with every team: only the instance owner, or someone who manages the
   * source's OWN team's integrations — other teams see it read-only and cannot attach it to new apps. Apps already
   * linked keep deploying through it either way (the clone credential is resolved by source id at deploy time).
   */
  private async canLinkGitSource(userId: string, gs: { teamId: string; sharedAllTeams?: boolean | null }, teamId: string): Promise<boolean> {
    if (gs.teamId === teamId) return true;
    if (!sourceUsableBy(gs, teamId)) return false;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isInstanceOwner: true } });
    if (user?.isInstanceOwner) return true;
    const perms = (await this.access.permissionsByTeam(userId)).get(gs.teamId);
    return perms?.has("integrations") ?? false;
  }

  async setSource(userId: string, id: string, input: SetSourceInput): Promise<{ warnings: string[] }> {
    const app = await this.requireMutate(userId, id);
    if (app.isPreview) throw new BadRequestException("a preview app's source is controlled by its parent");
    // A git-sourced compose app edits its repo/branch/path here (like a GIT app); a PASTED compose edits its
    // YAML via the compose-file endpoint instead.
    const gitCompose = app.source === "COMPOSE" && !!app.composePath && !!app.gitUrl;
    if (app.source === "COMPOSE" && !gitCompose) throw new BadRequestException("edit a pasted compose app's source with the compose-file endpoint");
    const warnings: string[] = [];
    const data: Prisma.ApplicationUncheckedUpdateInput = {};

    if (app.source === "IMAGE") {
      if (input.gitUrl !== undefined || input.gitBranch !== undefined || input.gitCommit !== undefined || input.gitSourceId !== undefined || input.composePath !== undefined) {
        throw new BadRequestException("this app deploys a prebuilt image — only `image` can be changed (the source type is fixed at create)");
      }
      if (input.image === undefined) throw new BadRequestException("provide an image reference");
      data.image = input.image;
      // A different image is a different upstream: drop the old probe verdict (the dedupe column too, so the first
      // probe of the new ref seeds silently instead of notifying).
      if (input.image !== app.image) {
        data.imageUpstreamDigest = null;
        data.imageUpstreamCheckedAt = null;
        data.imageUpstreamChangedAt = null;
        data.imageCheckError = null;
        data.imageUpdateNotifiedDigest = null;
        data.imageCheckFailures = 0;
      }
    } else {
      // GIT build, or a git-sourced COMPOSE app (both clone a repo → same URL/branch/credential rules).
      if (input.image !== undefined) throw new BadRequestException("this app builds from Git — `image` does not apply (the source type is fixed at create)");
      if (input.composePath !== undefined) {
        if (!gitCompose) throw new BadRequestException("composePath only applies to a compose-from-git app");
        data.composePath = input.composePath;
      }

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
          if (!gs || !(await this.canLinkGitSource(userId, gs, app.teamId))) throw new BadRequestException("git source not found in this team");
          nextSourceId = input.gitSourceId;
        }
      }

      if (input.gitUrl !== undefined) data.gitUrl = input.gitUrl;
      if (input.gitBranch !== undefined) data.gitBranch = input.gitBranch;
      if (input.gitCommit !== undefined) data.gitCommit = input.gitCommit;
      if (nextSourceId !== undefined) data.gitSourceId = nextSourceId;
      // A pinned commit belongs to the old repo — if the URL changes and the caller didn't set a new pin in
      // the same call, drop it so a later deploy doesn't fail checking out a SHA that isn't in the new repo.
      const urlChanged = input.gitUrl !== undefined && input.gitUrl !== (app.gitUrl ?? "");
      if (urlChanged && input.gitCommit === undefined && app.gitCommit) {
        data.gitCommit = null;
        warnings.push("git_commit_cleared");
      }

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
      if (effectiveSourceId && !nowSsh && nextHost) {
        const linked = await this.prisma.gitSource.findUnique({ where: { id: effectiveSourceId } });
        if (linked) this.assertSourceHost(linked, nextUrl);
      }
    }

    await this.ensureNoActiveDeploy(id);
    await this.prisma.application.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "app.source.update", target: id, meta: { warnings } });
    return { warnings };
  }

  /**
   * Edit HOW a Git app is built, after create (day-2): the build type, the one set of fields that applies
   * to it, and the monorepo base directory. Replace semantics for the per-type fields — the ones that don't
   * apply to the chosen type are cleared (so a stale dockerfilePath/buildCommand can't leak into a Nixpacks
   * build) and an omitted baseDirectory clears it (back to the repo root). The git/build behaviour toggles
   * (submodules, LFS, shallow, no-cache, env build-args, SOURCE_COMMIT) keep their stored value when omitted
   * (importer / older clients). GIT apps only (IMAGE deploys a prebuilt image;
   * COMPOSE builds from its compose file). Applies on the next deploy.
   */
  async setBuild(userId: string, id: string, input: SetBuildInput): Promise<void> {
    const app = await this.requireMutate(userId, id);
    if (app.isPreview) throw new BadRequestException("a preview app's build is controlled by its parent");
    if (app.source !== "GIT") throw new BadRequestException("build settings apply only to Git apps");
    await this.ensureNoActiveDeploy(id);
    // Persisted-state guard: Railpack has no cache-bypass flag wired, so a stored disableBuildCache must be turned off first.
    const effNoCache = input.disableBuildCache ?? app.disableBuildCache;
    if (input.buildType === "RAILPACK" && effNoCache) {
      throw new BadRequestException("turn off 'Disable build cache' before switching to Railpack (it has no cache-bypass flag wired)");
    }
    await this.prisma.application.update({
      where: { id },
      data: {
        buildType: input.buildType,
        dockerfilePath: input.buildType === "DOCKERFILE" ? input.dockerfilePath ?? null : null,
        dockerBuildTarget: input.buildType === "DOCKERFILE" ? input.dockerBuildTarget ?? null : null,
        // Inline Dockerfile: DOCKERFILE only, replace semantics (omitted = cleared). dockerfilePath stays stored untouched, so
        // clearing the inline text restores the repository Dockerfile.
        // (written only when it changes: `undefined` is ignored by Prisma, so an app that never used it sees an identical update)
        inlineDockerfile: (input.buildType === "DOCKERFILE" ? input.inlineDockerfile ?? null : null) ?? (app.inlineDockerfile ? null : undefined),
        buildCommand: input.buildType === "STATIC" ? input.buildCommand ?? null : null,
        outputDir: input.buildType === "STATIC" ? input.outputDir ?? null : null,
        // Nixpacks command overrides — only for the NIXPACKS pack (nulled otherwise, like the per-type fields above).
        nixpacksInstallCmd: input.buildType === "NIXPACKS" ? input.nixpacksInstallCmd ?? null : null,
        nixpacksBuildCmd: input.buildType === "NIXPACKS" ? input.nixpacksBuildCmd ?? null : null,
        nixpacksStartCmd: input.buildType === "NIXPACKS" ? input.nixpacksStartCmd ?? null : null,
        // The monorepo base directory applies to every build type, so it sits outside the per-type ternaries.
        baseDirectory: input.baseDirectory ?? null,
        // Build secrets are a Dockerfile-only contract (RUN --mount=type=secret): leaving Dockerfile drops them, so
        // a value never lingers encrypted-but-invisible (and never comes back silently on a later switch back).
        buildSecretsEnc: input.buildType === "DOCKERFILE" ? undefined : null,
        // Git/build behaviour toggles: omitted = keep (Prisma ignores undefined).
        gitSubmodules: input.gitSubmodules,
        gitLfs: input.gitLfs,
        gitShallowClone: input.gitShallowClone,
        disableBuildCache: input.disableBuildCache,
        sourceCommitMode: input.sourceCommitMode,
        // Dockerfile-only contract (mirrors buildSecretsEnc): leaving DOCKERFILE clears it so it never lingers invisibly.
        injectEnvAsBuildArgs: input.buildType === "DOCKERFILE" ? input.injectEnvAsBuildArgs : false,
      },
    });
    const toggles: Record<string, unknown> = {};
    for (const k of ["gitSubmodules", "gitLfs", "gitShallowClone", "disableBuildCache", "injectEnvAsBuildArgs", "sourceCommitMode"] as const) {
      if (input[k] !== undefined) toggles[k] = input[k];
    }
    await this.audit.log({ actor: userId, action: "app.build.update", target: id, meta: { buildType: input.buildType, baseDirectory: input.baseDirectory ?? null, ...toggles, ...(input.buildType === "DOCKERFILE" && input.inlineDockerfile ? { inlineDockerfile: Buffer.byteLength(input.inlineDockerfile, "utf8") } : {}) } });
  }

  /** Toggle the per-app push-to-deploy switch (a matching git push auto-deploys). Off acknowledges the push
   *  but skips the deploy — pause without deleting the webhook. Applies to the next push. */
  async setAutoDeploy(userId: string, id: string, enabled: boolean): Promise<void> {
    await this.requireWrite(userId, id);
    await this.prisma.application.update({ where: { id }, data: { autoDeploy: enabled } });
    await this.audit.log({ actor: userId, action: "app.auto_deploy.update", target: id, meta: { enabled } });
  }

  /** Per-app opt-out of the scheduled "image update available" probe (IMAGE apps). Disabling keeps the stored
   *  verdict so re-enabling is instant. */
  async setImageUpdateCheck(userId: string, id: string, enabled: boolean): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (app.source !== "IMAGE" || app.isPreview) throw new BadRequestException("image update checks apply to image apps only");
    await this.prisma.application.update({ where: { id }, data: { imageUpdateCheck: enabled } });
    await this.audit.log({ actor: userId, action: "app.image_update_check.update", target: id, meta: { enabled } });
  }

  /** "Check now": probe the upstream registry from the app's own server. apps:deploy (it uses the stored registry
   *  credentials), throttled + coalesced in ImageUpdateService, audited. */
  async checkImageUpdate(userId: string, id: string): Promise<{ imageUpdate: z.infer<typeof ImageUpdateViewSchema> }> {
    const app = await this.requireWrite(userId, id, "apps:deploy");
    const perms = await this.access.membershipPermissions(userId, app.teamId);
    const result = await this.imageUpdate.checkApp(app, perms?.has("apps:config") ?? false);
    await this.audit.log({ actor: userId, action: "app.image_update_check.run", target: id, meta: { state: result.imageUpdate.state } });
    return result;
  }

  /** In-flight compose previews (a git preview costs a clone): one at a time per app, in this process. */
  private readonly composePreviewBusy = new Set<string>();

  /**
   * Resolved compose preview. The agent runs `docker compose config --no-interpolate` (no env value is sent to it),
   * the hub parses the verified output, redacts literal environment / build-arg values and any known env value, and
   * returns the redacted YAML. Writer-only (apps:config) and `read:secrets`-scoped at the controller. The audit
   * record carries the byte size only, never the YAML. Never touches a live compose or clone directory.
   */
  async previewCompose(userId: string, id: string): Promise<ComposePreviewResult> {
    const app = await this.requireWrite(userId, id);
    if (app.source !== "COMPOSE") throw new BadRequestException("only compose apps have a compose file to preview");
    if (app.isPreview) throw new BadRequestException("a preview app's compose is controlled by its parent");
    const gitCompose = !!app.composePath && !!app.gitUrl;
    if (!gitCompose && !app.composeFile) throw new BadRequestException("this app has no compose file to preview");
    // The preview renders a stored compose on the host: refuse a host-reaching env_file (a compose stored before the
    // create-time gate existed would otherwise read it through the renderer).
    if (!gitCompose) assertSafeEnvFiles(app.composeFile as string);
    if (this.composePreviewBusy.has(id)) throw new ConflictException("a compose preview is already running for this app");
    this.composePreviewBusy.add(id);
    try {
      const spec = this.toSpec(app);
      if (app.gitSourceId && gitCompose) spec.gitToken = await this.gitSources.cloneToken(app.gitSourceId, app.gitUrl);
      let script: string;
      try {
        script = buildComposePreviewScript(spec);
      } catch (e) {
        if (e instanceof Error && /limit/.test(e.message)) throw new UnprocessableEntityException("compose file too large to preview");
        throw e;
      }
      // Offline / disconnected agents surface as the same typed 503/504 as every other agent-bound call.
      const r = await this.agentWs.sendCommand(app.serverId, script, "deploy", 120_000);
      if (r.exitCode === 2 && r.output.includes(PREVIEW_UNSUPPORTED_MARKER)) {
        throw new UnprocessableEntityException("update Docker Compose on the agent (it does not support `config --no-interpolate`)");
      }
      if (r.exitCode !== 0) {
        const why = parsePreviewError(r.output);
        throw new UnprocessableEntityException(why ? `the compose could not be rendered: ${classifyPreviewError(why)}` : `the compose preview failed (exit ${r.exitCode})`);
      }
      const rendered = parseRenderedCompose(r.output);
      if (!rendered) throw new UnprocessableEntityException("the resolved compose could not be read (it may be too large to preview)");
      const warnings: string[] = [];
      if (gitCompose) {
        // Display-only: the real assertSafeCompose still gates the deploy. A `${VAR}` bind can show a false warning.
        try {
          assertSafeCompose(rendered.compose, { gitCloneRoot: composePreviewCloneRoot(app) });
        } catch (e) {
          if (e instanceof BadRequestException) warnings.push(e.message);
          else throw e;
        }
      }
      // Values to scrub wherever they appear: the app's resolved env layers + build args. A failure to read them
      // degrades to literal-only redaction (said so in `warnings`), never to returning anything unredacted.
      const known: string[] = [];
      try {
        const { merged } = await this.resolveEnvLayers(app);
        known.push(...Object.values(merged));
        known.push(...Object.values(this.appBuildArgs(app)), ...Object.values(this.appBuildSecrets(app)));
      } catch {
        warnings.push("the app environment could not be read; only literal environment and build-arg values were redacted");
      }
      const red = redactResolvedCompose(rendered.compose, known);
      const result: ComposePreviewResult = {
        resolvedCompose: red.yaml,
        services: composeServiceNames(red.yaml),
        sha256: createHash("sha256").update(red.yaml, "utf8").digest("hex"),
        redactions: red.redactions,
        warnings,
        generatedAt: new Date().toISOString(),
      };
      await this.audit.log({ actor: userId, action: "app.compose.preview", target: id, meta: { bytes: Buffer.byteLength(red.yaml, "utf8") } });
      return result;
    } finally {
      this.composePreviewBusy.delete(id);
    }
  }

  /** Replace the app's extra published ports (raw host:container TCP/UDP maps beyond the ingress port).
   *  Classic (docker-run) apps only — a compose app declares its ports in its YAML. Applies on the next deploy. */
  async setExtraPorts(userId: string, id: string, ports: { hostPort: number; containerPort: number; protocol: "tcp" | "udp" }[]): Promise<void> {
    const app = await this.requireMutate(userId, id);
    if (app.source === "COMPOSE") throw new BadRequestException("a compose app declares its ports in its compose file");
    await this.prisma.application.update({ where: { id }, data: { extraPorts: ports as unknown as Prisma.InputJsonValue } });
    await this.audit.log({ actor: userId, action: "app.extra_ports.update", target: id, meta: { count: ports.length } });
  }

  /** Replace the app's docker network aliases (extra DNS names on its user-defined network). Names are
   *  DTO-validated DNS labels, deduped there. Replace-set; empty clears. Applies on the next deploy. */
  async setNetworkAliases(userId: string, id: string, aliases: string[]): Promise<void> {
    const app = await this.requireMutate(userId, id);
    this.assertNotAdopted(app, "network aliases");
    // Swarm/cluster apps deploy via service-script.ts, which does not emit --network-alias, so accepting
    // them would be a silent no-op — refuse (mirrors setDbNetwork / extra domains).
    if (app.clusterId) throw new BadRequestException("network aliases aren't supported for clustered (swarm) apps yet");
    // Defence-in-depth over the DTO: never let a reserved tugra- name onto the shared network (traefik,
    // the panel routers, the agent, tugra_db_<id>) — a tenant could otherwise hijack their DNS name.
    const reserved = aliases.find((a) => /^tugra[-_]/i.test(a));
    if (reserved) throw new BadRequestException(`'${reserved}' is reserved for Tugra-managed containers`);
    // A network alias equal to a stable container alias (this app's or another same-server app's) would bypass the
    // (serverId, containerAlias) unique index through this setter.
    if (aliases.length > 0) {
      if (app.containerAlias && aliases.includes(app.containerAlias)) throw new BadRequestException("alias already in use on this server");
      const clash = await this.prisma.application.findFirst({
        where: { serverId: app.serverId, id: { not: id }, containerAlias: { in: aliases } },
        select: { id: true },
      });
      if (clash) throw new BadRequestException("alias already in use on this server");
    }
    await this.prisma.application.update({ where: { id }, data: { networkAliases: aliases } });
    await this.audit.log({ actor: userId, action: "app.network_aliases.update", target: id, meta: { count: aliases.length } });
  }

  /** Set the app's extra user Docker networks and/or its stable container alias (DNS name on every network it
   *  joins). Classic IMAGE/GIT apps only; refused for swarm/compose/preview and when a raw --network is in docker
   *  options. Network names are DTO-validated; re-checked here as defence in depth. A network name another TEAM
   *  already uses on this server is refused (two tenants must not silently share a bridge), and the alias must not
   *  collide with any app's alias on the same server (the unique index closes the race). Applies on the next deploy. */
  async setNetworks(userId: string, id: string, cfg: { networks?: string[]; containerAlias?: string | null }): Promise<void> {
    const app = await this.requireMutate(userId, id);
    if (app.clusterId) throw new BadRequestException("networks and a container alias aren't supported for clustered (swarm) apps");
    if (app.source === "COMPOSE") throw new BadRequestException("a compose app manages its own networks — declare them in the compose file");
    if (app.isPreview) throw new BadRequestException("networks and a container alias aren't supported on preview apps");
    // A raw --network owns networking, so setting values is refused; a pure CLEARING write (no networks, no alias)
    // is still allowed so stale values saved before the flag was added can be removed.
    if (hasNetworkOpt(app.dockerOptions) && ((cfg.networks?.length ?? 0) > 0 || !!cfg.containerAlias)) {
      throw new BadRequestException("remove --network from Docker options first");
    }
    for (const n of cfg.networks ?? []) {
      if (!isUserNetworkNameAllowed(n)) throw new BadRequestException(`'${n}' is a reserved network name`);
    }
    const alias = cfg.containerAlias;
    if (alias && /^tugra[-_]/i.test(alias)) throw new BadRequestException(`'${alias}' is reserved for Tugra-managed containers`);
    const names = (cfg.networks ?? []).filter((n) => n !== APPS_NETWORK);
    if (names.length > 0) {
      const other = await this.prisma.application.findFirst({
        where: { serverId: app.serverId, teamId: { not: app.teamId }, networks: { hasSome: names } },
        select: { id: true },
      });
      if (other) throw new BadRequestException("network name is already used by another team on this server");
    }
    if (alias) {
      const taken = (app.networkAliases ?? []).includes(alias)
        ? { id }
        : await this.prisma.application.findFirst({
            where: { serverId: app.serverId, id: { not: id }, networkAliases: { has: alias } },
            select: { id: true },
          });
      if (taken) throw new BadRequestException("alias already in use on this server");
    }
    try {
      await this.prisma.application.update({
        where: { id },
        data: {
          ...(cfg.networks !== undefined ? { networks: cfg.networks } : {}),
          ...(cfg.containerAlias !== undefined ? { containerAlias: cfg.containerAlias } : {}),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("alias already in use on this server");
      }
      throw e;
    }
    await this.audit.log({
      actor: userId,
      action: "app.networks.update",
      target: id,
      meta: { networks: cfg.networks ?? app.networks ?? [], alias: !!(cfg.containerAlias !== undefined ? cfg.containerAlias : app.containerAlias) },
    });
  }

  /** Set the ingress container port an IMAGE/GIT app listens on inside the container (the proxy's
   *  loadbalancer target, the -p mapping and the default health probe all derive from it). Editable after
   *  create so a wrong value (e.g. an import that defaulted to 80) can be fixed without recreating the app.
   *  COMPOSE apps are rejected — toSpec derives their web port from the YAML, so a stored value is ignored
   *  and editing it would silently do nothing. Applies on the NEXT deploy (the labels/-p are baked in at run). */
  async setContainerPort(userId: string, id: string, containerPort: number): Promise<void> {
    const app = await this.requireMutate(userId, id);
    if (app.source === "COMPOSE") throw new BadRequestException("a compose app's port comes from its compose file");
    if (app.isPreview) throw new BadRequestException("a preview app's port is inherited from its parent app");
    await this.prisma.application.update({ where: { id }, data: { containerPort } });
    await this.audit.log({ actor: userId, action: "app.container_port.update", target: id, meta: { containerPort } });
  }

  /** Replace the app's watch paths (monorepo deploy-trigger globs). Git-sourced apps only (a GIT build or a
   *  COMPOSE-from-git app) — watch paths gate webhook pushes, which an IMAGE or pasted-COMPOSE app never has.
   *  An empty array clears them (back to deploy-on-every-push). Applies to the NEXT push. */
  async setWatchPaths(userId: string, id: string, watchPaths: string[]): Promise<void> {
    const app = await this.requireWrite(userId, id);
    const gitSourced = app.source === "GIT" || (app.source === "COMPOSE" && !!app.gitUrl);
    if (!gitSourced) throw new BadRequestException("watch paths apply only to a git-sourced app (a Git build or a compose-from-git app)");
    await this.prisma.application.update({ where: { id }, data: { watchPaths } });
    await this.audit.log({ actor: userId, action: "app.watch_paths.update", target: id, meta: { count: watchPaths.length } });
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
    const app = await this.requireMutate(userId, id);
    this.assertNotAdopted(app, "config mounts");
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

  /**
   * INTERNAL (no controller route; only the importer calls it): seed a freshly imported stored-compose app with the config
   * files its source kept next to the compose (`./clickhouse/config.xml`, ...). It is the ONLY way config mounts are ever
   * added to an existing app: the editor (`setConfigMountContent`) can only change the content of a mount that exists.
   * Rules: stored-compose app, never deployed, no mounts yet (an equal retry is a no-op), every row validated like a
   * template's (`validateConfigMountTarget` / `validateConfigMountServiceName` / known service / octal mode), at most 16
   * rows and 256 KiB in total. Audits size + sha256 only, never the content.
   */
  async setConfigMountsForImport(
    userId: string,
    id: string,
    mounts: Array<{ serviceName: string; target: string; content: string; mode?: string }>,
  ): Promise<void> {
    const app = await this.requireWrite(userId, id);
    if (app.source !== "COMPOSE" || !app.composeFile || app.gitUrl) throw new BadRequestException("config mounts apply only to a compose app with a stored compose file");
    if (mounts.length === 0) return;
    if (mounts.length > 16) throw new BadRequestException("too many config mounts (at most 16)");
    const services = new Set(composeServiceNames(app.composeFile));
    const seen = new Set<string>();
    let total = 0;
    for (const m of mounts) {
      validateConfigMountServiceName(m.serviceName);
      validateConfigMountTarget(m.target);
      if (!services.has(m.serviceName)) throw new BadRequestException(`compose service "${m.serviceName}" is not defined in the compose file`);
      if (m.mode !== undefined && !/^0?[0-7]{3,4}$/.test(m.mode)) throw new BadRequestException("invalid config mount file mode");
      if (typeof m.content !== "string") throw new BadRequestException("invalid config mount content");
      const key = `${m.serviceName}\u0000${m.target}`;
      if (seen.has(key)) throw new BadRequestException("duplicate config mount target");
      seen.add(key);
      total += m.content.length;
    }
    if (total > 256 * 1024) throw new BadRequestException("config mounts exceed the total size limit");
    const clean = mounts.map((m) => ({ serviceName: m.serviceName, target: m.target, content: m.content, ...(m.mode ? { mode: m.mode } : {}) }));
    const existing = this.appConfigMounts(app);
    if (existing.length > 0) {
      if (JSON.stringify(existing) === JSON.stringify(clean)) return; // idempotent retry
      throw new BadRequestException("this app already has config mounts");
    }
    if ((await this.prisma.deployment.count({ where: { appId: id } })) > 0) throw new BadRequestException("config mounts can only be imported into an app that has never been deployed");
    await this.prisma.application.update({ where: { id }, data: { configMounts: clean as unknown as Prisma.InputJsonValue } });
    await this.audit.log({
      actor: userId,
      action: "app.config_mounts.import",
      target: id,
      meta: { count: clean.length, bytes: total, sha256: createHash("sha256").update(JSON.stringify(clean)).digest("hex") },
    });
  }

  /** Per-app deploy/rollback timeout in ms (default 5 min). */
  private deployTimeoutMs(app: Application): number {
    return (app.deployTimeoutSec ?? 300) * 1000;
  }

  /** Extra ms the swap legs add beyond deployTimeoutMs: the drain sleep (rolling only) + the graceful stops that
   *  run inside the one agent command. 0 when neither is set, so an unset app's timeout is unchanged. */
  private opsBudgetMs(spec: AppSpec, rolling: boolean): number {
    const stop = spec.stopGracePeriodSec ?? 0;
    const drain = rolling ? (spec.drainSec ?? 0) : 0;
    if (!stop && !drain) return 0;
    const stops = rolling && resolveSoak(spec).windowSec > 0 ? 2 : 1; // soak: the old stop + a possible revert stop
    return (drain + stop * stops + 15) * 1000;
  }

  /** Stop/restart agent timeout: the 2-minute default, widened to the container's graceful-stop window (+ margin)
   *  so a long stopGracePeriodSec isn't SIGKILLed by the agent mid-stop. COMPOSE/swarm ignore the setting. */
  private lifecycleTimeoutMs(app: Application): number {
    if (app.source === "COMPOSE" || app.clusterId) return LIFECYCLE_TIMEOUT_MS;
    return Math.max(LIFECYCLE_TIMEOUT_MS, ((app.stopGracePeriodSec ?? 0) + 30) * 1000);
  }

  /** Extra ms a rolling deploy's command needs beyond deployTimeoutMs when a post-cutover soak is configured.
   *  The soak sleeps the whole window AND each re-probe can take up to the probe timeout, so budget both (plus
   *  a margin) — otherwise the agent SIGKILLs the soak mid-watch and leaves an ambiguous state. 0 when soak is
   *  off. */
  private soakBudgetMs(spec: AppSpec): number {
    const soak = resolveSoak(spec);
    if (soak.windowSec <= 0) return 0;
    const probe = resolveHealthProbe(spec);
    const probeSec = probe.kind === "httpExternal" ? (probe.timeoutSec ?? 5) : 1; // native/stableWait probes are ~instant
    // Upper bound of the real loop: each of soakRetries iterations does `sleep intervalSec` THEN a probe (up to
    // probeSec), plus a generous 30s tail for the revert's docker stop/rm/rename/start — so the agent never
    // SIGKILLs mid-soak or mid-revert and strands a __prev.
    return (soakRetries(soak) * (soak.intervalSec + probeSec) + 30) * 1000;
  }

  async setLimits(userId: string, id: string, limits: SetLimitsInput): Promise<void> {
    const app = await this.requireMutate(userId, id);
    const cpuset = limits.cpusetCpus === undefined ? undefined : limits.cpusetCpus || null; // "" (cleared) → null
    const extraSet = [limits.memorySwapMb, limits.pidsLimit, limits.shmSizeMb, limits.cpuShares, cpuset].some((v) => v != null);
    // These map to `docker run` flags on the classic single-container path only. Compose ignores them (it even
    // ignores memoryMb) and a swarm service maps just memory/cpu/reserve, so a value there would be a silent no-op
    // — refuse (clearing with null is always allowed).
    if (extraSet && app.source === "COMPOSE") throw new BadRequestException("set these limits in the compose file instead");
    if (extraSet && app.clusterId) throw new BadRequestException("swap, PID, shm, CPU weight and CPU pinning limits aren't supported for swarm apps");
    // Validate the MERGED state: Docker rejects --memory-swap without --memory, and a swap below the memory limit.
    const effMem = limits.memoryMb !== undefined ? limits.memoryMb : app.memoryMb;
    const effSwap = limits.memorySwapMb !== undefined ? limits.memorySwapMb : app.memorySwapMb;
    if (effSwap != null && effMem == null) throw new BadRequestException("a swap limit needs a memory limit (Docker rejects --memory-swap without --memory)");
    if (effSwap != null && effSwap > 0 && effMem != null && effSwap < effMem) throw new BadRequestException("memory + swap must not be below the memory limit");
    if (cpuset) {
      const cores = (await this.prisma.server.findUnique({ where: { id: app.serverId }, select: { cpuCores: true } }))?.cpuCores ?? null;
      // Unknown core count (agent hasn't reported): skip — Docker rejects an unavailable cpu at deploy instead.
      if (cores != null) {
        const max = cpusetMax(cpuset);
        if (max >= cores) throw new BadRequestException(`cpu ${max} isn't available on this server (${cores} cores)`);
      }
    }
    await this.prisma.application.update({
      where: { id },
      data: {
        // undefined-means-keep (null clears) so a partial API/MCP update can't wipe untouched limits; the
        // web card sends the full object, so its behaviour is unchanged.
        ...(limits.memoryMb !== undefined ? { memoryMb: limits.memoryMb } : {}),
        ...(limits.cpus !== undefined ? { cpus: limits.cpus } : {}),
        ...(limits.reserveMemoryMb !== undefined ? { reserveMemoryMb: limits.reserveMemoryMb } : {}),
        ...(limits.reserveCpus !== undefined ? { reserveCpus: limits.reserveCpus } : {}),
        ...(limits.memorySwapMb !== undefined ? { memorySwapMb: limits.memorySwapMb } : {}),
        ...(limits.pidsLimit !== undefined ? { pidsLimit: limits.pidsLimit } : {}),
        ...(limits.shmSizeMb !== undefined ? { shmSizeMb: limits.shmSizeMb } : {}),
        ...(limits.cpuShares !== undefined ? { cpuShares: limits.cpuShares } : {}),
        ...(cpuset !== undefined ? { cpusetCpus: cpuset } : {}),
        ...(limits.gpus !== undefined ? { gpus: limits.gpus || null } : {}), // "" (cleared) → null
        ...(limits.deployTimeoutSec !== undefined ? { deployTimeoutSec: limits.deployTimeoutSec } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "app.limits.update", target: id });
  }

  /** Configure the deploy-gate health check. type null = auto; "NONE"|"HTTP"|"CMD" force
   *  it. A CMD check reuses `healthCmd`; HTTP uses path/port. */
  async setHealthCheck(
    userId: string,
    id: string,
    hc: {
      type?: string | null; path?: string | null; port?: number | null; command?: string | null;
      method?: string | null; scheme?: string | null; responseText?: string | null;
      interval?: number | null; timeout?: number | null; retries?: number | null; startPeriod?: number | null; expectedStatus?: number | null;
    },
  ): Promise<void> {
    await this.requireMutate(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: {
        // Every field is undefined-means-keep (null clears to auto/default), so an API/MCP caller that
        // sends only e.g. {interval} no longer silently wipes the type/path/port. The web card always
        // sends the full object, so its behaviour is unchanged.
        ...(hc.type !== undefined ? { healthCheckType: hc.type } : {}),
        ...(hc.path !== undefined ? { healthCheckPath: hc.path } : {}),
        ...(hc.port !== undefined ? { healthCheckPort: hc.port } : {}),
        // HTTP method/scheme/response-text: undefined keeps the column, null clears to the default
        // (GET / plain HTTP / status-only).
        ...(hc.method !== undefined ? { healthCheckMethod: hc.method } : {}),
        ...(hc.scheme !== undefined ? { healthCheckScheme: hc.scheme } : {}),
        ...(hc.responseText !== undefined ? { healthCheckResponseText: hc.responseText } : {}),
        // Timing knobs: undefined leaves the column as-is, null clears to the built-in default.
        ...(hc.interval !== undefined ? { healthInterval: hc.interval } : {}),
        ...(hc.timeout !== undefined ? { healthTimeout: hc.timeout } : {}),
        ...(hc.retries !== undefined ? { healthRetries: hc.retries } : {}),
        ...(hc.startPeriod !== undefined ? { healthStartPeriod: hc.startPeriod } : {}),
        ...(hc.expectedStatus !== undefined ? { healthExpectedStatus: hc.expectedStatus } : {}),
        // Only a CMD check owns healthCmd; HTTP/NONE leave any existing command intact
        // (resolveHealthProbe ignores it for those types) so a save under HTTP/None never silently wipes it.
        // Explicit Automatic (type null) is the exception: Automatic resolves a stored command to a CMD check
        // and the card would re-display it as CMD, so a leftover command must be cleared for "auto" to stick.
        ...(hc.type === "CMD" ? { healthCmd: hc.command ?? null } : hc.type === null ? { healthCmd: null } : {}),
      },
    });
    await this.audit.log({ actor: userId, action: "app.healthcheck.update", target: id });
  }

  /** Replace an app's HOST bind-mounts (e.g. a media library). Validated now against the sensitive-path
   *  denylist (clear 400, not a broken deploy later) — the exact bar the free-form dockerOptions `-v` path
   *  already enforces. Applies on the next deploy. */
  async setHostMounts(userId: string, id: string, mounts: HostMount[]): Promise<void> {
    this.assertNotAdopted(await this.requireMutate(userId, id), "host mounts");
    const clean = validateHostMounts(mounts);
    await this.prisma.application.update({ where: { id }, data: { hostMounts: clean as unknown as Prisma.InputJsonValue } });
    await this.audit.log({ actor: userId, action: "app.host_mounts.update", target: id, meta: { count: clean.length } });
  }

  async setVolumes(userId: string, id: string, volumes: AppVolume[]): Promise<void> {
    const app = await this.requireMutate(userId, id);
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
    await this.requireMutate(userId, id);
    const data: Prisma.ApplicationUpdateInput = {};
    if (creds.gitToken !== undefined) {
      data.gitTokenEnc = creds.gitToken ? this.crypto.encrypt(creds.gitToken) : null;
    }
    if (creds.registry !== undefined) {
      data.registryAuthEnc = creds.registry
        ? this.crypto.encrypt(JSON.stringify(creds.registry))
        : null;
      // New credentials invalidate a recorded auth failure: probe again right away (the good digest is kept).
      data.imageCheckError = null;
      data.imageUpstreamCheckedAt = null;
      data.imageCheckFailures = 0;
    }
    await this.prisma.application.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "app.credentials.update", target: id });
  }

  /** Configure the build: which team registry to push to, whether to push, and an optional
   *  separate build server (which requires a registry — the deploy server pulls the image). */
  async setBuildConfig(
    userId: string,
    id: string,
    cfg: {
      registryId?: string | null;
      pushToRegistry?: boolean;
      buildServerId?: string | null;
      pushImageName?: string | null;
      pushImageTag?: string | null;
    },
  ): Promise<void> {
    const app = await this.requireMutate(userId, id);
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
    // Custom pushed repo name + mutable alias tag. Evaluated against the MERGED final state (the immutable
    // :<deploymentId> tag is always pushed regardless). undefined = untouched, null = clear.
    const effRegistry = cfg.registryId !== undefined ? cfg.registryId : app.registryId;
    const effBuildServer = cfg.buildServerId !== undefined ? cfg.buildServerId : app.buildServerId;
    const effPush = (cfg.pushToRegistry ?? app.pushToRegistry) || !!effBuildServer;
    const pushReady = !!effRegistry && effPush;
    const settingName = cfg.pushImageName != null;
    const settingTag = cfg.pushImageTag != null;
    if (settingName || settingTag) {
      if (app.source === "COMPOSE") throw new BadRequestException("a custom image name or alias tag does not apply to compose apps");
      if (!pushReady) throw new BadRequestException("a custom image name or alias tag needs a registry and push-to-registry (or a build server)");
    }
    if (settingName) {
      const bad = validatePushName(cfg.pushImageName as string);
      if (bad) throw new BadRequestException(`invalid image name (${bad})`);
    }
    if (settingTag) {
      const bad = validateTagTemplate(cfg.pushImageTag as string, app.source);
      if (bad) throw new BadRequestException(`invalid alias tag (${bad})`);
    }
    if (cfg.pushImageName !== undefined) data.pushImageName = cfg.pushImageName;
    if (cfg.pushImageTag !== undefined) data.pushImageTag = cfg.pushImageTag;
    // Clearing the registry (or push) clears a stored name/alias: they only mean something while pushing.
    if (!pushReady) {
      if (app.pushImageName && cfg.pushImageName === undefined) data.pushImageName = null;
      if (app.pushImageTag && cfg.pushImageTag === undefined) data.pushImageTag = null;
    }
    try {
      await this.prisma.application.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("another app already pushes to that repository in this registry");
      }
      throw e;
    }
    await this.audit.log({
      actor: userId,
      action: "app.buildconfig.update",
      target: id,
      meta: {
        pushImageName: data.pushImageName !== undefined ? (data.pushImageName as string | null) : app.pushImageName,
        pushImageTag: data.pushImageTag !== undefined ? (data.pushImageTag as string | null) : app.pushImageTag,
      },
    });
  }

  /** Deploy this app as a Docker Swarm service across a cluster, or clear it back to classic
   *  single-server deploy. Swarm mode requires a stateless single-service app on a formed swarm; a GIT app
   *  additionally needs a registry (its image must be pullable by every node). */
  async setClusterConfig(
    userId: string,
    id: string,
    cfg: { clusterId?: string | null; replicas?: number | null },
  ): Promise<void> {
    const app = await this.requireMutate(userId, id, "apps:deploy");
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
        // A container command override is consumed only by the classic docker-run path; a swarm service would
        // silently ignore it. Refuse rather than no-op — the operator clears it first (or keeps the app classic).
        if (this.argv(app.containerEntrypoint) || this.argv(app.containerCommand)) {
          throw new BadRequestException("a container command override isn't supported on swarm services yet — clear it first");
        }
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
    // Per-app log drains follow the app's target servers (cluster members vs its own server): resolve the old
    // targets before the update, the new ones after, and re-push to both so a server that no longer ships the
    // app's logs stops and the new member set starts.
    const drainTargetsBefore = cfg.clusterId !== undefined ? await this.logDrainPush.targetServerIds(app).catch(() => [] as string[]) : [];
    await this.prisma.application.update({ where: { id }, data });
    if (cfg.clusterId !== undefined && cfg.clusterId !== app.clusterId) {
      const drainTargetsAfter = await this.logDrainPush.targetServerIds({ id: app.id, serverId: app.serverId, clusterId: cfg.clusterId }).catch(() => [] as string[]);
      void this.logDrainPush.pushForServers([...drainTargetsBefore, ...drainTargetsAfter]).catch(() => undefined);
    }
    await this.audit.log({ actor: userId, action: "app.clusterconfig.update", target: id });
  }

  /** LIVE scale a cluster-deployed app to `replicas` NOW (persist the count AND apply it to the running swarm
   *  service, polling to convergence) — unlike setClusterConfig which only persists for the next deploy. Scoped
   *  to swarm apps (replicas are meaningless for a single classic container) and refuses N>1 for a stateful
   *  (named-volume) app pinned to one node, mirroring setClusterConfig's guard. Reuses swarmDeploy.scale (which
   *  has no auth of its own) behind requireWrite('apps:deploy'). */
  async scaleNow(userId: string, id: string, replicas: number): Promise<void> {
    const app = await this.requireMutate(userId, id, "apps:deploy");
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
    const app = await this.requireMutate(userId, id);
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
    cfg: {
      deployStrategy?: "ROLLING" | "RECREATE";
      rollbackOnFailure?: boolean;
      imagesToKeep?: number | null;
      postCutoverSoakSec?: number;
      stopGracePeriodSec?: number | null;
      drainSec?: number | null;
    },
  ): Promise<void> {
    const app = await this.requireMutate(userId, id);
    // The grace window / drain are applied by the classic docker-run scripts only. Setting one on a compose or
    // swarm app would be a silent no-op, so refuse (clearing with null is always allowed).
    if ((cfg.stopGracePeriodSec != null || cfg.drainSec != null) && app.source === "COMPOSE") {
      throw new BadRequestException("set stop_grace_period in the compose file instead");
    }
    if ((cfg.stopGracePeriodSec != null || cfg.drainSec != null) && app.clusterId) {
      throw new BadRequestException("stop grace period and drain aren't supported for swarm apps yet");
    }
    await this.prisma.application.update({
      where: { id },
      data: {
        // undefined-means-keep (mirrors imagesToKeep) so a partial API/MCP update can't wipe an untouched
        // setting; the web card sends the full object, so its behaviour is unchanged.
        ...(cfg.deployStrategy !== undefined ? { deployStrategy: cfg.deployStrategy } : {}),
        ...(cfg.rollbackOnFailure !== undefined ? { rollbackOnFailure: cfg.rollbackOnFailure } : {}),
        ...(cfg.imagesToKeep !== undefined ? { imagesToKeep: cfg.imagesToKeep } : {}),
        ...(cfg.postCutoverSoakSec !== undefined ? { postCutoverSoakSec: cfg.postCutoverSoakSec } : {}),
        ...(cfg.stopGracePeriodSec !== undefined ? { stopGracePeriodSec: cfg.stopGracePeriodSec } : {}),
        ...(cfg.drainSec !== undefined ? { drainSec: cfg.drainSec } : {}),
      },
    });
    await this.audit.log({
      actor: userId,
      action: "app.deploysettings.update",
      target: id,
      ...(cfg.stopGracePeriodSec !== undefined || cfg.drainSec !== undefined || cfg.postCutoverSoakSec !== undefined
        ? {
            meta: {
              ...(cfg.postCutoverSoakSec !== undefined ? { postCutoverSoakSec: cfg.postCutoverSoakSec } : {}),
              ...(cfg.stopGracePeriodSec !== undefined ? { stopGracePeriodSec: cfg.stopGracePeriodSec } : {}),
              ...(cfg.drainSec !== undefined ? { drainSec: cfg.drainSec } : {}),
            },
          }
        : {}),
    });
  }

  async setEnvironment(userId: string, id: string, environmentId: string): Promise<void> {
    const app = await this.requireWrite(userId, id);
    await this.assertEnvAccess(userId, environmentId, app.teamId);
    await this.prisma.application.update({ where: { id }, data: { environmentId } });
    await this.audit.log({ actor: userId, action: "app.environment.update", target: id });
  }

  /** Assign, change or clear an app's domain after creation (applied on next deploy). */
  async setDomain(userId: string, id: string, domain: string | null): Promise<void> {
    const app = await this.requireMutate(userId, id);
    if (domain !== null) this.assertNotAdopted(app, "domains");
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
    const app = await this.requireMutate(userId, id);
    this.assertNotAdopted(app, "domains");
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

  /** Batched per-service domains for several compose apps (one query, grouped by app); empty input → no query. */
  private async loadServiceDomainsMany(appIds: string[]): Promise<Map<string, { service: string; hostname: string; port: number }[]>> {
    const byApp = new Map<string, { service: string; hostname: string; port: number }[]>();
    if (!appIds.length) return byApp;
    const rows = await this.prisma.appServiceDomain.findMany({ where: { applicationId: { in: appIds } }, orderBy: { createdAt: "asc" } });
    for (const r of rows) {
      const list = byApp.get(r.applicationId) ?? [];
      list.push({ service: r.service, hostname: r.hostname, port: r.port });
      byApp.set(r.applicationId, list);
    }
    return byApp;
  }

  /**
   * Replace a COMPOSE app's per-service domains — each routes a named compose service (on a port) to its own
   * hostname, applied on the next deploy. Validated like extra domains (panel/primary/cross-app/cert), plus
   * the service must exist in the stored compose YAML (for a git compose the deploy's render step checks it).
   */
  async setServiceDomains(userId: string, id: string, rows: { service: string; hostname: string; port: number }[]): Promise<void> {
    const app = await this.requireMutate(userId, id);
    this.assertNotAdopted(app, "domains");
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

  /** The hub-owned network attachments of a COMPOSE app's services (empty when none). */
  async listComposeNetworks(userId: string, id: string): Promise<ComposeNetworkRow[]> {
    const app = await this.requireWrite(userId, id);
    if (app.source !== "COMPOSE") throw new BadRequestException("compose networks apply only to compose apps");
    return this.appComposeNetworks(app);
  }

  /**
   * Replace the app's hub-owned compose network attachments: each row joins ONE compose service to a user network under
   * DNS aliases (the deploy creates the network, labelled tugra.managed), so sibling apps that join the same network
   * reach a stateful service privately. Stored-compose apps only (a git compose renders its own override), never a
   * clustered app, never while a deploy is running. The service must exist in the stored YAML. Applied on the next deploy.
   */
  async setComposeNetworks(userId: string, id: string, rows: ComposeNetworkRow[]): Promise<void> {
    const app = await this.requireMutate(userId, id);
    this.assertNotAdopted(app, "compose networks");
    if (app.source !== "COMPOSE" || !app.composeFile || app.gitUrl) throw new BadRequestException("compose networks apply only to a compose app with a stored compose file");
    if (app.clusterId) throw new BadRequestException("compose networks aren't supported for clustered apps");
    const services = new Set(composeServiceNames(app.composeFile));
    for (const r of rows) {
      if (!services.has(r.service)) throw new BadRequestException(`compose service "${r.service}" is not defined in the compose file`);
    }
    await this.ensureNoActiveDeploy(id);
    const clean = rows.map((r) => ({ network: r.network, service: r.service, aliases: [...r.aliases] }));
    await this.prisma.application.update({ where: { id }, data: { composeNetworks: clean.length ? (clean as unknown as Prisma.InputJsonValue) : Prisma.DbNull } });
    await this.audit.log({ actor: userId, action: "app.compose_networks.update", target: id, meta: { count: clean.length, networks: [...new Set(clean.map((r) => r.network))] } });
  }

  private appComposeNetworks(app: Application): ComposeNetworkRow[] {
    return Array.isArray(app.composeNetworks) ? (app.composeNetworks as unknown as ComposeNetworkRow[]) : [];
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
    const app = await this.requireMutate(userId, id);
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
    return this.view({ ...app, ...e, ...certCleared }, perms?.has("apps:config") ?? false, perms?.has("apps:deploy") ?? false, ctx, server.publicIp ?? server.publicIpv6 ?? null, { health: await this.loadHealth(app), imageLive: await this.loadImageLive(app) });
  }

  async setDomainOptions(
    userId: string,
    id: string,
    opts: { domainRedirect?: "www" | "root" | null; securityHeaders?: boolean; gzip?: boolean; forwardAuth?: string | null; ipAllowlist?: string[]; pathPrefix?: string | null; stripPrefix?: boolean; dnsChallenge?: boolean; rateLimit?: { average: number; burst: number; period: "1s" | "1m" | "1h" } | null },
  ): Promise<void> {
    const app = await this.requireMutate(userId, id);
    this.assertNotAdopted(app, "domain options");
    const data: Prisma.ApplicationUncheckedUpdateInput = {};
    if (opts.dnsChallenge === true) await this.assertCanEnableDnsChallenge(app);
    if (opts.dnsChallenge !== undefined) data.dnsChallenge = opts.dnsChallenge;
    if (opts.domainRedirect !== undefined) data.domainRedirect = opts.domainRedirect;
    if (opts.securityHeaders !== undefined) data.securityHeaders = opts.securityHeaders;
    if (opts.gzip !== undefined) data.gzip = opts.gzip;
    if (opts.forwardAuth !== undefined) data.forwardAuth = opts.forwardAuth;
    if (opts.ipAllowlist !== undefined) data.ipAllowlist = opts.ipAllowlist;
    if (opts.pathPrefix !== undefined) data.pathPrefix = opts.pathPrefix;
    if (opts.stripPrefix !== undefined) data.stripPrefix = opts.stripPrefix;
    if (opts.rateLimit !== undefined) data.rateLimit = opts.rateLimit === null ? Prisma.JsonNull : (opts.rateLimit as unknown as Prisma.InputJsonValue);
    await this.prisma.application.update({ where: { id }, data });
    await this.audit.log({ actor: userId, action: "app.domainOptions.update", target: id, ...(opts.dnsChallenge !== undefined ? { meta: { dnsChallenge: opts.dnsChallenge } } : {}) });
  }

  /**
   * Per-host DNS-01 is refused unless it can actually work: a label pointing at a resolver the proxy does not have
   * would leave the host with NO certificate (silent). Needs an https custom domain on a single-server, non-tunnel
   * app without an uploaded cert, on a server whose proxy has usable DNS-01 credentials.
   */
  private async assertCanEnableDnsChallenge(app: Application): Promise<void> {
    if (app.exposeMode !== "custom" || !app.https) throw new BadRequestException("DNS-01 applies to an HTTPS custom domain");
    if (app.clusterId) throw new BadRequestException("DNS-01 per host is not available for a clustered app");
    if (app.tunnelExposed) throw new BadRequestException("DNS-01 per host is not available for a tunnel-exposed app");
    if (app.certType === "custom") throw new BadRequestException("an uploaded certificate is in use - remove the uploaded certificate first");
    const cfg = await this.moduleRef.get(ProxyConfigService, { strict: false }).resolveFor(app.serverId).catch(() => null);
    if (!cfg?.dnsProvider || !cfg.dnsCreds || Object.keys(cfg.dnsCreds).length === 0) {
      throw new BadRequestException("the server has no usable DNS-01 credentials - add them in the server's network settings first");
    }
  }

  /** At deploy time map the dnsChallenge flag onto the spec: certType le-dns + the per-host label flag, never the
   *  wildcard. FAIL-SOFT to HTTP-01 (a cert still issues once DNS points here) with a deploy-log note when the
   *  server lost its DNS-01 credentials - a dead resolver is never emitted. Existing apps (flag off) are untouched. */
  private async hydrateDnsChallenge(app: Application, spec: AppSpec, quiet = false): Promise<void> {
    if (!app.dnsChallenge || app.clusterId || app.domainKind !== "custom" || !app.https || app.certType !== "le-http") return;
    const cfg = await this.moduleRef.get(ProxyConfigService, { strict: false }).resolveFor(app.serverId).catch(() => null);
    if (!cfg?.dnsProvider || !cfg.dnsCreds || Object.keys(cfg.dnsCreds).length === 0) {
      if (!quiet) this.deployLogs.push(app.id, "TUGRA: dnsChallenge is on but the server has no usable DNS-01 credentials; using HTTP-01\n");
      return;
    }
    spec.certType = "le-dns";
    spec.dnsPerHost = true;
    spec.wildcardDomain = null;
  }

  /** Replace the app's HTTP Basic Auth users. Each password is hashed with bcrypt (a Traefik-compatible
   *  htpasswd hash) and ONLY the hash is stored — the plaintext never touches the DB. An empty list clears
   *  basic auth. Applies on the next deploy. */
  async setBasicAuth(userId: string, id: string, users: { user: string; password: string }[]): Promise<void> {
    await this.requireMutate(userId, id);
    const hashed = users.map((u) => ({ user: u.user, hash: bcrypt.hashSync(u.password, 10) }));
    await this.prisma.application.update({
      where: { id },
      data: { basicAuthUsers: hashed.length ? (hashed as unknown as Prisma.InputJsonValue) : Prisma.JsonNull },
    });
    await this.audit.log({ actor: userId, action: "app.basicAuth.update", target: id, meta: { count: hashed.length } });
  }

  /** Replace the app's custom redirect rules (one Traefik redirectregex middleware each). Replace-set
   *  semantics: the whole list is sent each time; an empty list clears all redirects. The regex/replacement
   *  are stored verbatim (validated single-line + length-capped in the DTO) and shell/YAML-escaped at the
   *  deploy boundary. Applies on the next deploy. */
  async setRedirects(userId: string, id: string, redirects: { regex: string; replacement: string; permanent: boolean }[]): Promise<void> {
    await this.requireMutate(userId, id);
    await this.prisma.application.update({
      where: { id },
      data: { redirects: redirects.length ? (redirects as unknown as Prisma.InputJsonValue) : Prisma.JsonNull },
    });
    await this.audit.log({ actor: userId, action: "app.redirects.update", target: id, meta: { count: redirects.length } });
  }

  /** Set the Docker restart policy for a classic IMAGE/GIT app's container (null → the "unless-stopped"
   *  default). Refused on compose/cluster/preview apps when setting a non-null value — the `--restart` flag is
   *  emitted only on the classic docker-run path (compose declares its own `restart:`, swarm its own restart-
   *  condition). Clearing (null) is always allowed so a stale policy can be removed after a move. Applies on
   *  the next deploy. */
  async setRestartPolicy(userId: string, id: string, restartPolicy: string | null, maxRetries?: number | null): Promise<void> {
    const app = await this.requireMutate(userId, id);
    if (restartPolicy !== null && (app.source === "COMPOSE" || app.clusterId || app.isPreview)) {
      throw new BadRequestException("a restart policy is only supported on single-server Image and Git apps");
    }
    // The retry cap belongs to on-failure only: any other policy (or null) clears it; on-failure keeps the stored
    // value when the caller doesn't send one.
    const retries = restartPolicy === "on-failure" ? maxRetries : null;
    await this.prisma.application.update({
      where: { id },
      data: { restartPolicy, ...(retries !== undefined ? { restartMaxRetries: retries } : {}) },
    });
    await this.audit.log({
      actor: userId,
      action: "app.restartPolicy.update",
      target: id,
      meta: { restartPolicy: restartPolicy ?? "unless-stopped", maxRetries: retries ?? null },
    });
  }

  /**
   * Upload an operator-supplied custom TLS cert for this app (certType → "custom"). The cert/key pair is
   * validated + matched here (parseCustomCert) so a broken pair is rejected before anything is stored; the
   * key is encrypted at rest and never returned. Takes effect on the next deploy, when the deploy script
   * writes the cert into the proxy's /dynamic and the router serves it statically by SNI (no ACME).
   */
  async setCustomCert(userId: string, id: string, certPem: string, keyPem: string): Promise<{ domains: string[]; notAfter: string }> {
    const app = await this.requireMutate(userId, id);
    this.assertNotAdopted(app, "custom certificates");
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
    const app = await this.requireMutate(userId, id);
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
    await this.requireMutate(userId, id); // apps:config — we will set the domain; fail before any DNS mutation
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
        ssl: await domainSsl(a.domain!, a.https, probeSsl),
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

  /**
   * assertEnvInTeam plus the caller's access to the destination project. A new/moved resource has no id
   * yet, so this is the project-level check (`requireProjectAccess`); defence in depth for members whose
   * access is limited to specific projects.
   */
  private async assertEnvAccess(userId: string, environmentId: string, teamId: string): Promise<void> {
    const env = await this.prisma.environment.findUnique({
      where: { id: environmentId },
      include: { project: true },
    });
    if (!env || env.project.teamId !== teamId) {
      throw new BadRequestException("environment not found in this team");
    }
    await this.access.requireProjectAccess(userId, teamId, env.project.id);
  }

  // ── helpers ──
  private appVolumes(app: Application): AppVolume[] {
    return Array.isArray(app.volumes) ? (app.volumes as unknown as AppVolume[]) : [];
  }

  /** A container-command override column (Json) coerced to a string[] — null unless it is a clean array of
   *  strings (so a malformed value never reaches `docker run` as a half-argv). `[]` is preserved (it means
   *  "clear the image entrypoint"). */
  /** The stored custom-labels map when it is a plain `{string: string}` object with entries, else null. Shape-only
   *  (never throws): validation is assertSafeCustomLabels at set-time, deploy and rollback. */
  private storedCustomLabels(j: Prisma.JsonValue | null | undefined): Record<string, string> | null {
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const entries = Object.entries(j as Record<string, unknown>);
    if (entries.length === 0 || !entries.every(([, v]) => typeof v === "string")) return null;
    return Object.fromEntries(entries) as Record<string, string>;
  }

  /** Fail-closed re-validation of the STORED custom labels at deploy/rollback time (a hand-edited row with a
   *  reserved key, or one that now collides with a raw `--label` in dockerOptions, must not reach a script).
   *  dockerOptions are not applied on swarm, so the collision check is skipped for cluster apps. */
  private assertStoredCustomLabels(app: Application): void {
    if (app.source === "COMPOSE" || app.customLabels == null) return;
    assertSafeCustomLabels(app.customLabels, { dockerOptions: app.clusterId ? null : app.dockerOptions });
  }

  /** Did a recent deploy of this swarm app carry custom labels? Drives the one-shot stateless scrub that strips
   *  container labels the operator has since removed (`docker service update` never removes on its own). Looks at
   *  the latest snapshot AND the latest SUCCESS snapshot (excluding the current deployment), so a failed
   *  label-removal deploy cannot strand the old labels: the next deploy scrubs again. After a clean deploy of the
   *  new (empty) set neither snapshot has labels and the scrub block disappears. */
  private async prevSnapshotHadCustomLabels(appId: string, excludeDeploymentId?: string): Promise<boolean> {
    const base = { appId, configSnapshot: { not: Prisma.DbNull }, ...(excludeDeploymentId ? { id: { not: excludeDeploymentId } } : {}) };
    const has = (snap: Prisma.JsonValue | null | undefined) => {
      const cl = snap && typeof snap === "object" && !Array.isArray(snap) ? (snap as Record<string, unknown>).customLabels : null;
      return !!cl && typeof cl === "object" && Object.keys(cl as object).length > 0;
    };
    const [latest, latestOk] = await Promise.all([
      this.prisma.deployment.findFirst({ where: base, orderBy: { createdAt: "desc" }, select: { configSnapshot: true } }),
      this.prisma.deployment.findFirst({ where: { ...base, status: "SUCCESS" }, orderBy: { createdAt: "desc" }, select: { configSnapshot: true } }),
    ]);
    return has(latest?.configSnapshot) || has(latestOk?.configSnapshot);
  }

  private argv(j: Prisma.JsonValue | null): string[] | null {
    return Array.isArray(j) && j.every((x) => typeof x === "string") ? (j as string[]) : null;
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

  /** A linked git source's credential only authenticates its own host (github.com for a GitHub App, the instance
   *  host for a Gitea/Forgejo/Codeberg token). Refuse a repo URL anywhere else so the secret can never be sent there. */
  private assertSourceHost(gs: { provider: string; apiUrl: string | null }, gitUrl: string | null | undefined): void {
    if (!gitUrl || isSshGitUrl(gitUrl)) return; // ssh clones with a deploy key (guarded separately); no URL → nothing to pin yet
    const want = sourceCloneHost(gs);
    const host = gitUrlHost(gitUrl);
    if (host && host !== want) {
      throw new BadRequestException(`the linked ${gs.provider} source only authenticates ${want} repositories — unlink it or point the repo at ${want}`);
    }
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

  private appBuildSecrets(app: Application): Record<string, string> {
    if (!app.buildSecretsEnc) return {};
    try {
      return JSON.parse(this.crypto.decrypt(app.buildSecretsEnc)) as Record<string, string>;
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
  private async resolveEnvLayers(app: Application): Promise<{ merged: Record<string, string>; appEnv: Record<string, string>; secretRefKeys: Set<string> }> {
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
    // External secret-store refs are fetched fresh and take the HIGHEST precedence: a managed secret wins
    // over a possibly-stale literal left in the app's plain env. A ref that can't be fetched fails the deploy.
    const secrets = await this.secretRefs.resolveSecretEnv(app);
    return { merged: { ...merged, ...linked, ...appEnv, ...secrets }, appEnv, secretRefKeys: new Set(Object.keys(secrets)) }; // shared < linked DB < app-env < external secret
  }

  /**
   * Resolve the env layers ONCE, then apply the per-variable flags: `spec.env` is the runtime-eligible env
   * (runtime:false keys removed), `spec.envMeta` carries the render flags, and with `withBuild` the build-time
   * flagged values (the app's OWN env only) are merged into `spec.buildArgs` under the explicit build args.
   * A corrupt/unreadable flag blob FAILS CLOSED: defaulting could expose a build-only variable at runtime.
   */
  private async attachResolvedEnv(app: Application, spec: AppSpec, opts: { withBuild: boolean }): Promise<{ autoMultiline: string[] }> {
    const { merged, appEnv, secretRefKeys } = await this.resolveEnvLayers(app);
    let meta: EnvMeta;
    try {
      meta = pruneMeta(this.loadMeta(app), Object.keys(appEnv)); // DB is never trusted: re-normalised on every read
    } catch (e) {
      if (e instanceof EnvMetaCorruptError) throw new Error(`TUGRA: env flags unreadable for app ${app.id}`);
      throw e;
    }
    // Values stored before the Multiline flag existed (any layer) travel as multiline instead of failing the deploy;
    // the flags are NOT persisted, so the write-time rule (a line break needs the flag) is unchanged.
    const legacy = autoMultilineLegacy(merged, meta);
    if (legacy.issue) throw new Error(legacy.issue.message);
    meta = legacy.meta;
    const buildSecretKeys = new Set(Object.keys(this.appBuildSecrets(app)));
    // Validate the app's own values plus any auto-flagged shared/linked/secret value, so the multiline count and
    // total budgets cover every value that will actually ride the multiline transport.
    const toValidate: Record<string, string> = { ...appEnv };
    for (const k of legacy.keys) toValidate[k] = merged[k];
    const issues = validateEnvFlags(toValidate, meta, { source: app.source, buildSecretKeys, mode: "deploy" });
    if (issues.length) throw new Error(`TUGRA: invalid environment flags${issues[0].key ? ` (${issues[0].key})` : ""}: ${issues[0].message}`); // names keys only
    const r = applyEnvFlags({ merged, appEnv, meta, secretRefKeys, buildSecretKeys, builds: opts.withBuild && app.source === "GIT" });
    spec.env = r.env;
    spec.envMeta = Object.keys(meta).length ? meta : undefined;
    if (opts.withBuild) {
      spec.buildArgs = { ...r.buildArgs, ...this.appBuildArgs(app) }; // explicit build args win
      if (r.buildFlagKeys.length) spec.buildFlagKeys = r.buildFlagKeys;
      if (r.droppedForBuildSecret.length) spec.buildFlagDropped = r.droppedForBuildSecret;
    }
    return { autoMultiline: legacy.keys };
  }

  /**
   * The spec for a compose lifecycle command (stop / start / restart / logs / down). Every `docker compose`
   * subcommand interpolates the project config, and literal / multiline variables ride the CLI process environment
   * rather than the auto-read `.env`, so those commands need exactly those values. Only an app that carries flags
   * is touched (the rest is byte-identical to before); only the literal / multiline values are kept; and any failure
   * to resolve them degrades to the bare spec, because stopping or removing an app must never depend on its env.
   */
  private async composeOpSpec(app: Application): Promise<AppSpec> {
    const spec = this.toSpec(app);
    if (!app.envMetaEnc) return spec;
    try {
      await this.attachResolvedEnv(app, spec, { withBuild: false });
      const meta = spec.envMeta ?? {};
      spec.env = Object.fromEntries(Object.entries(spec.env ?? {}).filter(([k]) => meta[k]?.literal || meta[k]?.multiline));
    } catch (e) {
      this.logger.warn(`compose lifecycle for app ${app.id}: flagged env unavailable (${e instanceof Error ? e.message : "error"}); running without it`);
      spec.env = {};
      spec.envMeta = undefined;
    }
    return spec;
  }

  /** One deploy-log line per value that was delivered as multiline without the flag (legacy data). Key names only. */
  private logAutoMultiline(appId: string, keys: string[]): void {
    for (const k of keys) this.deployLogs.push(appId, `TUGRA: auto multiline: ${k}\n`);
  }

  /** Decrypt + parse the stored flag blob. Throws EnvMetaCorruptError on any decrypt/parse failure (fail closed). */
  private loadMeta(app: Application): EnvMeta {
    if (!app.envMetaEnc) return parseEnvMeta(null);
    let plain: string;
    try {
      plain = this.crypto.decrypt(app.envMetaEnc);
    } catch {
      throw new EnvMetaCorruptError();
    }
    return parseEnvMeta(plain);
  }

  private loadMetaOrConflict(app: Application): EnvMeta {
    try {
      return this.loadMeta(app);
    } catch (e) {
      if (e instanceof EnvMetaCorruptError) throw new ConflictException("stored variable flags are unreadable; resend the full set with an explicit flags object");
      throw e;
    }
  }

  private encryptMeta(meta: EnvMeta): string | null {
    const enc = encodeEnvMeta(meta);
    return enc === null ? null : this.crypto.encrypt(enc);
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
    // D2 settings apply to classic docker-run apps only; mask them for COMPOSE/swarm (like networkAliases) so a
    // stale value left from before a move can't leak into a script that doesn't honour it.
    const classic = app.source !== "COMPOSE" && !app.clusterId;
    return {
      id: app.id,
      source: app.source,
      image: app.image,
      gitUrl: app.gitUrl,
      gitBranch: app.gitBranch,
      gitCommit: app.gitCommit,
      // Clone/build behaviour: GIT only (COMPOSE / IMAGE stay undefined, so their scripts are byte-identical).
      ...(app.source === "GIT"
        ? {
            gitSubmodules: app.gitSubmodules,
            gitLfs: app.gitLfs,
            gitShallowClone: app.gitShallowClone,
            sourceCommitMode: app.sourceCommitMode,
            disableBuildCache: app.disableBuildCache,
            injectEnvAsBuildArgs: app.injectEnvAsBuildArgs && app.buildType === "DOCKERFILE",
          }
        : {}),
      buildType: app.buildType,
      dockerfilePath: app.dockerfilePath,
      dockerBuildTarget: app.dockerBuildTarget,
      inlineDockerfile: app.inlineDockerfile,
      baseDirectory: app.baseDirectory,
      buildCommand: app.buildCommand,
      nixpacksInstallCmd: app.nixpacksInstallCmd,
      nixpacksBuildCmd: app.nixpacksBuildCmd,
      nixpacksStartCmd: app.nixpacksStartCmd,
      outputDir: app.outputDir,
      composeFile: app.composeFile,
      composePath: app.composePath,
      ...(app.source === "COMPOSE" && app.composeAdopt ? { composeAdopt: app.composeAdopt } : {}),
      healthCmd: app.healthCmd,
      healthCheckType: app.healthCheckType,
      healthCheckPath: app.healthCheckPath,
      healthCheckPort: app.healthCheckPort,
      healthCheckMethod: app.healthCheckMethod,
      healthCheckScheme: app.healthCheckScheme,
      healthCheckResponseText: app.healthCheckResponseText,
      healthInterval: app.healthInterval,
      healthTimeout: app.healthTimeout,
      healthRetries: app.healthRetries,
      healthStartPeriod: app.healthStartPeriod,
      healthExpectedStatus: app.healthExpectedStatus,
      memoryMb: app.memoryMb,
      cpus: app.cpus,
      reserveMemoryMb: app.reserveMemoryMb,
      reserveCpus: app.reserveCpus,
      // Classic docker-run flags only: compose ignores them and swarm doesn't map them, so a stale value left
      // from before a move to compose/swarm can't leak into the spec (or a config snapshot).
      ...(classic
        ? { memorySwapMb: app.memorySwapMb, pidsLimit: app.pidsLimit, shmSizeMb: app.shmSizeMb, cpuShares: app.cpuShares, cpusetCpus: app.cpusetCpus }
        : {}),
      gpus: app.gpus,
      postCutoverSoakSec: app.postCutoverSoakSec,
      replicas: app.replicas,
      placementConstraints: this.appPlacement(app).constraints,
      placementSpreadLabelKey: this.appPlacement(app).spreadLabelKey,
      dockerOptions: app.dockerOptions,
      containerEntrypoint: this.argv(app.containerEntrypoint),
      containerCommand: this.argv(app.containerCommand),
      // Custom container labels: classic docker-run + swarm (not COMPOSE, which declares labels in its own YAML).
      // Lenient read (shape only): the deploy/rollback gates run assertSafeCustomLabels and the script builders
      // re-assert, so a hand-edited row fails closed at deploy without breaking unrelated reads (logs, containers).
      customLabels: app.source === "COMPOSE" ? null : this.storedCustomLabels(app.customLabels),
      restartPolicy: app.restartPolicy,
      restartMaxRetries: classic && app.restartPolicy === "on-failure" ? app.restartMaxRetries : null,
      stopGracePeriodSec: classic ? app.stopGracePeriodSec : null,
      drainSec: classic ? app.drainSec : null,
      networks: classic ? (app.networks ?? []) : [],
      containerAlias: classic ? app.containerAlias : null,
      preDeployCommand: app.preDeployCommand,
      postDeployCommand: app.postDeployCommand,
      composeHookService: app.composeHookService,
      pushImageName: app.pushImageName,
      pushImageTag: app.pushImageTag,
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
      extraPorts: app.source === "COMPOSE" ? null : parseExtraPorts(app.extraPorts),
      networkAliases: app.source === "COMPOSE" || app.clusterId ? [] : (app.networkAliases ?? []),
      domain: app.domain,
      extraDomains: app.extraDomains ?? [],
      domainRedirect: (app.domainRedirect as "www" | "root" | null) ?? null,
      securityHeaders: app.securityHeaders,
      gzip: app.gzip,
      forwardAuth: app.forwardAuth,
      ipAllowlist: app.ipAllowlist ?? [],
      basicAuthUsers: parseBasicAuthUsers(app.basicAuthUsers),
      pathPrefix: app.pathPrefix ?? null,
      stripPrefix: app.stripPrefix ?? true,
      rateLimit: parseRateLimit(app.rateLimit),
      redirects: parseRedirects(app.redirects),
      certType: app.certType,
      // A clustered app deploys on the swarm manager's proxy, where the per-server /dynamic cert write never
      // runs — so never feed it a custom cert (it would relabel to tls=true with no cert and serve the
      // default). Classic apps only. setCustomCert also refuses clustered apps up front.
      certPem: app.clusterId ? null : app.certPem,
      certKey: app.clusterId ? null : this.appCertKey(app),
      composeWebService: web?.service ?? null,
      // Config mounts are a template (COMPOSE) feature only — never for a docker-run app.
      configMounts: app.source === "COMPOSE" ? this.appConfigMounts(app) : null,
      // Hub-owned extra network attachments of a stored-compose app's services (see setComposeNetworks).
      composeNetworks: app.source === "COMPOSE" && !app.gitUrl ? this.appComposeNetworks(app) : null,
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
  private validatePngIcon(buf: Buffer): void {
    validatePngIcon(buf); // shared structural PNG check (src/common/png-icon.ts) — identical bar for every entity
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

  /** requireWrite + the app-move lock: a config edit / lifecycle action / rollback is refused (409
   *  app_move_in_progress) while the app is being moved to another server. Deploy QUEUEING deliberately keeps using
   *  requireWrite (a queued deploy just waits until the move ends). */
  private async requireMutate(
    userId: string,
    id: string,
    permission: TeamPermission = "apps:config",
  ): Promise<Application> {
    const app = await this.requireWrite(userId, id, permission);
    await assertNoActiveMove(this.prisma, id);
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

  /** The airtight container-name match for one app (shared by the runtime view and the health loader so the
   *  prefix rules cannot drift). `withRollout` adds the rolling deploy's not-yet-live `__rollout` container. */
  private containerNameFilter(app: Pick<Application, "id" | "clusterId"> & { composeAdopt?: unknown }, opts: { withRollout: boolean }) {
    const prefix = composeProject(app);
    return [
      { containerName: prefix },
      ...(opts.withRollout ? [{ containerName: `${prefix}__rollout` }] : []),
      { containerName: { startsWith: `${prefix}-` } },
      ...(app.clusterId ? [{ containerName: { startsWith: `${prefix}.` } }] : []),
    ];
  }

  /** Aggregated container health for one app, from the container-health poll's ContainerState rows (DB only).
   *  Best-effort: a lookup failure yields `unknown`, never a failed view. */
  private async loadHealth(app: Application): Promise<AppContainerHealth> {
    const checkType = resolveHealthCheckType(app);
    try {
      const serverIds = app.clusterId
        ? (await this.prisma.server.findMany({ where: { clusterId: app.clusterId }, select: { id: true } })).map((s) => s.id)
        : [app.serverId];
      const rows = await this.prisma.containerState.findMany({
        where: { serverId: { in: serverIds }, OR: this.containerNameFilter(app, { withRollout: false }) },
        select: { status: true, health: true, updatedAt: true },
      });
      return reduceHealth(rows, checkType, Date.now());
    } catch {
      return UNKNOWN_HEALTH(checkType);
    }
  }

  /** Batched health for list views: one ContainerState query for every app (no N+1) plus one server lookup only
   *  when a clustered app is present. Same best-effort contract as `loadHealth`. */
  private async loadHealthMany(apps: Application[]): Promise<Map<string, AppContainerHealth>> {
    const out = new Map<string, AppContainerHealth>();
    for (const a of apps) out.set(a.id, UNKNOWN_HEALTH(resolveHealthCheckType(a)));
    if (!apps.length) return out;
    try {
      const clusterIds = [...new Set(apps.map((a) => a.clusterId).filter((c): c is string => !!c))];
      const clusterServers = clusterIds.length
        ? await this.prisma.server.findMany({ where: { clusterId: { in: clusterIds } }, select: { id: true, clusterId: true } })
        : [];
      const serversOf = (a: Application): Set<string> =>
        a.clusterId ? new Set(clusterServers.filter((s) => s.clusterId === a.clusterId).map((s) => s.id)) : new Set([a.serverId]);
      const allServers = new Set<string>();
      for (const a of apps) for (const id of serversOf(a)) allServers.add(id);
      // Adopted compose stacks run under their own project name, so their containers are not `tugra_*`.
      const adoptedProjects = [...new Set(apps.filter((a) => adoptedCompose(a)).map((a) => composeProject(a)))];
      const rows = await this.prisma.containerState.findMany({
        where: {
          serverId: { in: [...allServers] },
          OR: [{ containerName: { startsWith: "tugra_" } }, ...adoptedProjects.map((p) => ({ containerName: { startsWith: `${p}-` } }))],
          updatedAt: { gte: new Date(Date.now() - CONTAINER_STATE_MAX_AGE_MS) },
        },
        select: { serverId: true, containerName: true, status: true, health: true, updatedAt: true },
      });
      const byApp = new Map<string, typeof rows>();
      for (const r of rows) {
        const id = appIdOfContainer(r.containerName);
        if (id) byApp.set(id, [...(byApp.get(id) ?? []), r]);
      }
      const now = Date.now();
      for (const a of apps) {
        const servers = serversOf(a);
        const adopted = adoptedCompose(a) ? composeProject(a) : undefined;
        const pool = adopted ? rows : (byApp.get(a.id) ?? []);
        const mine = pool.filter((r) => servers.has(r.serverId) && liveContainerOf(a.id, !!a.clusterId, r.containerName, adopted));
        out.set(a.id, reduceHealth(mine, resolveHealthCheckType(a), now));
      }
    } catch {
      /* best-effort: keep the `unknown` defaults */
    }
    return out;
  }

  /** The live deploy digest of one app for the image-update view. Best-effort (a DB blip must not break the
   *  app view); only queried for an enabled IMAGE app, otherwise the view is null / disabled anyway. */
  private async loadImageLive(app: Application): Promise<LiveImage | null> {
    if (!isImageCheckSubject(app) || !app.imageUpdateCheck) return null;
    try {
      return (await loadLiveImageMany(this.prisma, [app.id])).get(app.id) ?? null;
    } catch {
      return null;
    }
  }

  /** Batched live digests for a list page: ONE query for every enabled IMAGE app (none when there are none). */
  private async loadImageLiveMany(apps: Application[]): Promise<Map<string, LiveImage>> {
    const ids = apps.filter((a) => isImageCheckSubject(a) && a.imageUpdateCheck).map((a) => a.id);
    try {
      return await loadLiveImageMany(this.prisma, ids);
    } catch {
      return new Map();
    }
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
    extras?: ViewExtras,
  ): AppView {
    // A domainless COMPOSE app is reachable via its portMappings, not the always-null scalar hostPort — derive the
    // effective port (only when needed) so the URL is never null.
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
    return {
      id: app.id,
      name: app.name,
      description: app.description ?? null,
      source: app.source,
      image: app.image,
      gitUrl: app.gitUrl,
      gitBranch: app.gitBranch,
      gitCommit: app.gitCommit,
      gitSubmodules: app.gitSubmodules,
      gitLfs: app.gitLfs,
      gitShallowClone: app.gitShallowClone,
      disableBuildCache: app.disableBuildCache,
      injectEnvAsBuildArgs: app.injectEnvAsBuildArgs,
      sourceCommitMode: app.sourceCommitMode,
      gitSourceId: app.gitSourceId,
      buildType: app.buildType,
      buildCommand: app.buildCommand,
      nixpacksInstallCmd: app.nixpacksInstallCmd,
      nixpacksBuildCmd: app.nixpacksBuildCmd,
      nixpacksStartCmd: app.nixpacksStartCmd,
      dockerfilePath: app.dockerfilePath,
      dockerBuildTarget: app.dockerBuildTarget,
      inlineDockerfile: canWrite ? app.inlineDockerfile : null, // a Dockerfile can embed tokens -> writer-only
      hasInlineDockerfile: !!app.inlineDockerfile,
      baseDirectory: app.baseDirectory,
      watchPaths: app.watchPaths ?? [],
      autoDeploy: app.autoDeploy ?? true,
      imageUpdate: computeImageUpdateView(app, extras?.imageLive, canWrite, this.imageUpdate.intervalMin() === 0),
      move: extras?.move ?? null,
      outputDir: app.outputDir,
      composeFile: canWrite ? app.composeFile : null,
      composePath: app.composePath,
      composeAdopt: canWrite ? adoptedView(app) : null,
      hasConfigMounts: this.appConfigMounts(app).length > 0,
      healthCmd: app.healthCmd,
      healthCheckType: app.healthCheckType,
      healthCheckPath: app.healthCheckPath,
      healthCheckPort: app.healthCheckPort,
      healthCheckMethod: app.healthCheckMethod,
      healthCheckScheme: app.healthCheckScheme,
      healthCheckResponseText: app.healthCheckResponseText,
      healthInterval: app.healthInterval,
      healthTimeout: app.healthTimeout,
      healthRetries: app.healthRetries,
      healthStartPeriod: app.healthStartPeriod,
      healthExpectedStatus: app.healthExpectedStatus,
      memoryMb: app.memoryMb,
      cpus: app.cpus,
      reserveMemoryMb: app.reserveMemoryMb,
      reserveCpus: app.reserveCpus,
      memorySwapMb: app.memorySwapMb,
      pidsLimit: app.pidsLimit,
      shmSizeMb: app.shmSizeMb,
      cpuShares: app.cpuShares,
      cpusetCpus: app.cpusetCpus,
      gpus: app.gpus,
      deployTimeoutSec: app.deployTimeoutSec,
      dockerOptions: app.dockerOptions,
      allowPrivilegedDockerOptions: app.allowPrivilegedDockerOptions,
      // Hooks are deploy-time exec power and may embed internal paths → writer-only (like composeFile).
      preDeployCommand: canWrite ? app.preDeployCommand : null,
      postDeployCommand: canWrite ? app.postDeployCommand : null,
      composeHookService: canWrite ? app.composeHookService : null,
      composeServices: canWrite && app.source === "COMPOSE" && !app.composePath ? composeServiceNames(app.composeFile) : [],
      // Container argv can embed credentials (e.g. --password=…) → writer-only, like the hooks above.
      containerEntrypoint: canWrite ? this.argv(app.containerEntrypoint) : null,
      containerCommand: canWrite ? this.argv(app.containerCommand) : null,
      // Custom label values can be tokens → writer-only, like the container argv above. A malformed row reads as none.
      customLabels: canWrite ? this.storedCustomLabels(app.customLabels) : null,
      restartPolicy: app.restartPolicy, // not secret → shown regardless of write access
      restartMaxRetries: app.restartMaxRetries, // not secret → shown regardless of write access
      stopGracePeriodSec: app.stopGracePeriodSec,
      drainSec: app.drainSec,
      containerAlias: app.containerAlias,
      networks: app.networks ?? [],
      networkingLocked: hasNetworkOpt(app.dockerOptions),
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
      pushImageName: app.pushImageName,
      pushImageTag: app.pushImageTag,
      buildServerId: app.buildServerId,
      clusterId: app.clusterId,
      replicas: app.replicas,
      placement: this.appPlacement(app),
      constraintServerId: app.constraintServerId,
      deployStrategy: app.deployStrategy,
      rollbackOnFailure: app.rollbackOnFailure,
      imagesToKeep: app.imagesToKeep,
      postCutoverSoakSec: app.postCutoverSoakSec,
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
      containerHealth: extras?.health ?? UNKNOWN_HEALTH(resolveHealthCheckType(app)),
      hostPort: app.hostPort,
      containerPort: app.containerPort,
      extraPorts: parseExtraPorts(app.extraPorts),
      networkAliases: app.networkAliases ?? [],
      // Same plan the run line uses (no env resolution needed); null for compose/swarm or an operator-owned --network.
      internalHost:
        app.source === "COMPOSE" || app.clusterId
          ? null
          : internalHostFor({
              id: app.id,
              domain: app.domain,
              dbNetwork: !!app.dbNetwork,
              dockerOptions: app.dockerOptions,
              source: app.source,
              networks: app.networks ?? [],
              networkAliases: app.networkAliases ?? [],
              containerAlias: app.containerAlias,
              containerPort: app.containerPort,
            }),
      domain: app.domain,
      extraDomains: app.extraDomains ?? [],
      domainRedirect: app.domainRedirect,
      securityHeaders: app.securityHeaders,
      gzip: app.gzip,
      forwardAuth: app.forwardAuth,
      ipAllowlist: app.ipAllowlist ?? [],
      basicAuthUsers: (parseBasicAuthUsers(app.basicAuthUsers) ?? []).map((u) => u.user),
      pathPrefix: app.pathPrefix ?? null,
      stripPrefix: app.stripPrefix ?? true,
      dnsChallenge: app.dnsChallenge ?? false,
      rateLimit: parseRateLimit(app.rateLimit),
      redirects: parseRedirects(app.redirects),
      https: app.https,
      domainKind: app.domainKind,
      exposeMode: app.exposeMode,
      tunnelExposed: app.tunnelExposed,
      certType: app.certType,
      certDomains: app.certDomains,
      certNotAfter: app.certNotAfter,
      hasCustomCert: !!app.certPem,
      url,
      links: appLinks(app, { publicIp: serverIp ?? null, primaryUrl: url, serviceDomains: extras?.serviceDomains ?? [] }),
      // Webhook credentials are a deploy trigger → only exposed to members who can deploy (NOT to
      // apps:config-only members, who could otherwise self-trigger a deploy via the public webhook).
      webhookToken: canDeploy ? app.webhookToken : null,
      webhookSecret:
        canDeploy && app.webhookSecret ? this.crypto.decrypt(app.webhookSecret) : null,
      isPreview: app.isPreview,
      previewEnabled: app.previewEnabled,
      previewExcludeKeys: app.previewExcludeKeys ?? [],
      previewLimit: app.previewLimit,
      prNumber: app.prNumber,
      prProvider: (app.prProvider as PrProvider | null) ?? null,
      prHeadSha: app.prHeadSha ?? null,
      parentAppId: app.parentAppId,
      tags: app.tags,
      volumeBackupEnabled: app.volumeBackupEnabled,
      volumeBackupIntervalHours: app.volumeBackupIntervalHours,
      volumeBackupRetention: app.volumeBackupRetention,
      volumeBackupDestinationId: app.volumeBackupDestinationId,
      envCount: Object.keys(this.appEnv(app)).length,
      canWrite,
      canDeploy,
      createdAt: app.createdAt,
    };
  }
}
