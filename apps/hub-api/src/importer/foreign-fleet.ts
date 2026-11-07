/**
 * Neutral, source-agnostic description of what a competitor PaaS (Coolify/Dokploy/CapRover/Dokku) is
 * running, produced by an {@link ImportSource}'s `discover()`. Every adapter maps its own data model onto
 * these shapes so the planner and executor stay source-independent.
 *
 * SECRET-FREE CONTRACT: a ForeignFleet is safe to send to the client (it becomes `ImportPlan` /
 * `foreignSnapshot`). It therefore carries NO secret VALUES — no DB passwords, no env values, no file-mount
 * contents. Secret values are fetched server-side at apply time via `ImportSource.fetchSecrets()` /
 * `dumpDb()` / `openVolume()`, keyed by the `secretRef`/`sourceRef` here.
 */

export type ForeignBuildPack =
  | "nixpacks" | "railpack" | "static" | "dockerfile" | "dockercompose" | "image"
  | "herokuish" | "paketo" // Cloud Native Buildpacks → Tugra HEROKU
  | "unknown";

/** Where an app's runnable image comes from — decides whether the data plane must ship the image. */
export type ImageOrigin = "registry" | "built-from-git" | "local"; // "local" = built on the source host only → docker save/load

/** Tugra's own enums, as string unions (the planner proposes these; it does not import Prisma here). */
export type TugraAppSource = "GIT" | "IMAGE" | "COMPOSE";
export type TugraBuildType = "NIXPACKS" | "DOCKERFILE" | "STATIC" | "RAILPACK" | "HEROKU";
export type TugraDbEngine =
  | "POSTGRES" | "MYSQL" | "MARIADB" | "MONGO" | "REDIS" | "KEYDB" | "DRAGONFLY" | "CLICKHOUSE" | "LIBSQL";

/** An env entry. The VALUE is never in the snapshot (fetched at apply). `ref` marks entries that must be
 *  resolved first: a shared/scoped variable, a secret-manager/vault reference, a compose magic var, or an
 *  already-encrypted source value the adapter cannot decrypt. */
export interface ForeignEnv {
  key: string;
  secret?: boolean;
  buildTime?: boolean;
  scope?: "resource" | "environment" | "project" | "team" | "shared";
  ref?: { type: "shared" | "vault" | "magic" | "encrypted"; provider?: string; path?: string };
  generated?: boolean; // source-generated (e.g. SERVICE_PASSWORD_*) — regenerate or carry, don't treat as user input
}

export interface ForeignVolume {
  name?: string;
  hostPath?: string;
  mountPath: string;
  type: "named" | "bind" | "file"; // "file" contents are a secret-bearing data-plane fetch, never in the snapshot
  ownerRef?: string; // the app/db sourceRef this volume belongs to (for ordering + dedupe)
}

export interface ForeignDomain {
  host: string;
  https?: boolean;
  port?: number;
  path?: string;
  stripPath?: boolean;
  certType?: "le-http" | "le-dns" | "custom" | "none";
  redirectTo?: string; // e.g. apex↔www
  serviceRef?: string; // which service member this domain targets (compose services)
  primary?: boolean;
}

/** A link from an app to a resource it depends on (a database, or another app it talks to by internal DNS).
 *  Drives the executor's ordering AND the env host-rewrite (e.g. Coolify uuid host, CapRover srv-captain--x). */
export interface ForeignLink {
  kind: "database" | "app";
  ref: string; // the sourceRef of the linked resource
  envKey?: string; // the env var that carries its URL/host (to rewrite)
  internalHost?: string; // the source-side internal hostname to replace
}

/** Resource limits in Tugra units. Reservations are soft swarm scheduling hints (apps only). */
export interface ForeignLimits {
  memoryMb?: number;
  cpus?: number;
  reserveMemoryMb?: number;
  reserveCpus?: number;
}

/** A connected git provider (today: a GitHub App) the source PaaS clones private repos through.
 *  SECRET-FREE: identity only. The App's private key / client secret / webhook secret are NEVER here — they
 *  are returned only by `ImportSource.fetchSecrets("gitProvider:<ref>")`. */
export interface ForeignGitProvider {
  ref: string; // the source provider id (Dokploy githubId); namespaced to "gitProvider:<ref>" for fetchSecrets
  kind: "github";
  appSlug?: string;
  appId?: string;
  installationId?: string;
  htmlUrl?: string;
  appName?: string;
}

export interface ForeignApp {
  sourceRef: string;
  name: string;
  kind: "git" | "image" | "compose" | "service"; // "service" = a multi-container stack (see ForeignService)
  serviceRef?: string; // the ForeignService this app is a member of
  buildPack: ForeignBuildPack;
  image?: string;
  imageOrigin?: ImageOrigin;
  registry?: { host: string; secretRef?: string }; // private registry the image is pulled from
  git?: { url: string; branch?: string; dockerfilePath?: string; dockerfileContent?: string; baseDirectory?: string; composePath?: string; provider?: string }; // composePath = the compose FILE's path within the repo (kind "compose" only; NOT a build-context dir); provider "github" = a private GitHub-App repo (needs a connected GitSource to clone)
  buildCommand?: string;
  startCommand?: string;
  installCommand?: string;
  publishDirectory?: string; // static builds
  buildArgs?: Record<string, string>;
  composeFile?: string;
  processes?: Array<{ name: string; command: string; scale?: number }>; // Procfile web/worker/release
  privileged?: boolean;
  mountsDockerSock?: boolean;
  ports?: number[];
  domains?: ForeignDomain[];
  internalHost?: string; // how other apps reach this one on the source (for rewriting their env)
  env?: ForeignEnv[];
  volumes?: ForeignVolume[];
  links?: ForeignLink[];
  replicas?: number;
  /** Push-to-deploy switch (Tugra `setAutoDeploy`). Absent = the source did not say (Tugra default: on). */
  autoDeploy?: boolean;
  /** Repo-relative glob patterns gating whether a push deploys (Tugra `setWatchPaths`). */
  watchPaths?: string[];
  /** Exec-form argv overrides for the container ENTRYPOINT / CMD (Tugra `setContainerCommand`). */
  containerEntrypoint?: string[];
  containerCommand?: string[];
  /** Hard limits + soft swarm reservations, already in Tugra units (MB / CPUs) (Tugra `setLimits`). */
  limits?: ForeignLimits;
  /** Dockerfile multi-stage target (Tugra `dockerBuildTarget`, via `setBuild`). */
  dockerBuildTarget?: string;
  /** The connected git provider this app clones through: a {@link ForeignGitProvider.ref}. Lets the apply
   *  step resolve the app's link to a Tugra GitSource. Never a credential. */
  gitProviderRef?: string;
  // ── Carried for honesty only — Tugra has NO target for these yet (apply reports them, never drops silently).
  triggerType?: string; // Dokploy "push" | "tag" — Tugra deploys on push only
  dockerContextPath?: string; // Dokploy docker build context dir (Tugra has baseDirectory only)
  staticSpa?: boolean; // Dokploy isStaticSpa — Tugra's static builds always serve an SPA fallback
  restart?: string;
  healthcheck?: { type?: "http" | "cmd" | "none"; path?: string; port?: number; command?: string };
  cron?: Array<{ name: string; schedule: string; command: string }>;
  templateSlug?: string; // when it maps to a Tugra app-store template (Coolify service overlap)
  serverRef?: string;
  /** The source project/environment this app lives in ({@link ForeignProject.ref} / {@link ForeignEnvironment.ref}).
   *  Both optional: a source with no project tree (Coolify, local-docker) leaves them unset → the single
   *  `input.environmentId` behavior. */
  projectRef?: string;
  environmentRef?: string;
}

export interface ForeignDb {
  sourceRef: string;
  name: string;
  engine: TugraDbEngine | "UNKNOWN";
  version?: string;
  image?: string;
  /** NON-secret identity only; the password is fetched at apply via fetchSecrets(secretRef). */
  credentials?: { username?: string; database?: string; secretRef?: string };
  hostInternal?: string; // source-side internal hostname (what dependent apps' DATABASE_URL points at)
  externalPort?: number;
  volumes?: ForeignVolume[];
  backupSchedule?: { s3?: boolean; interval?: string };
  /** Hard limits in Tugra units (Tugra Database has memoryMb/cpus only — no reservation column). */
  limits?: Pick<ForeignLimits, "memoryMb" | "cpus">;
  serviceRef?: string;
  serverRef?: string;
  /** See {@link ForeignApp.projectRef}. */
  projectRef?: string;
  environmentRef?: string;
}

/** An environment of a {@link ForeignProject} (Dokploy "production"/"staging"). */
export interface ForeignEnvironment {
  ref: string; // the source environment id — namespaced by its project, resolved via {@link ForeignProject.environments}
  name: string;
  isDefault: boolean;
}

/** A source project (Dokploy) — the grouping Tugra mirrors as a Project + its Environments. SECRET-FREE:
 *  names/description/tags only (the project/environment env blobs are carried as keys in `sharedEnv`). */
export interface ForeignProject {
  ref: string; // the source project id
  name: string;
  description?: string;
  tags: string[];
  environments: ForeignEnvironment[];
}

/** A multi-container stack (Coolify "service", a compose project): a group of member apps/dbs with their own
 *  compose file and per-member domains. */
export interface ForeignService {
  sourceRef: string;
  name: string;
  templateSlug?: string;
  composeFile?: string;
  memberApps: string[]; // app sourceRefs
  memberDbs: string[]; // db sourceRefs
  serverRef?: string;
}

export interface ForeignFleet {
  servers: Array<{ ref: string; name?: string; ip?: string }>;
  apps: ForeignApp[];
  databases: ForeignDb[];
  services: ForeignService[];
  volumes: ForeignVolume[]; // standalone volumes not owned by one app/db
  sharedEnv: ForeignEnv[]; // team/project/environment-scoped shared variables to resolve references against
  /** Connected git providers (secret-free identity). Optional — sources without git-provider discovery omit it. */
  gitProviders?: ForeignGitProvider[];
  /** The source's project → environment tree (Dokploy). Optional — sources with no such tree (Coolify,
   *  local-docker) omit it and every resource lands in the single `input.environmentId`. */
  projects?: ForeignProject[];
  warnings: string[];
}

// ── Plan (dry-run output) ──────────────────────────────────────────────────────────────────────────────

export type ImportRisk = { level: "info" | "warn" | "blocker"; code: string; message: string };

export interface ImportPlanItem {
  itemRef: string; // namespaced "kind:serverRef:sourceRef" — the idempotency key for the executor
  kind: "app" | "database" | "volume";
  name: string;
  proposed: Record<string, unknown>; // preview of the Tugra resource (secret-free; for the review UI)
  risks: ImportRisk[];
  dependsOn: string[]; // itemRefs that must complete first (derived from links + volume ownership)
}

export type ImportMode = "copy" | "takeover";
export type CoexistenceStrategy = "two-box" | "side-by-side" | "swap-proxy";

export interface ImportOptions {
  sourceKind: string;
  targetServerId?: string; // default target; serverMap overrides per source server. Unset for a remote-source
  // dry-run plan, where the target is only chosen at apply time.
  serverMap?: Record<string, string>; // foreign serverRef → Tugra serverId/clusterId
  targetClusterId?: string;
  environmentId?: string;
  coexistence?: CoexistenceStrategy;
  cutover?: { ttlSeconds?: number; certType?: "le-http" | "le-dns" };
  /** "copy" leaves the source untouched (default). "takeover" permits a later, name-confirmed decommission
   *  of the source AFTER cutover+verification — never automatic (see the spec's takeover gate). */
  mode?: ImportMode;
  decommissionConfirmName?: string; // required to arm takeover's decommission step
}

export interface ImportPlan {
  sourceKind: string;
  mode: ImportMode;
  items: ImportPlanItem[];
  totals: { apps: number; databases: number; volumes: number; blockers: number };
  /** Source-level notices that are NOT per-item (e.g. "N compose-managed containers skipped"). Carried
   *  through from the discovered fleet so the review UI can show what the plan does NOT cover. */
  warnings: string[];
  /** Deterministic hash of (items + options) — the executor requires it (confirmToken forge/stale guard).
   *  Advisory `warnings` are deliberately NOT hashed: they must not change the executor's idempotency key. */
  planHash: string;
  /** Advisory review aid: how each resource will (or will not) migrate. NOT part of planHash and NOT consumed
   *  by the executor — it exists so the preflight UI can be honest about data movement and dropped services. */
  preflight?: ImportPreflight;
}

/** How a database's DATA will move (distinct from whether its CONFIG imports). */
export type DbDataPlane = "one-click" | "manual" | "blocked";

/** How an app volume's DATA will move.
 *  - hub-staged: the migrator copies it through hub staging (up to the per-volume cap).
 *  - manual-large: measured over the cap → copy it by hand (tar + rsync/scp); never ride hub staging.
 *  - manual: the mount is not declared on the target (compose-managed / file / invalid / duplicate / over-limit).
 *  - unknown-size: eligible, but its size was not measured (copied up to the cap at migrate time). */
export type VolumeDataPlane = "hub-staged" | "manual-large" | "manual" | "unknown-size";

/**
 * Secret-free, advisory summary attached to a plan so the review screen can show, up front, what actually
 * moves: per-database data-movement class, the services the plan does NOT import, and the volume-data caveat.
 */
export interface ImportPreflight {
  databases: Array<{ name: string; engine: string; dataPlane: DbDataPlane; reason: string }>;
  /** Services (compose / one-click stacks) are discovered but NOT imported yet — surfaced here so they are
   *  never a silent drop on the review screen. */
  services: Array<{ name: string; members: number; note: string }>;
  /** Number of apps that declare a volume whose DATA must be copied (config-only was the old behavior). */
  appsWithVolumeData: number;
  volumeDataNote?: string;
  /** Per declared/skipped app volume: how its DATA will move. Additive; NOT part of planHash. A size is only
   *  known when an inventory was supplied (the Go `--inventory` producer is deferred), so at plan time an
   *  eligible mount is `hub-staged` and size-unmeasured, never silently assumed small. */
  volumes?: Array<{ app: string; mountPath: string; type?: "named" | "bind"; dataPlane: VolumeDataPlane; reason: string }>;
}
