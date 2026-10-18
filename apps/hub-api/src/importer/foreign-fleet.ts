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

export interface ForeignApp {
  sourceRef: string;
  name: string;
  kind: "git" | "image" | "compose" | "service"; // "service" = a multi-container stack (see ForeignService)
  serviceRef?: string; // the ForeignService this app is a member of
  buildPack: ForeignBuildPack;
  image?: string;
  imageOrigin?: ImageOrigin;
  registry?: { host: string; secretRef?: string }; // private registry the image is pulled from
  git?: { url: string; branch?: string; dockerfilePath?: string; dockerfileContent?: string; baseDirectory?: string };
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
  restart?: string;
  healthcheck?: { type?: "http" | "cmd" | "none"; path?: string; port?: number; command?: string };
  cron?: Array<{ name: string; schedule: string; command: string }>;
  templateSlug?: string; // when it maps to a Tugra app-store template (Coolify service overlap)
  serverRef?: string;
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
  serviceRef?: string;
  serverRef?: string;
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
}
