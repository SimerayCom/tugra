import { why } from "../reason";
import { ns } from "../import-planner";
import { isSensitiveVisible } from "./coolify-sensitive";
import { coolifyHealth, coolifyRestartCount } from "./coolify-health";
import { isDegradedHealth } from "../import-source";
import { validContainerPrefix } from "../container-prefix";
import { inlineDockerfileProblem } from "../../applications/dto";
import type {
  ForeignApp,
  ForeignDb,
  ForeignDomain,
  ForeignEnv,
  ForeignFleet,
  ForeignLink,
  ForeignService,
  ForeignServiceMember,
  ForeignVolume,
  TugraDbEngine,
} from "../foreign-fleet";

/**
 * Pure mappers: Coolify v4 REST JSON → the neutral {@link ForeignFleet}. SECRET-FREE — discover runs on a
 * plain read token, where Coolify strips passwords, env VALUES, internal_db_url and dockerfile. Since 4.7 the build
 * and run commands, deploy hooks, custom Docker options, labels and compose text are `read:sensitive`-gated too (and
 * that ability only counts for a token created by a team admin or owner); older versions (4.1.2 to 4.6) return them to
 * any read token. A gated field is absent from the row, never null: {@link isSensitiveVisible} tells the two apart so
 * the plan can say what is not carried. We carry only non-secret identity: names, usernames, database names, env KEYS,
 * domains, ports, build config, and `secretRef` (the Coolify uuid) for a later sensitive-scoped fetch. Field names are
 * taken from the Coolify v4 models/controllers (4.1.2 to 4.7.5).
 */

// ── Raw Coolify shapes (only the fields we read; sensitive ones are usually absent on a read token) ──
export interface CoolifyServer {
  uuid: string;
  name?: string | null;
  ip?: string | null;
  /** The box Coolify itself runs on (API name `localhost`). */
  is_coolify_host?: boolean | null;
  /** Consecutive failed reachability checks (a flapping host has a high count). */
  unreachable_count?: number | null;
  /** Specs Coolify collected; only its OS text is read, and only when it is there. */
  server_metadata?: { os?: unknown; os_release?: unknown; os_version?: unknown } | null;
  /** The Coolify team the server belongs to (the agent read names it; the REST API does not). */
  team?: { id?: unknown; name?: unknown } | null;
}

/** The OS text of a Coolify server row: a short printable string, or undefined (never a guess). */
export function coolifyServerOs(s: Pick<CoolifyServer, "server_metadata">): string | undefined {
  const m = s.server_metadata;
  if (!m || typeof m !== "object") return undefined;
  const parts = [m.os, m.os_release, m.os_version].filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  const text = [...new Set(parts)].join(" ").replace(/[^\x20-\x7e]/g, "").slice(0, 80).trim();
  return text || undefined;
}

/**
 * `GET /servers` lists only a few columns of a server (name, address, reachability flags): the unreachable counter and the specs
 * (OS) are on the single-server read. The detail's value wins for those facts; anything it does not carry stays as the list had it.
 */
export function withServerDetail(listed: CoolifyServer, detail: CoolifyServer | null | undefined): CoolifyServer {
  if (!detail || typeof detail !== "object") return listed;
  return {
    ...listed,
    ...(detail.is_coolify_host !== undefined && detail.is_coolify_host !== null ? { is_coolify_host: detail.is_coolify_host } : {}),
    ...(detail.unreachable_count !== undefined && detail.unreachable_count !== null ? { unreachable_count: detail.unreachable_count } : {}),
    ...(detail.server_metadata ? { server_metadata: detail.server_metadata } : {}),
    ...(detail.team ? { team: detail.team } : {}),
  };
}

/** A discovered server with the facts PREFLIGHT classifies it by; a fact the API did not report is left out. */
function foreignServerOf(s: CoolifyServer): ForeignFleet["servers"][number] {
  const os = coolifyServerOs(s);
  const teamId = s.team && (typeof s.team.id === "string" || typeof s.team.id === "number") ? String(s.team.id) : "";
  const team = teamId && typeof s.team?.name === "string" && s.team.name ? { ref: teamId, name: s.team.name.slice(0, 120) } : undefined;
  return {
    ref: s.uuid,
    name: s.name ?? undefined,
    ip: s.ip ?? undefined,
    ...(s.is_coolify_host === true ? { controlPlane: true } : {}),
    ...(typeof s.unreachable_count === "number" && Number.isFinite(s.unreachable_count) && s.unreachable_count >= 0 ? { unreachableCount: Math.floor(s.unreachable_count) } : {}),
    ...(os ? { os } : {}),
    ...(team ? { team } : {}),
  };
}
export interface CoolifyApp {
  uuid: string;
  name?: string | null;
  build_pack?: string | null; // nixpacks | railpack | static | dockerfile | dockercompose | dockerimage
  git_repository?: string | null; // may be the placeholder "coollabsio/coolify" for image/inline-dockerfile apps
  git_branch?: string | null;
  docker_registry_image_name?: string | null;
  docker_registry_image_tag?: string | null;
  dockerfile_location?: string | null;
  base_directory?: string | null;
  publish_directory?: string | null;
  ports_exposes?: string | null; // "3000,8080"
  ports_mappings?: string | null; // "8080:80,9000:9000"
  // Commands: read:sensitive-gated from 4.7 (absent from the row, see isSensitiveVisible); any read token on 4.1.2 to 4.6.
  install_command?: string | null;
  build_command?: string | null;
  start_command?: string | null;
  fqdn?: string | null; // "https://a.com,http://b.com:3000"
  docker_compose_raw?: string | null; // read:sensitive-gated (an old inventory's service rows carried it for any read token)
  // ── Presence-only / apply-time reads. Names + encodings are HAND-BUILT from Coolify v4 sources, UNVERIFIED until
  // the live check (spec G3-C section 11); a wrong name only loses a coverage note, never produces wrong data.
  /** Extra docker network aliases: a comma/space separated string (or a list). Config only. */
  custom_network_aliases?: string | string[] | null;
  custom_labels?: string | null; // container labels, one `key=value` per line (believed base64 over the API); read:sensitive-gated
  dockerfile?: string | null; // inline Dockerfile text (alias `dockerfile_raw`); read:sensitive-gated
  dockerfile_raw?: string | null;
  dockerfile_target_build?: string | null;
  custom_docker_run_options?: string | null;
  pre_deployment_command?: string | null;
  post_deployment_command?: string | null;
  limits_memory?: string | number | null;
  limits_cpus?: string | number | null;
  health_check_enabled?: boolean | null;
  is_http_basic_auth_enabled?: boolean | null;
  /** Repo-relative glob patterns that gate a push deploy, one per line (a comma list is tolerated). Config, not a secret. */
  watch_paths?: string | null;
  /** A static site: the build output (`publish_directory`) is served by a web server instead of a start command. Top-level on
   *  4.1.2 to 4.6; from 4.7 only `settings.is_static` (see {@link appStaticFlags}). */
  is_static?: boolean | null;
  /** Static sites only: serve `index.html` for unknown paths. */
  is_spa?: boolean | null;
  /** Which host variant the proxy redirects to the other: `www`, `non-www` or `both` (no redirect, both are served). */
  redirect?: string | null;
  /** The git source's model: `GithubApp` | `GitlabApp` | `GiteaApp` (4.7); absent on older versions and for deploy-key / public repos. */
  source_type?: string | null;
  /** Compose apps keep their domains here (`fqdn` is empty): a JSON string `{"<service>":{"domain":"https://a,https://b"}}` (an object or a
   *  list of `{name, domain}` is tolerated). Config, not a secret. */
  docker_compose_domains?: string | Record<string, unknown> | Array<unknown> | null;
  /** Nested `application_settings` of `GET /applications/{uuid}` (4.7: `is_static` / `is_spa` / `custom_container_name_prefix` are NOT top-level columns). */
  settings?: { is_static?: boolean | null; is_spa?: boolean | null; custom_container_name_prefix?: string | null } | null;
  /** Top-level only on a response that flattens the settings; read through {@link appContainerPrefix}. */
  custom_container_name_prefix?: string | null;
  /** The list row's runtime state (`running:healthy`, `exited:unhealthy`, ...) and the container restart counter (see coolify-health). */
  status?: string | null;
  restart_count?: number | string | null;
  /** Agent read only: free-form text columns that HOLD text whose content was withheld (see {@link rowHas}). */
  presence?: Record<string, boolean> | null;
}
export interface CoolifyDatabase {
  uuid: string;
  name?: string | null;
  database_type?: string | null; // "standalone-postgresql" … (ABSENT for keydb — Coolify bug)
  image?: string | null; // "postgres:17-alpine"
  is_public?: boolean;
  public_port?: number | null;
  postgres_user?: string | null;
  postgres_db?: string | null;
  mysql_user?: string | null;
  mysql_database?: string | null;
  mariadb_user?: string | null;
  mariadb_database?: string | null;
  mongo_initdb_root_username?: string | null;
  mongo_initdb_database?: string | null;
  clickhouse_admin_user?: string | null;
  clickhouse_db?: string | null;
  /** The source's TLS switch and the `sslmode` it tells clients to use (PostgreSQL). Both are config, not secrets. */
  enable_ssl?: boolean | null;
  ssl_mode?: string | null;
  /** A custom engine config file (one field per engine, `read:sensitive`-gated). Presence-only: the text is never read into the fleet. */
  redis_conf?: string | null;
  keydb_conf?: string | null;
  postgres_conf?: string | null;
  mysql_conf?: string | null;
  mariadb_conf?: string | null;
  mongo_conf?: string | null;
  /** Agent read only: columns that hold text whose content was withheld (see {@link rowHas}). */
  presence?: Record<string, boolean> | null;
}
export interface CoolifyService {
  uuid: string;
  name?: string | null;
  /** The Coolify environment the service lives in (resolved against the project tree). */
  environment_id?: number | string | null;
  service_type?: string | null; // one-click template key
  /** The raw compose: on a 4.1.2 inventory every list row carries it; from 4.7 it is `read:sensitive`-gated and absent otherwise.
   *  The rendered `docker_compose` is NEVER used (rendered `<uuid>_*` volume names, `coolify.*` labels). */
  docker_compose_raw?: string | null;
  // Members: older list rows eager-load them; from 4.7 only `GET /services/{uuid}` does (the list rows carry no `applications` /
  // `databases`). `image` on a member is the compose image, not the running one. A member the compose file no longer declares
  // stays in the table with `is_removed_from_compose: true`: it is not part of the service and is skipped.
  applications?: Array<{ uuid: string; name?: string | null; fqdn?: string | null; image?: string | null; is_removed_from_compose?: boolean | null }>;
  databases?: Array<{ uuid: string; name?: string | null; image?: string | null; is_removed_from_compose?: boolean | null }>;
  /** Only on rows that load the destination (the detail read, and only for a read:sensitive token); older list rows carried it. */
  server?: { uuid?: string | null; name?: string | null } | null;
  destination?: { server?: { uuid?: string | null; name?: string | null } | null } | null;
}
export interface CoolifyEnv {
  key: string;
  is_buildtime?: boolean;
  is_runtime?: boolean;
  is_literal?: boolean;
  is_multiline?: boolean;
  is_shared?: boolean;
  is_coolify?: boolean; // SERVICE_* magic var
  is_preview?: boolean; // preview-deployment twin — the /envs list merges these in; must be filtered out
  value?: string; // read:sensitive-gated — present only when resolving secrets (fetchSecrets), never in discover
  real_value?: string; // read:sensitive-gated — value with shared/magic {{refs}} resolved
}
export interface CoolifyVolume {
  name?: string | null;
  mount_path?: string | null;
  host_path?: string | null; // non-null = bind mount; null = named volume
}

/** One row of `GET /databases/{uuid}/backups` (a scheduled database backup). Only these fields are read: never an S3 key or secret. */
export interface CoolifyBackup {
  enabled?: boolean | null;
  save_s3?: boolean | null;
  frequency?: string | null;
  s3_storage_id?: number | string | null;
  s3_storage_uuid?: string | null;
  s3?: { name?: string | null } | null;
}
/** One row of `GET /s3-storages`, reduced to what names a backup's target. The row's key and secret are never read. */
export interface CoolifyS3Storage {
  id?: number | string | null;
  uuid?: string | null;
  name?: string | null;
}

export interface CoolifyFleetInput {
  servers: CoolifyServer[];
  /** serverUuid → the resource uuids running on it (from GET /servers/{uuid}/resources). */
  resourcesByServer: Record<string, string[]>;
  apps: CoolifyApp[];
  databases: CoolifyDatabase[];
  services: CoolifyService[];
  envsByResource: Record<string, CoolifyEnv[]>;
  /** appUuid → the key-name/reason-code env report computed by the adapter (absent when the env read failed). */
  envReportByResource?: Record<string, NonNullable<ForeignApp["envReport"]>>;
  volumesByResource: Record<string, CoolifyVolume[]>;
  /** databaseUuid → its scheduled backups (absent = not read). */
  backupsByResource?: Record<string, CoolifyBackup[]>;
  /** The team's S3 storages (names only), to name a backup's target. */
  s3Storages?: CoolifyS3Storage[];
  /** Non-fatal fetch warnings accumulated by the adapter (a partial 403/404 during enumeration). */
  warnings?: string[];
  /** resourceUuid → the source project/environment it lives in (the project tree). Lets an app whose variables cannot be read be linked
   *  to the databases and services of its own environment. Absent = no tree. */
  locByUuid?: ReadonlyMap<string, { projectRef: string; environmentRef: string }>;
}

const DB_ENGINE: Record<string, TugraDbEngine | "UNKNOWN"> = {
  "standalone-postgresql": "POSTGRES",
  "standalone-mysql": "MYSQL",
  "standalone-mariadb": "MARIADB",
  "standalone-mongodb": "MONGO",
  "standalone-redis": "REDIS",
  "standalone-keydb": "KEYDB",
  "standalone-dragonfly": "DRAGONFLY",
  "standalone-clickhouse": "CLICKHOUSE",
  "standalone-sqlite": "UNKNOWN", // Coolify SQLite has no Tugra equivalent (LibSQL ≠ plain SQLite)
};

/** Decide the Tugra engine. Prefers `database_type`; falls back to the image name — Coolify omits
 *  `database_type` for KeyDB (a real v4 bug), and dragonfly/keydb are otherwise indistinguishable. */
export function coolifyEngine(db: CoolifyDatabase): TugraDbEngine | "UNKNOWN" {
  const t = db.database_type ?? undefined;
  if (t && t in DB_ENGINE) return DB_ENGINE[t];
  const image = (db.image ?? "").toLowerCase();
  if (/keydb/.test(image)) return "KEYDB";
  if (/dragonfly/.test(image)) return "DRAGONFLY";
  if (/clickhouse/.test(image)) return "CLICKHOUSE";
  if (/mariadb/.test(image)) return "MARIADB";
  if (/postgres/.test(image)) return "POSTGRES";
  if (/mysql/.test(image)) return "MYSQL";
  if (/mongo/.test(image)) return "MONGO";
  if (/redis|valkey/.test(image)) return "REDIS"; // Valkey speaks the Redis protocol; Coolify 4.7 gives it `standalone-redis` too
  return "UNKNOWN";
}

/** The Coolify field holding each engine's custom config file (the engines Tugra can mount one for). */
const CONF_FIELD = {
  REDIS: "redis_conf",
  KEYDB: "keydb_conf",
  POSTGRES: "postgres_conf",
  MYSQL: "mysql_conf",
  MARIADB: "mariadb_conf",
  MONGO: "mongo_conf",
} as const satisfies Partial<Record<TugraDbEngine, keyof CoolifyDatabase>>;

/** The custom config file text of a Coolify database row for an engine; undefined when the engine takes none, or the field is absent or blank. */
export function coolifyConfText(db: CoolifyDatabase, engine: TugraDbEngine | "UNKNOWN"): string | undefined {
  const field = (CONF_FIELD as Partial<Record<string, keyof CoolifyDatabase>>)[engine];
  const v = field ? db[field] : undefined;
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Whether a database image is Valkey (the Redis fork Coolify 4.7 defaults new `standalone-redis` databases to): `valkey/valkey:9-alpine`, a mirror's `valkey`. */
export function isValkeyImage(image: string | null | undefined): boolean {
  if (!image) return false;
  const base = (image.split("@")[0].split("/").pop() ?? "").split(":")[0].toLowerCase();
  return base === "valkey" || base.startsWith("valkey-");
}

/** Coolify sets this fake repo (branch "main") on dockerimage + inline-dockerfile apps that have no real git. */
const PLACEHOLDER_REPO = "coollabsio/coolify";

/**
 * Coolify stores a GitHub-App source's repo as a bare `owner/repo`, which is NOT a cloneable URL — it fails
 * Tugra's gitUrl validation and the clone step (the importer calls ApplicationsService.create directly, so
 * the Zod regex never runs). Normalize that shorthand to a full https GitHub URL. Values that already look
 * like a URL/scp form (https/ssh/git@) pass through unchanged; an unrecognized form is left as-is (the
 * planner surfaces it as needs-manual rather than silently rewriting an unknown provider).
 */
export function normalizeGitUrl(repo: string, sourceType?: string | null): string {
  const r = repo.trim();
  if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(r)) return r; // already a clone URL / scp-like form
  // A bare owner/repo of a GitLab / Gitea App has no host the list row names (it lives on the source's own instance): never guessed as GitHub.
  if (coolifyGitProvider(sourceType) === "gitlab" || coolifyGitProvider(sourceType) === "gitea") return r;
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r.replace(/\.git$/i, "")}.git`; // owner/repo (GitHub App)
  return r;
}

/** The git provider a Coolify `source_type` names (`GithubApp` | `GitlabApp` | `GiteaApp`), or undefined when absent or unknown (older versions). */
export function coolifyGitProvider(sourceType: string | null | undefined): "github" | "gitlab" | "gitea" | undefined {
  if (typeof sourceType !== "string") return undefined;
  const t = (sourceType.trim().split("\\").pop() ?? "").toLowerCase(); // the polymorphic column may hold `App\\Models\\GithubApp`
  if (t === "githubapp") return "github";
  if (t === "gitlabapp") return "gitlab";
  if (t === "giteaapp") return "gitea";
  return undefined;
}

/** A bare `owner/repo` (not a URL) is exactly how Coolify stores a GitHub-App source — the signal that the
 *  repo is private and needs a connected GitHub App to clone. A full URL is a plain (usually public) clone. */
export function isGithubAppRepo(repo: string): boolean {
  const r = repo.trim();
  if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(r)) return false;
  return /^[\w.-]+\/[\w.-]+$/.test(r);
}

/** Whether the app actually builds from a real git repository (filters out Coolify's dockerimage placeholder). */
export function hasRealGit(app: CoolifyApp): boolean {
  const r = app.git_repository;
  if (!r) return false;
  if (r === PLACEHOLDER_REPO && (app.git_branch === "main" || !app.git_branch)) return false;
  return true;
}

/** The build packs whose `is_static` / `is_spa` flags change the Tugra mapping: those flags live in `application_settings`. */
export function coolifyNeedsSettings(app: Pick<CoolifyApp, "build_pack">): boolean {
  return app.build_pack === "nixpacks" || app.build_pack === "railpack" || app.build_pack === "static";
}

/** `is_static` / `is_spa` of an app: from 4.7 only the nested `settings` of the detail read carries them, older versions put them on the row. */
export function appStaticFlags(app: Pick<CoolifyApp, "is_static" | "is_spa" | "settings">): { isStatic?: boolean; isSpa?: boolean } {
  const pick = (nested: unknown, top: unknown): boolean | undefined => (typeof nested === "boolean" ? nested : typeof top === "boolean" ? top : undefined);
  const isStatic = pick(app.settings?.is_static, app.is_static);
  const isSpa = pick(app.settings?.is_spa, app.is_spa);
  return { ...(isStatic !== undefined ? { isStatic } : {}), ...(isSpa !== undefined ? { isSpa } : {}) };
}

/**
 * The custom container name prefix of an app: from 4.7 only the nested `settings` of the detail read carries it. Coolify names the
 * container `<prefix>-<deploy timestamp>` then (`generateApplicationContainerName`). Absent when unset, equal to the uuid (no
 * difference), or not a shell-safe name (dropped: the app is then matched by its uuid and the freeze says what it could not find).
 */
export function appContainerPrefix(app: Pick<CoolifyApp, "uuid" | "settings" | "custom_container_name_prefix">): string | undefined {
  const raw = app.settings?.custom_container_name_prefix ?? app.custom_container_name_prefix;
  const v = typeof raw === "string" ? raw.trim() : "";
  return validContainerPrefix(v) && v !== app.uuid ? v : undefined;
}

/** Whether the row already says what its prefix is (nested or flat, even null): no detail read is needed for it. */
export function containerPrefixKnown(app: Pick<CoolifyApp, "settings" | "custom_container_name_prefix" | "is_static" | "is_spa">): boolean {
  if (app.settings && typeof app.settings === "object" && "custom_container_name_prefix" in app.settings) return true;
  if ("custom_container_name_prefix" in app) return true;
  // 4.1.2 .. 4.6 rows carry `is_static` / `is_spa` as top-level columns and predate the setting: nothing to read.
  return typeof app.is_static === "boolean" || typeof app.is_spa === "boolean";
}

/** Coolify build pack → Tugra source kind + build pack. A docker-image app (build_pack 'dockerimage', or a
 *  registry image with no real git repo) wins first — Coolify stores a placeholder repo for those. */
export function mapCoolifyBuildPack(app: CoolifyApp): { kind: ForeignApp["kind"]; buildPack: ForeignApp["buildPack"] } {
  if (app.build_pack === "dockerimage" || (!hasRealGit(app) && app.docker_registry_image_name)) {
    return { kind: "image", buildPack: "image" };
  }
  // A nixpacks/railpack app Coolify marks `is_static` builds a site and serves its publish directory with a web server: that is
  // Tugra's STATIC build (build command + output directory), not a started process.
  if (appStaticFlags(app).isStatic === true && (app.build_pack === "nixpacks" || app.build_pack === "railpack") && hasRealGit(app)) return { kind: "git", buildPack: "static" };
  switch (app.build_pack) {
    case "dockercompose":
      return { kind: "compose", buildPack: "dockercompose" };
    case "dockerfile":
      return { kind: "git", buildPack: "dockerfile" };
    case "static":
      return { kind: "git", buildPack: "static" };
    case "railpack":
      return { kind: "git", buildPack: "railpack" };
    case "nixpacks":
      return { kind: "git", buildPack: "nixpacks" };
    default:
      return { kind: "git", buildPack: "unknown" };
  }
}

/** Parse Coolify's comma-separated `fqdn` (full URLs with scheme) into neutral domains; first is primary. */
export function parseFqdns(fqdn: string | null | undefined): ForeignDomain[] {
  if (!fqdn) return [];
  // Coolify frequently lists the SAME host twice — an http and an https entry (e.g.
  // "https://x.com,http://x.com") — which must not be counted as two domains. Collapse by host+port+path
  // (https wins when a host appears both ways); the first DISTINCT domain is the primary.
  const byKey = new Map<string, ForeignDomain>();
  for (const part of fqdn.split(",").map((s) => s.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(part) ? part : `https://${part}`);
    } catch {
      continue;
    }
    const port = u.port ? Number(u.port) : undefined;
    const path = u.pathname && u.pathname !== "/" ? u.pathname : undefined;
    const key = `${u.hostname}|${port ?? ""}|${path ?? ""}`;
    const existing = byKey.get(key);
    if (existing) {
      if (u.protocol === "https:") existing.https = true;
    } else {
      byKey.set(key, { host: u.hostname, https: u.protocol === "https:", port, path, primary: false });
    }
  }
  const out = [...byKey.values()];
  if (out.length) out[0].primary = true;
  return out;
}

/**
 * Pure: a compose app's `docker_compose_domains` (a JSON string `{"<service>":{"domain":"https://a,https://b"}}`; an already
 * parsed object, or the API's list form `[{name, domain}]`, is tolerated) → per-service domains. Each domain carries its
 * compose service as `serviceRef`; none is primary (a compose app has no single web service: the apply step binds each one to
 * its service). Same http/https collapsing as {@link parseFqdns}, scoped per service. Unparsable input yields no domains.
 */
export function parseComposeDomains(raw: unknown): ForeignDomain[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return [];
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const entries: Array<[string, unknown]> = [];
  if (Array.isArray(value)) {
    for (const row of value) {
      const name = (row as { name?: unknown } | null)?.name;
      if (typeof name === "string") entries.push([name, row]);
    }
  } else if (value && typeof value === "object") {
    for (const [name, row] of Object.entries(value as Record<string, unknown>)) entries.push([name, row]);
  }
  const out: ForeignDomain[] = [];
  for (const [service, row] of entries) {
    const domain = typeof row === "string" ? row : (row as { domain?: unknown } | null)?.domain;
    if (typeof domain !== "string") continue;
    for (const d of parseFqdns(domain)) out.push({ ...d, serviceRef: service, primary: false });
  }
  return out;
}

/** Parse "3000,8080" → [3000, 8080] (positive integers only). */
export function parsePorts(s: string | null | undefined): number[] {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
}

/** The repository names whose tag IS the PostgreSQL version (`postgres:17-alpine`, `bitnami/postgresql:16.2.0`, `postgis/postgis:16-3.4`). */
const STOCK_POSTGRES_REPOS = new Set(["postgres", "postgresql", "postgis"]);

/**
 * The version of an image TAG: "postgres:17-alpine" → "17". Robust against a registry host:port ("registry:5000/postgres:16" →
 * "16") and digest-pinned images ("repo@sha256:…" → undefined).
 *
 * For PostgreSQL the number that matters is the server major, and an extension image puts ITS OWN version first
 * (`pgvector/pgvector:0.8.0-pg16`, `timescale/timescaledb:2.17.2-pg16`): the `pgNN` part of the tag wins; a stock Postgres repository
 * keeps its leading number; any other Postgres image with no `pgNN` part has no readable major, so no version is claimed (the plan
 * then asks for one) instead of the extension's version being taken for it.
 */
export function versionFromImage(image: string | null | undefined, engine?: string): string | undefined {
  if (!image || image.includes("@")) return undefined; // digest-pinned → no version tag
  const lastSegment = image.split("/").pop() ?? ""; // drop registry host[:port] + path
  if (!lastSegment.includes(":")) return undefined;
  const [repo, ...rest] = lastSegment.split(":");
  const tag = rest.pop();
  if (engine === "POSTGRES") {
    const major = tag?.match(/(?:^|[^a-z0-9])pg(\d{1,2})(?!\d)/i)?.[1];
    if (major) return major;
    if (!STOCK_POSTGRES_REPOS.has(repo.toLowerCase())) return undefined;
  }
  return tag?.match(/\d+(\.\d+)*/)?.[0];
}

/** Largest label block we will decode (a Coolify block is a few KiB at most; refuse pathological input). */
const MAX_LABEL_BLOCK_BYTES = 64 * 1024;

/** Strictly base64-shaped (alphabet + padding, length multiple of 4) — never matches plain `a.b=c` text. */
function strictBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

/** Decode base64 to UTF-8, or undefined when the bytes are not valid UTF-8. */
function decodeBase64Utf8(s: string): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(s, "base64"));
  } catch {
    return undefined;
  }
}

/**
 * Pure: Coolify's `custom_labels` (base64 over the API; plain text tolerated) → ordered key/value pairs. Returns
 * `"unparsable"` when the block had content but not one `key=value` line. A line is trimmed, may carry a leading
 * `- ` and surrounding quotes, and is split at the FIRST `=`. Values never leave this function except as data.
 */
export function decodeCoolifyLabels(raw: unknown): Array<{ key: string; value: string }> | "unparsable" {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (Buffer.byteLength(raw, "utf8") > MAX_LABEL_BLOCK_BYTES) return "unparsable";
  let text = raw;
  if (strictBase64(trimmed)) {
    const decoded = decodeBase64Utf8(trimmed);
    if (decoded !== undefined && decoded.includes("=")) text = decoded;
  }
  const out: Array<{ key: string; value: string }> = [];
  let nonBlank = 0;
  for (const rawLine of text.split("\n")) {
    let line = rawLine.replace(/\r$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    nonBlank++;
    if (line.startsWith("- ")) line = line.slice(2).trim();
    const q = line[0];
    if ((q === '"' || q === "'") && line.length >= 2 && line.endsWith(q)) line = line.slice(1, -1);
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // no `=` (or an empty key) → skipped
    out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1) });
  }
  return out.length === 0 && nonBlank > 0 ? "unparsable" : out;
}

/**
 * Pure: Coolify's inline Dockerfile text (`dockerfile`, alias `dockerfile_raw`). Plain text wins when it is already
 * a valid Dockerfile; otherwise a base64-shaped value is decoded (and used only if the DECODED text is valid);
 * anything else is returned raw so the apply-time validator rejects it with its fixed message.
 */
export function decodeCoolifyDockerfile(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  if (inlineDockerfileProblem(raw) === null) return raw;
  const trimmed = raw.trim();
  if (strictBase64(trimmed)) {
    const decoded = decodeBase64Utf8(trimmed);
    if (decoded !== undefined && inlineDockerfileProblem(decoded) === null) return decoded;
  }
  return raw;
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
/** Does the row hold text in this column? The text itself, or (agent read: the text is withheld from the plan channel) a `presence` mark. */
const rowHas = (row: { presence?: Record<string, boolean> | null }, col: string): boolean => nonEmpty((row as Record<string, unknown>)[col]) || row.presence?.[col] === true;
/** Coolify "0" / "" / null / 0 all mean "no limit". */
const nonZero = (v: unknown): boolean => (typeof v === "number" ? v > 0 : typeof v === "string" && v.trim() !== "" && v.trim() !== "0");

/**
 * Pure: Coolify's `watch_paths` (one glob per line; a comma list is tolerated, commas inside `{a,b}` braces are part of the glob)
 * to Tugra's repo-relative patterns: trimmed, a leading `/` dropped (also after a `!`), empty lines and repeats removed. The list
 * is not truncated or validated here: the apply step checks the whole set against Tugra's own schema and reports it when it fails.
 */
export function parseWatchPaths(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const out: string[] = [];
  for (const line of raw.split(/[\r\n]+/)) {
    let depth = 0;
    let cur = "";
    const parts: string[] = [];
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}" && depth > 0) depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    for (const part of parts) {
      const t = part.trim();
      const neg = t.startsWith("!");
      const body = (neg ? t.slice(1) : t).trim().replace(/^\/+/, "");
      if (!body) continue;
      const pattern = neg ? `!${body}` : body;
      if (!out.includes(pattern)) out.push(pattern);
    }
  }
  return out;
}

/** Fixed-reason coverage rows for what is PRESENT on a Coolify app but has no Tugra carry path. Presence only. */
function coolifyNotCarried(app: CoolifyApp, realGit: boolean, kind: ForeignApp["kind"]): NonNullable<ForeignApp["notCarried"]> {
  const out: NonNullable<ForeignApp["notCarried"]> = [];
  if (app.is_http_basic_auth_enabled === true) out.push({ field: "basicAuth", level: "warn", ...why("coolify_basic_auth") });
  if (nonEmpty(app.ports_mappings)) out.push({ field: "publishedPorts", level: "warn", ...why("coolify_published_ports") });
  if (rowHas(app, "custom_docker_run_options")) out.push({ field: "dockerOptions", level: "warn", ...why("coolify_docker_options") });
  if (rowHas(app, "pre_deployment_command") || rowHas(app, "post_deployment_command")) out.push({ field: "deployHooks", level: "info", ...why("coolify_deploy_hooks") });
  if (nonZero(app.limits_memory) || nonZero(app.limits_cpus)) out.push({ field: "limits", level: "info", ...why("coolify_limits") });
  if (app.health_check_enabled === true) out.push({ field: "healthcheck", level: "info", ...why("coolify_healthcheck") });
  if (nonEmpty(app.dockerfile_target_build)) out.push({ field: "dockerBuildTarget", level: "info", ...why("coolify_build_target") });
  // watch_paths are carried (ForeignApp.watchPaths), and so is the www / non-www redirect (ForeignApp.domainRedirect).
  // The planner's `app.git.missing` blocker case: a Dockerfile app with no real repo (and no image to fall back to).
  if (app.build_pack === "dockerfile" && !realGit && kind !== "image") {
    out.push({ field: "inlineDockerfile", level: "warn", ...why("coolify_inline_dockerfile") });
  }
  return out;
}

function mapEnv(e: CoolifyEnv): ForeignEnv {
  return {
    key: e.key,
    buildTime: e.is_buildtime ?? undefined,
    runtime: e.is_runtime ?? undefined,
    literal: e.is_literal ?? undefined,
    multiline: e.is_multiline ?? undefined,
    generated: e.is_coolify ?? undefined,
    ref: e.is_shared ? { type: "shared" } : e.is_coolify ? { type: "magic" } : undefined,
    // value intentionally omitted — read:sensitive-gated; fetched at apply time via secretRef
  };
}

function mapVolume(v: CoolifyVolume, ownerRef: string): ForeignVolume {
  const hostPath = v.host_path ?? undefined;
  return {
    name: v.name ?? undefined,
    hostPath,
    mountPath: v.mount_path ?? "",
    type: hostPath ? "bind" : "named",
    ownerRef,
  };
}

/**
 * Pure: the host names of Coolify's `custom_network_aliases` (a comma / space / newline separated string, or a list): trimmed,
 * lower-cased, de-duplicated, at most 20, each a plain host name (labels of a-z 0-9 hyphen joined by dots, 253 chars at most).
 * Anything else is dropped.
 */
export function parseNetworkAliases(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== "string") continue;
    const a = p.trim().toLowerCase();
    if (a.length < 1 || a.length > 253 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(a)) continue;
    if (!out.includes(a)) out.push(a);
    if (out.length === 20) break;
  }
  return out;
}

/** A compose app keeps its domains per service in `docker_compose_domains` (`fqdn` is empty there); every other app in `fqdn`. */
function mapAppDomains(app: CoolifyApp, kind: ForeignApp["kind"]): ForeignDomain[] {
  const plain = parseFqdns(app.fqdn);
  if (kind !== "compose") return plain;
  const perService = parseComposeDomains(app.docker_compose_domains);
  if (!perService.length) return plain;
  // `fqdn` on a compose row (older instances) names no service: keep it only for hosts the service map does not already carry.
  const seen = new Set(perService.map((d) => d.host));
  return [...perService, ...plain.filter((d) => !seen.has(d.host)).map((d) => ({ ...d, primary: false }))];
}

export function mapApplication(
  app: CoolifyApp,
  ctx: { envs: CoolifyEnv[]; volumes: CoolifyVolume[]; serverRef?: string },
): ForeignApp {
  const { kind, buildPack } = mapCoolifyBuildPack(app);
  const name = app.docker_registry_image_name ?? undefined;
  const image =
    kind === "image" && name
      ? name.includes("@") // already a digest-pinned "repo@sha256:…" reference → use as-is
        ? name
        : `${name}${app.docker_registry_image_tag ? `:${app.docker_registry_image_tag}` : ""}`
      : undefined;
  const realGit = hasRealGit(app);
  // Presence-only markers (never the text): label / Dockerfile text is re-read at apply time.
  const sourceExtras: NonNullable<ForeignApp["sourceExtras"]> = {};
  if (rowHas(app, "custom_labels")) sourceExtras.labels = true;
  if (app.build_pack === "dockerfile" && (rowHas(app, "dockerfile") || nonEmpty(app.dockerfile_raw))) sourceExtras.dockerfile = true;
  const notCarried = coolifyNotCarried(app, realGit, kind);
  const watchPaths = parseWatchPaths(app.watch_paths);
  const domainRedirect = app.redirect === "www" ? "www" : app.redirect === "non-www" ? "root" : undefined;
  return {
    sourceRef: app.uuid,
    name: app.name ?? app.uuid,
    kind,
    buildPack,
    image,
    imageOrigin: kind === "image" ? "registry" : kind === "git" ? "built-from-git" : undefined,
    // Use the clean git_repository (owner/repo or clean URL), NOT git_full_url — the latter can embed
    // credentials, which would break the secret-free contract. Only set git for a real repo.
    git: realGit
      ? {
          url: normalizeGitUrl(app.git_repository!, app.source_type),
          branch: app.git_branch ?? undefined,
          dockerfilePath: app.dockerfile_location ?? undefined,
          baseDirectory: app.base_directory ?? undefined,
          // `source_type` names the git source's model (4.7); older rows do not carry it and fall back to GitHub. It decides only for a
          // bare owner/repo (the form the GitHub/GitLab/Gitea App sources store): public and deploy-key repos also point at the built-in
          // GithubApp source but keep a clone URL, which is no App install of any provider.
          provider: isGithubAppRepo(app.git_repository!) ? coolifyGitProvider(app.source_type) ?? "github" : undefined,
        }
      : undefined,
    composeFile: app.docker_compose_raw ?? undefined, // present only with a read:sensitive token
    // install/build/start are app build CONFIG required to reproduce the build — carried as-is. Coolify 4.7+ gates them behind
    // read:sensitive (absent from the row otherwise: the fleet warning names it); 4.1.2 to 4.6 show them to any read token.
    installCommand: app.install_command ?? undefined,
    buildCommand: app.build_command ?? undefined,
    startCommand: app.start_command ?? undefined,
    publishDirectory: app.publish_directory ?? undefined,
    // A static site that does not fall back to index.html: Tugra's static builds always do (reported at apply).
    ...(buildPack === "static" && appStaticFlags(app).isSpa === false ? { staticSpa: false } : {}),
    ...(watchPaths.length ? { watchPaths } : {}),
    ...(appContainerPrefix(app) ? { containerPrefix: appContainerPrefix(app) } : {}),
    ports: parsePorts(app.ports_exposes),
    domains: mapAppDomains(app, kind),
    ...(domainRedirect ? { domainRedirect } : {}),
    env: ctx.envs.map(mapEnv),
    volumes: ctx.volumes.map((v) => mapVolume(v, app.uuid)),
    internalHost: app.uuid, // Coolify's internal docker hostname is the resource uuid
    ...(parseNetworkAliases(app.custom_network_aliases).length ? { networkAliases: parseNetworkAliases(app.custom_network_aliases) } : {}),
    serverRef: ctx.serverRef,
    ...(Object.keys(sourceExtras).length ? { sourceExtras } : {}),
    ...(notCarried.length ? { notCarried } : {}),
  };
}

/**
 * Pure: the enabled scheduled backups of one database folded into a secret-free summary (count, distinct frequencies, whether any
 * uploads to S3, and the names of the S3 targets that can be resolved). Undefined when no schedule is enabled.
 */
export function mapBackupSchedule(rows: CoolifyBackup[] | undefined, s3: CoolifyS3Storage[] | undefined): ForeignDb["backupSchedule"] | undefined {
  const active = (rows ?? []).filter((b) => b && b.enabled !== false);
  if (!active.length) return undefined;
  const frequencies = [...new Set(active.map((b) => (typeof b.frequency === "string" ? b.frequency.trim() : "")).filter(Boolean))].sort();
  const toS3 = active.filter((b) => b.save_s3 === true);
  const targets = new Set<string>();
  for (const b of toS3) {
    const hit = (s3 ?? []).find((x) => (b.s3_storage_uuid && x.uuid === b.s3_storage_uuid) || (b.s3_storage_id != null && x.id != null && String(x.id) === String(b.s3_storage_id)));
    const name = hit?.name ?? b.s3?.name;
    if (typeof name === "string" && name.trim()) targets.add(name.trim().slice(0, 80));
  }
  return { schedules: active.length, ...(frequencies.length ? { interval: frequencies.join(", ") } : {}), ...(toS3.length ? { s3: true } : {}), ...(targets.size ? { targets: [...targets].sort() } : {}) };
}

export function mapDatabase(
  db: CoolifyDatabase,
  ctx: { volumes: CoolifyVolume[]; serverRef?: string; backups?: CoolifyBackup[]; s3?: CoolifyS3Storage[] },
): ForeignDb {
  const engine = coolifyEngine(db);
  const username =
    db.postgres_user ?? db.mysql_user ?? db.mariadb_user ?? db.mongo_initdb_root_username ?? db.clickhouse_admin_user ?? undefined;
  const database =
    db.postgres_db ?? db.mysql_database ?? db.mariadb_database ?? db.mongo_initdb_database ?? db.clickhouse_db ?? undefined;
  const tls = tlsExpectation(db);
  // Coolify 4.7 runs a new `standalone-redis` database on valkey/valkey (its tag, `9-alpine`, is no Redis version: a stock
  // `redis:9-alpine` does not exist). Tugra creates it as Redis, keeps the source image, and names no version.
  const valkey = engine === "REDIS" && isValkeyImage(db.image);
  const notCarried: NonNullable<ForeignDb["notCarried"]> = [];
  if (valkey) notCarried.push({ field: "engineFamily", level: "info", ...why("coolify_valkey") });
  // A custom engine config file (redis/keydb/postgres/mysql/mariadb/mongo `*_conf`) is carried (presence here; the text is read at apply
  // time, see fetchDbConfigFile): no warning.
  const confField = (CONF_FIELD as Partial<Record<string, string>>)[engine];
  const hasConfigFile = coolifyConfText(db, engine) !== undefined || (!!confField && db.presence?.[confField] === true);
  // A scheduled backup (and its S3 target) is not carried: Tugra needs the destination credentials, which the importer never reads.
  const backupSchedule = mapBackupSchedule(ctx.backups, ctx.s3);
  if (backupSchedule) {
    const frequency = backupSchedule.interval ?? "schedule not reported";
    notCarried.push({
      field: "backupSchedule",
      level: "warn",
      ...(backupSchedule.s3 ? why("coolify_backup_schedule_s3", { frequency, target: backupSchedule.targets?.join(", ") || "(name not readable)" }) : why("coolify_backup_schedule", { frequency })),
    });
  }
  return {
    sourceRef: db.uuid,
    name: db.name ?? db.uuid,
    engine,
    version: valkey ? undefined : versionFromImage(db.image, engine),
    image: db.image ?? undefined,
    credentials: { username: username ?? undefined, database: database ?? undefined, secretRef: db.uuid },
    hostInternal: db.uuid,
    externalPort: db.is_public ? db.public_port ?? undefined : undefined,
    volumes: ctx.volumes.map((v) => mapVolume(v, db.uuid)),
    serverRef: ctx.serverRef,
    ...(backupSchedule ? { backupSchedule } : {}),
    ...(tls ? { tls } : {}),
    ...(hasConfigFile ? { hasConfigFile: true } : {}),
    ...(notCarried.length ? { notCarried } : {}),
  };
}

/** `ssl_mode` values a client reads as "this server must speak TLS" (libpq's sslmode vocabulary). */
const TLS_REQUIRING_MODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * Pure: whether the source expects TLS from this PostgreSQL database, so the Tugra copy must serve it too (R22). The fleet shows
 * `ssl_mode: require` with `enable_ssl: false`: the source's own clients may carry `sslmode=require` in their URLs, and a server
 * without TLS would refuse them. `required` = TLS must be on; `verify` = the client verifies the chain (a self-signed copy cannot
 * satisfy it). Other engines and databases with no TLS expectation return undefined (the key is then absent).
 */
export function tlsExpectation(db: Pick<CoolifyDatabase, "database_type" | "image" | "enable_ssl" | "ssl_mode">): ForeignDb["tls"] | undefined {
  if (coolifyEngine(db as CoolifyDatabase) !== "POSTGRES") return undefined;
  const mode = typeof db.ssl_mode === "string" ? db.ssl_mode.trim().toLowerCase() : "";
  if (TLS_REQUIRING_MODES.has(mode)) return { enabled: db.enable_ssl === true, mode: mode as "require" | "verify-ca" | "verify-full" };
  if (db.enable_ssl === true) return { enabled: true };
  return undefined;
}

/**
 * Pure: the neutral {@link ForeignDb} of a database CONTAINER the source API does not list (R2), built from what the host inventory
 * read of it. `sourceRef` is the container name, which is what the migrator matches byte-exactly on the source host and what the
 * apps' env points at (a Coolify container is named by its uuid). The credentials carry only the NON-secret identity: the password
 * is never in the fleet, the plan or the hub (the migrator reads it from the container's own environment when it dumps).
 */
export function foreignDbOfContainer(c: { host: string; container: string; engine: TugraDbEngine; version: string; image: string; name: string; user?: string | null; database?: string | null }): ForeignDb {
  return {
    sourceRef: c.container,
    name: c.name,
    engine: c.engine,
    version: c.version,
    image: c.image,
    credentials: { username: c.user ?? undefined, database: c.database ?? undefined },
    hostInternal: c.container,
    serverRef: c.host === "_" ? undefined : c.host,
  };
}

export function mapService(svc: CoolifyService, ctx: { serverRef?: string; serverName?: string }): ForeignService {
  const server = svc.server ?? svc.destination?.server ?? undefined;
  // Members: the compose service key is the Coolify member name. Apps carry their fqdn rows (parseFqdns dedupes the
  // http/https pair and keeps the port); databases of a service are compose containers and carry none. Sorted by name
  // so the plan hash does not depend on the source's row order.
  const liveApps = (svc.applications ?? []).filter((a) => a?.is_removed_from_compose !== true);
  const liveDbs = (svc.databases ?? []).filter((d) => d?.is_removed_from_compose !== true);
  const members: ForeignServiceMember[] = [
    ...liveApps.map((a): ForeignServiceMember => ({
      name: a.name ?? a.uuid,
      kind: "app",
      ref: a.uuid,
      ...(a.image ? { image: a.image } : {}),
      domains: parseFqdns(a.fqdn).map((d) => ({ ...d, serviceRef: a.name ?? a.uuid, primary: false })),
    })),
    ...liveDbs.map((d): ForeignServiceMember => ({
      name: d.name ?? d.uuid,
      kind: "db",
      ref: d.uuid,
      ...(d.image ? { image: d.image } : {}),
      domains: [],
    })),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    sourceRef: svc.uuid,
    name: svc.name ?? svc.uuid,
    templateSlug: svc.service_type ?? undefined,
    composeFile: svc.docker_compose_raw ?? undefined,
    memberApps: liveApps.map((a) => a.uuid),
    memberDbs: liveDbs.map((d) => d.uuid),
    // The server's resource listing places the service; its own row names the server only on older versions or for a
    // read:sensitive detail read (`destination.server`).
    serverRef: ctx.serverRef ?? server?.uuid ?? undefined,
    members,
    ...(server?.name ?? ctx.serverName ? { serverName: server?.name ?? ctx.serverName } : {}),
  };
}

/** The one-line plan warning for an app that is not healthy at the source. */
export function sourceHealthWarning(name: string, h: NonNullable<ForeignApp["sourceHealth"]>): string {
  const bits = [h.status ?? h.health, ...(h.restartCount ? [`${h.restartCount} restarts`] : [])];
  return `app ${name} is not healthy at the source (${bits.join(", ")}): it migrates as it is, so check it before migrating`;
}

/** Pure: the source health of an app from its list row, or undefined when the row reports neither a status nor a restart counter. */
export function appSourceHealth(a: Pick<CoolifyApp, "status" | "restart_count">): ForeignApp["sourceHealth"] | undefined {
  const status = typeof a.status === "string" && /^[a-z]{3,20}(:[a-z]{3,20})?$/i.test(a.status.trim()) ? a.status.trim().toLowerCase() : undefined;
  const restartCount = coolifyRestartCount(a.restart_count);
  if (status === undefined && restartCount === null) return undefined;
  return { health: coolifyHealth(status), ...(status ? { status } : {}), restartCount };
}

/** A Coolify uuid is 24 characters; a shorter token is too likely to occur by chance inside another word. */
const MIN_LINK_TOKEN = 12;

/**
 * Pure: the databases and services one app's variables point at. A Coolify resource is reached by its uuid (a database's container is
 * named `<uuid>`, a service member's `<member>-<uuid>`), so a value that contains the uuid names it. Values are only READ here (never
 * carried or kept). `unreadable` is true when at least one variable has no readable value (a read-only token, no consent yet, a locked
 * variable, a failed read): then the variables cannot rule a dependency out. Sorted so the derived `dependsOn` (hence the plan hash) does
 * not depend on the order of the rows.
 */
export function coolifyLinksFromEnv(envs: CoolifyEnv[] | undefined, targets: ReadonlyArray<{ kind: "database" | "service"; ref: string }>): { links: ForeignLink[]; unreadable: boolean } {
  if (!envs) return { links: [], unreadable: true };
  const links = new Map<string, ForeignLink>();
  let unreadable = false;
  for (const e of envs) {
    const value = e.real_value ?? e.value;
    if (typeof value !== "string") {
      unreadable = true;
      continue;
    }
    // A shared-variable reference the source did not expand ({{project.DB_URL}}) hides the host it stands for.
    if (e.real_value === undefined && (e.is_shared === true || value.includes("{{"))) unreadable = true;
    const text = value.toLowerCase();
    for (const t of targets) {
      const token = t.ref.toLowerCase();
      if (token.length >= MIN_LINK_TOKEN && !links.has(t.ref) && text.includes(token)) links.set(t.ref, { kind: t.kind, ref: t.ref, envKey: e.key, internalHost: t.ref });
    }
  }
  return { links: [...links.values()].sort((a, b) => a.ref.localeCompare(b.ref)), unreadable };
}

/** Assemble a full {@link ForeignFleet} from the Coolify resources discover already fetched. */
export function buildCoolifyFleet(input: CoolifyFleetInput): ForeignFleet {
  const serverOf = new Map<string, string>();
  for (const [serverUuid, refs] of Object.entries(input.resourcesByServer)) {
    // First writer wins: a resource's primary server is the first that lists it (a multi-server app may
    // appear under several — the later ones must not overwrite the primary placement).
    for (const ref of refs) if (!serverOf.has(ref)) serverOf.set(ref, serverUuid);
  }
  const envs = (uuid: string) => input.envsByResource[uuid] ?? [];
  const vols = (uuid: string) => input.volumesByResource[uuid] ?? [];

  const apps = input.apps.map((a) => {
    const mapped = mapApplication(a, { envs: envs(a.uuid), volumes: vols(a.uuid), serverRef: serverOf.get(a.uuid) });
    const envReport = input.envReportByResource?.[a.uuid];
    const sourceHealth = appSourceHealth(a);
    return { ...mapped, ...(envReport ? { envReport } : {}), ...(sourceHealth ? { sourceHealth } : {}) };
  });
  const databases = input.databases.map((d) => mapDatabase(d, { volumes: vols(d.uuid), serverRef: serverOf.get(d.uuid), backups: input.backupsByResource?.[d.uuid], s3: input.s3Storages }));
  const serverNameOf = new Map(input.servers.filter((s) => s.name).map((s) => [s.uuid, s.name as string]));
  const services = input.services.map((s) => {
    const serverRef = serverOf.get(s.uuid);
    return mapService(s, { serverRef, serverName: serverRef ? serverNameOf.get(serverRef) : undefined });
  });

  // What each app needs: the databases and services its variables name; where they cannot be read, the ones of its own environment (an app and
  // its database rarely live apart in one Coolify environment). The plan turns the links into `dependsOn`, which the scope step reads to offer
  // "Add them" when an app is picked without them.
  const linkTargets = [...databases.map((d) => ({ kind: "database" as const, ref: d.sourceRef })), ...services.map((s) => ({ kind: "service" as const, ref: s.sourceRef }))];
  const linkedApps = apps.map((a) => {
    const { links, unreadable } = coolifyLinksFromEnv(input.envsByResource[a.sourceRef], linkTargets);
    const env = unreadable ? input.locByUuid?.get(a.sourceRef)?.environmentRef : undefined;
    const sameEnv = env ? linkTargets.filter((t) => !links.some((l) => l.ref === t.ref) && input.locByUuid?.get(t.ref)?.environmentRef === env).map((t): ForeignLink => ({ kind: t.kind, ref: t.ref })) : [];
    const all = [...links, ...sameEnv].sort((x, y) => x.ref.localeCompare(y.ref));
    return all.length ? { ...a, links: all } : a;
  });

  const warnings: string[] = [...(input.warnings ?? [])];
  // A note about specific items carries the refs of those items, so a review narrowed to some servers shows only the notes of what it moves.
  const scopedWarnings: NonNullable<ForeignFleet["scopedWarnings"]> = [];
  const note = (text: string, itemRefs: string[]): void => {
    warnings.push(text);
    scopedWarnings.push({ text, itemRefs });
  };
  const refOf = (kind: "app" | "database" | "service", x: { serverRef?: string; sourceRef: string }): string => ns(kind, x.serverRef, x.sourceRef);
  for (const a of apps.filter((x) => x.kind === "compose" && !x.composeFile)) note(`app ${a.name} needs a read:sensitive token to fetch its compose file before import`, [refOf("app", a)]);
  for (const sv of services.filter((x) => !x.composeFile)) note(`service ${sv.name} needs a read:sensitive token to fetch its compose file before import`, [refOf("service", sv)]);
  const hiddenApps = input.apps.filter((a) => !isSensitiveVisible(a, "application"));
  const hiddenDbs = input.databases.filter((d) => !isSensitiveVisible(d, "database"));
  const hiddenTail =
    "they will NOT be carried and must be re-entered after the import. To carry them, create the Coolify token with the read:sensitive ability as a team admin or owner (Coolify ignores the ability for other members), then reconnect";
  const appRefOfUuid = new Map(apps.map((a) => [a.sourceRef, refOf("app", a)]));
  const dbRefOfUuid = new Map(databases.map((d) => [d.sourceRef, refOf("database", d)]));
  const refsOf = (rows: Array<{ uuid: string }>, by: Map<string, string>): string[] => rows.flatMap((r) => (by.has(r.uuid) ? [by.get(r.uuid)!] : []));
  if (hiddenApps.length > 0) {
    note(`the API token cannot read the sensitive fields of some applications (install/build/start commands, deploy hooks, health-check commands, custom Docker options, container labels and inline Dockerfile) - ${hiddenTail}`, refsOf(hiddenApps, appRefOfUuid));
  }
  if (hiddenDbs.length > 0) {
    note(`the API token cannot read the sensitive fields of some databases (custom config files and Docker options) - ${hiddenTail}`, refsOf(hiddenDbs, dbRefOfUuid));
  }
  const s3Dbs = databases.filter((d) => d.backupSchedule?.s3);
  for (const d of s3Dbs) {
    const targets = d.backupSchedule?.targets ?? [];
    note(`database ${d.name} has a scheduled backup that uploads to S3${targets.length ? ` (${targets.join(", ")})` : ""}`, [refOf("database", d)]);
  }
  if (s3Dbs.length > 0) {
    note("Tugra does not carry the backup schedules or the S3 destinations (their credentials are never read): add the destination in Tugra's Backups and recreate each schedule after the import", s3Dbs.map((d) => refOf("database", d)));
  }
  for (const d of databases.filter((x) => x.engine === "UNKNOWN")) note(`database ${d.name} has an engine with no Tugra equivalent (e.g. SQLite) and cannot be imported`, [refOf("database", d)]);
  // Apps already failing at the source (exited, unhealthy, crash-looping): migrated as they are, so the plan names them. One line per app: the
  // review shows the ones of the apps it moves (and caps the list itself).
  for (const a of apps.filter((x) => x.sourceHealth && isDegradedHealth(x.sourceHealth.health, x.sourceHealth.restartCount))) note(sourceHealthWarning(a.name, a.sourceHealth!), [refOf("app", a)]);

  return {
    servers: input.servers.map(foreignServerOf),
    apps: linkedApps,
    databases,
    services,
    volumes: [], // Coolify volumes are always resource-owned (attached above); no standalone volumes
    sharedEnv: [], // team/project shared vars are resolved at apply time (read:sensitive); not in discover
    warnings,
    ...(scopedWarnings.length ? { scopedWarnings } : {}),
  };
}
