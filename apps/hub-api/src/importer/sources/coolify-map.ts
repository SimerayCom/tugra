import { inlineDockerfileProblem } from "../../applications/dto";
import type {
  ForeignApp,
  ForeignDb,
  ForeignDomain,
  ForeignEnv,
  ForeignFleet,
  ForeignService,
  ForeignVolume,
  TugraDbEngine,
} from "../foreign-fleet";

/**
 * Pure mappers: Coolify v4 REST JSON → the neutral {@link ForeignFleet}. SECRET-FREE — discover runs on a
 * plain read token, where Coolify strips passwords, env VALUES, internal_db_url, docker_compose_raw and
 * dockerfile (all `read:sensitive`-gated). We therefore carry only non-secret identity: names, usernames,
 * database names, env KEYS, domains, ports, build config, and `secretRef` (the Coolify uuid) for a later
 * sensitive-scoped fetch. Field names below are taken verbatim from Coolify v4.4.6 models/controllers.
 */

// ── Raw Coolify shapes (only the fields we read; sensitive ones are usually absent on a read token) ──
export interface CoolifyServer {
  uuid: string;
  name?: string | null;
  ip?: string | null;
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
  install_command?: string | null;
  build_command?: string | null;
  start_command?: string | null;
  fqdn?: string | null; // "https://a.com,http://b.com:3000"
  docker_compose_raw?: string | null; // read:sensitive → usually absent in discover
  // ── Presence-only / apply-time reads. Names + encodings are HAND-BUILT from Coolify v4 sources, UNVERIFIED until
  // the live check (spec G3-C section 11); a wrong name only loses a coverage note, never produces wrong data.
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
  watch_paths?: string | null;
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
}
export interface CoolifyService {
  uuid: string;
  name?: string | null;
  service_type?: string | null; // one-click template key
  docker_compose_raw?: string | null; // read:sensitive → usually absent in discover
  applications?: Array<{ uuid: string; name?: string | null; fqdn?: string | null }>;
  databases?: Array<{ uuid: string; name?: string | null }>;
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

export interface CoolifyFleetInput {
  servers: CoolifyServer[];
  /** serverUuid → the resource uuids running on it (from GET /servers/{uuid}/resources). */
  resourcesByServer: Record<string, string[]>;
  apps: CoolifyApp[];
  databases: CoolifyDatabase[];
  services: CoolifyService[];
  envsByResource: Record<string, CoolifyEnv[]>;
  volumesByResource: Record<string, CoolifyVolume[]>;
  /** Non-fatal fetch warnings accumulated by the adapter (a partial 403/404 during enumeration). */
  warnings?: string[];
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
  if (/redis/.test(image)) return "REDIS";
  return "UNKNOWN";
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
export function normalizeGitUrl(repo: string): string {
  const r = repo.trim();
  if (/^(https?:\/\/|git@|ssh:\/\/)/i.test(r)) return r; // already a clone URL / scp-like form
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return `https://github.com/${r.replace(/\.git$/i, "")}.git`; // owner/repo (GitHub App)
  return r;
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

/** Coolify build pack → Tugra source kind + build pack. A docker-image app (build_pack 'dockerimage', or a
 *  registry image with no real git repo) wins first — Coolify stores a placeholder repo for those. */
export function mapCoolifyBuildPack(app: CoolifyApp): { kind: ForeignApp["kind"]; buildPack: ForeignApp["buildPack"] } {
  if (app.build_pack === "dockerimage" || (!hasRealGit(app) && app.docker_registry_image_name)) {
    return { kind: "image", buildPack: "image" };
  }
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

/** Parse "3000,8080" → [3000, 8080] (positive integers only). */
export function parsePorts(s: string | null | undefined): number[] {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => parseInt(x.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
}

/** First version-looking token of an image TAG: "postgres:17-alpine" → "17". Robust against a registry
 *  host:port ("registry:5000/postgres:16" → "16") and digest-pinned images ("repo@sha256:…" → undefined). */
export function versionFromImage(image: string | null | undefined): string | undefined {
  if (!image || image.includes("@")) return undefined; // digest-pinned → no version tag
  const lastSegment = image.split("/").pop() ?? ""; // drop registry host[:port] + path
  if (!lastSegment.includes(":")) return undefined;
  const tag = lastSegment.split(":").pop();
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
/** Coolify "0" / "" / null / 0 all mean "no limit". */
const nonZero = (v: unknown): boolean => (typeof v === "number" ? v > 0 : typeof v === "string" && v.trim() !== "" && v.trim() !== "0");

/** Fixed-reason coverage rows for what is PRESENT on a Coolify app but has no Tugra carry path. Presence only. */
function coolifyNotCarried(app: CoolifyApp, realGit: boolean, kind: ForeignApp["kind"]): NonNullable<ForeignApp["notCarried"]> {
  const out: NonNullable<ForeignApp["notCarried"]> = [];
  if (app.is_http_basic_auth_enabled === true) out.push({ field: "basicAuth", level: "warn", reason: "the source gated this app with HTTP basic auth; the credentials are not read, so the imported app is NOT gated until you set basic auth in Tugra before the first deploy" });
  if (nonEmpty(app.ports_mappings)) out.push({ field: "publishedPorts", level: "warn", reason: "host-published ports are not carried; add them in the app's Ports settings" });
  if (nonEmpty(app.custom_docker_run_options)) out.push({ field: "dockerOptions", level: "warn", reason: "custom Docker run options are owner-gated in Tugra and never auto-applied" });
  if (nonEmpty(app.pre_deployment_command) || nonEmpty(app.post_deployment_command)) out.push({ field: "deployHooks", level: "info", reason: "set them in the app's Deploy hooks after import" });
  if (nonZero(app.limits_memory) || nonZero(app.limits_cpus)) out.push({ field: "limits", level: "info", reason: "resource limits are not carried from Coolify yet; set them in Tugra" });
  if (app.health_check_enabled === true) out.push({ field: "healthcheck", level: "info", reason: "health check not carried" });
  if (nonEmpty(app.dockerfile_target_build)) out.push({ field: "dockerBuildTarget", level: "info", reason: "build target not carried from Coolify yet" });
  if (nonEmpty(app.watch_paths)) out.push({ field: "watchPaths", level: "info", reason: "watch paths not carried from Coolify yet" });
  // The planner's `app.git.missing` blocker case: a Dockerfile app with no real repo (and no image to fall back to).
  if (app.build_pack === "dockerfile" && !realGit && kind !== "image") {
    out.push({ field: "inlineDockerfile", level: "warn", reason: "an inline-Dockerfile app has no git repository; Tugra builds Dockerfile apps from a repo, so this app cannot be imported yet (repo-less Dockerfile apps are a planned feature)" });
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
  if (nonEmpty(app.custom_labels)) sourceExtras.labels = true;
  if (app.build_pack === "dockerfile" && (nonEmpty(app.dockerfile) || nonEmpty(app.dockerfile_raw))) sourceExtras.dockerfile = true;
  const notCarried = coolifyNotCarried(app, realGit, kind);
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
          url: normalizeGitUrl(app.git_repository!),
          branch: app.git_branch ?? undefined,
          dockerfilePath: app.dockerfile_location ?? undefined,
          baseDirectory: app.base_directory ?? undefined,
          provider: isGithubAppRepo(app.git_repository!) ? "github" : undefined,
        }
      : undefined,
    composeFile: app.docker_compose_raw ?? undefined, // present only with a read:sensitive token
    // install/build/start are app build CONFIG (shown by Coolify to any read token, not secret-gated) and
    // are required to reproduce the build — carried as-is.
    installCommand: app.install_command ?? undefined,
    buildCommand: app.build_command ?? undefined,
    startCommand: app.start_command ?? undefined,
    publishDirectory: app.publish_directory ?? undefined,
    ports: parsePorts(app.ports_exposes),
    domains: parseFqdns(app.fqdn),
    env: ctx.envs.map(mapEnv),
    volumes: ctx.volumes.map((v) => mapVolume(v, app.uuid)),
    internalHost: app.uuid, // Coolify's internal docker hostname is the resource uuid
    serverRef: ctx.serverRef,
    ...(Object.keys(sourceExtras).length ? { sourceExtras } : {}),
    ...(notCarried.length ? { notCarried } : {}),
  };
}

export function mapDatabase(
  db: CoolifyDatabase,
  ctx: { volumes: CoolifyVolume[]; serverRef?: string },
): ForeignDb {
  const engine = coolifyEngine(db);
  const username =
    db.postgres_user ?? db.mysql_user ?? db.mariadb_user ?? db.mongo_initdb_root_username ?? db.clickhouse_admin_user ?? undefined;
  const database =
    db.postgres_db ?? db.mysql_database ?? db.mariadb_database ?? db.mongo_initdb_database ?? db.clickhouse_db ?? undefined;
  return {
    sourceRef: db.uuid,
    name: db.name ?? db.uuid,
    engine,
    version: versionFromImage(db.image),
    image: db.image ?? undefined,
    credentials: { username: username ?? undefined, database: database ?? undefined, secretRef: db.uuid },
    hostInternal: db.uuid,
    externalPort: db.is_public ? db.public_port ?? undefined : undefined,
    volumes: ctx.volumes.map((v) => mapVolume(v, db.uuid)),
    serverRef: ctx.serverRef,
  };
}

export function mapService(svc: CoolifyService, ctx: { serverRef?: string }): ForeignService {
  return {
    sourceRef: svc.uuid,
    name: svc.name ?? svc.uuid,
    templateSlug: svc.service_type ?? undefined,
    composeFile: svc.docker_compose_raw ?? undefined, // read:sensitive-gated
    memberApps: (svc.applications ?? []).map((a) => a.uuid),
    memberDbs: (svc.databases ?? []).map((d) => d.uuid),
    serverRef: ctx.serverRef,
  };
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

  const apps = input.apps.map((a) => mapApplication(a, { envs: envs(a.uuid), volumes: vols(a.uuid), serverRef: serverOf.get(a.uuid) }));
  const databases = input.databases.map((d) => mapDatabase(d, { volumes: vols(d.uuid), serverRef: serverOf.get(d.uuid) }));
  const services = input.services.map((s) => mapService(s, { serverRef: serverOf.get(s.uuid) }));

  const warnings: string[] = [...(input.warnings ?? [])];
  const composeNeedingSecret = apps.filter((a) => a.kind === "compose" && !a.composeFile).length;
  if (composeNeedingSecret > 0) {
    warnings.push(`${composeNeedingSecret} docker-compose app(s) need a read:sensitive token to fetch their compose file before import`);
  }
  const servicesNeedingSecret = services.filter((s) => !s.composeFile).length;
  if (servicesNeedingSecret > 0) {
    warnings.push(`${servicesNeedingSecret} service(s) need a read:sensitive token to fetch their compose file before import`);
  }
  const unknownDbs = databases.filter((d) => d.engine === "UNKNOWN").length;
  if (unknownDbs > 0) warnings.push(`${unknownDbs} database(s) have an engine with no Tugra equivalent (e.g. SQLite) and cannot be imported`);

  return {
    servers: input.servers.map((s) => ({ ref: s.uuid, name: s.name ?? undefined, ip: s.ip ?? undefined })),
    apps,
    databases,
    services,
    volumes: [], // Coolify volumes are always resource-owned (attached above); no standalone volumes
    sharedEnv: [], // team/project shared vars are resolved at apply time (read:sensitive); not in discover
    warnings,
  };
}
