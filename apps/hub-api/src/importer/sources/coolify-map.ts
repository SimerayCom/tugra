import { why } from "../reason";
import { inlineDockerfileProblem } from "../../applications/dto";
import type {
  ForeignApp,
  ForeignDb,
  ForeignDomain,
  ForeignEnv,
  ForeignFleet,
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
 * any read token. A gated field is absent from the row, never null: {@link isSensitiveVisibleRow} tells the two apart so
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
  };
}

/** A discovered server with the facts PREFLIGHT classifies it by; a fact the API did not report is left out. */
function foreignServerOf(s: CoolifyServer): ForeignFleet["servers"][number] {
  const os = coolifyServerOs(s);
  return {
    ref: s.uuid,
    name: s.name ?? undefined,
    ip: s.ip ?? undefined,
    ...(s.is_coolify_host === true ? { controlPlane: true } : {}),
    ...(typeof s.unreachable_count === "number" && Number.isFinite(s.unreachable_count) && s.unreachable_count >= 0 ? { unreachableCount: Math.floor(s.unreachable_count) } : {}),
    ...(os ? { os } : {}),
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
  // Commands: read:sensitive-gated from 4.7 (absent from the row, see isSensitiveVisibleRow); any read token on 4.1.2 to 4.6.
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
  /** Nested `application_settings` of `GET /applications/{uuid}` (4.7: `is_static` / `is_spa` are NOT top-level columns). */
  settings?: { is_static?: boolean | null; is_spa?: boolean | null } | null;
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
  /** A custom redis.conf (Redis only). Presence-only: the text is never read into the fleet. */
  redis_conf?: string | null;
}
export interface CoolifyService {
  uuid: string;
  name?: string | null;
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
  if (/redis|valkey/.test(image)) return "REDIS"; // Valkey speaks the Redis protocol; Coolify 4.7 gives it `standalone-redis` too
  return "UNKNOWN";
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

/** The row keys Coolify 4.7 hides from a token without `read:sensitive` (Application / database / Service `$hidden`). A key is ABSENT then, not null. */
const SENSITIVE_MARKER_KEYS: Record<"application" | "database" | "service", readonly string[]> = {
  application: ["install_command", "build_command", "start_command", "pre_deployment_command", "post_deployment_command", "custom_docker_run_options"],
  database: ["custom_docker_run_options"],
  service: ["docker_compose_raw"],
};

/**
 * Pure: whether a list/detail row was read with a token that may see sensitive fields. By KEY PRESENCE: 4.7 drops the gated keys
 * from the row when the token lacks `read:sensitive` (or its creator is not a team admin/owner), where 4.1.2 to 4.6 always
 * return them (null when unset), so a row carrying ANY marker key is a visible one and an old instance never trips the warning.
 * Not a row at all (null / array) counts as visible: there is nothing to warn about.
 */
export function isSensitiveVisibleRow(row: unknown, kind: "application" | "database" | "service" = "application"): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return true;
  return SENSITIVE_MARKER_KEYS[kind].some((k) => k in (row as Record<string, unknown>));
}

/** Fixed-reason coverage rows for what is PRESENT on a Coolify app but has no Tugra carry path. Presence only. */
function coolifyNotCarried(app: CoolifyApp, realGit: boolean, kind: ForeignApp["kind"]): NonNullable<ForeignApp["notCarried"]> {
  const out: NonNullable<ForeignApp["notCarried"]> = [];
  if (app.is_http_basic_auth_enabled === true) out.push({ field: "basicAuth", level: "warn", ...why("coolify_basic_auth") });
  if (nonEmpty(app.ports_mappings)) out.push({ field: "publishedPorts", level: "warn", ...why("coolify_published_ports") });
  if (nonEmpty(app.custom_docker_run_options)) out.push({ field: "dockerOptions", level: "warn", ...why("coolify_docker_options") });
  if (nonEmpty(app.pre_deployment_command) || nonEmpty(app.post_deployment_command)) out.push({ field: "deployHooks", level: "info", ...why("coolify_deploy_hooks") });
  if (nonZero(app.limits_memory) || nonZero(app.limits_cpus)) out.push({ field: "limits", level: "info", ...why("coolify_limits") });
  if (app.health_check_enabled === true) out.push({ field: "healthcheck", level: "info", ...why("coolify_healthcheck") });
  if (nonEmpty(app.dockerfile_target_build)) out.push({ field: "dockerBuildTarget", level: "info", ...why("coolify_build_target") });
  // watch_paths are carried (ForeignApp.watchPaths); R18: the www / non-www redirect has no Tugra setting, so the mode is reported.
  if (app.redirect === "www" || app.redirect === "non-www") out.push({ field: "redirectMode", level: "info", ...why("coolify_redirect", { mode: app.redirect }) });
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
  if (nonEmpty(app.custom_labels)) sourceExtras.labels = true;
  if (app.build_pack === "dockerfile" && (nonEmpty(app.dockerfile) || nonEmpty(app.dockerfile_raw))) sourceExtras.dockerfile = true;
  const notCarried = coolifyNotCarried(app, realGit, kind);
  const watchPaths = parseWatchPaths(app.watch_paths);
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
          // `source_type` names the git source's model (4.7); older rows do not carry it and fall back to the owner/repo shape.
          provider: coolifyGitProvider(app.source_type) ?? (isGithubAppRepo(app.git_repository!) ? "github" : undefined),
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
    ports: parsePorts(app.ports_exposes),
    domains: mapAppDomains(app, kind),
    env: ctx.envs.map(mapEnv),
    volumes: ctx.volumes.map((v) => mapVolume(v, app.uuid)),
    internalHost: app.uuid, // Coolify's internal docker hostname is the resource uuid
    ...(parseNetworkAliases(app.custom_network_aliases).length ? { networkAliases: parseNetworkAliases(app.custom_network_aliases) } : {}),
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
  const tls = tlsExpectation(db);
  // Coolify 4.7 runs a new `standalone-redis` database on valkey/valkey (its tag, `9-alpine`, is no Redis version: a stock
  // `redis:9-alpine` does not exist). Tugra creates it as Redis, keeps the source image, and names no version.
  const valkey = engine === "REDIS" && isValkeyImage(db.image);
  const notCarried: NonNullable<ForeignDb["notCarried"]> = [];
  if (valkey) notCarried.push({ field: "engineFamily", level: "info", ...why("coolify_valkey") });
  if (engine === "REDIS" && nonEmpty(db.redis_conf)) notCarried.push({ field: "redisConf", level: "warn", ...why("coolify_redis_conf") });
  return {
    sourceRef: db.uuid,
    name: db.name ?? db.uuid,
    engine,
    version: valkey ? undefined : versionFromImage(db.image),
    image: db.image ?? undefined,
    credentials: { username: username ?? undefined, database: database ?? undefined, secretRef: db.uuid },
    hostInternal: db.uuid,
    externalPort: db.is_public ? db.public_port ?? undefined : undefined,
    volumes: ctx.volumes.map((v) => mapVolume(v, db.uuid)),
    serverRef: ctx.serverRef,
    ...(tls ? { tls } : {}),
    // R48: Tugra's Redis has no custom redis.conf. Presence only; the plan says the config must be re-applied by hand.
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
    return envReport ? { ...mapped, envReport } : mapped;
  });
  const databases = input.databases.map((d) => mapDatabase(d, { volumes: vols(d.uuid), serverRef: serverOf.get(d.uuid) }));
  const serverNameOf = new Map(input.servers.filter((s) => s.name).map((s) => [s.uuid, s.name as string]));
  const services = input.services.map((s) => {
    const serverRef = serverOf.get(s.uuid);
    return mapService(s, { serverRef, serverName: serverRef ? serverNameOf.get(serverRef) : undefined });
  });

  const warnings: string[] = [...(input.warnings ?? [])];
  const composeNeedingSecret = apps.filter((a) => a.kind === "compose" && !a.composeFile).length;
  if (composeNeedingSecret > 0) {
    warnings.push(`${composeNeedingSecret} docker-compose app(s) need a read:sensitive token to fetch their compose file before import`);
  }
  const servicesNeedingSecret = services.filter((s) => !s.composeFile).length;
  if (servicesNeedingSecret > 0) {
    warnings.push(`${servicesNeedingSecret} service(s) need a read:sensitive token to fetch their compose file before import`);
  }
  const hiddenApps = input.apps.filter((a) => !isSensitiveVisibleRow(a, "application")).length;
  const hiddenDbs = input.databases.filter((d) => !isSensitiveVisibleRow(d, "database")).length;
  if (hiddenApps > 0 || hiddenDbs > 0) {
    const what = [
      hiddenApps > 0 ? `${hiddenApps} application(s): install/build/start commands, deploy hooks, health-check commands, custom Docker options, container labels and inline Dockerfile` : "",
      hiddenDbs > 0 ? `${hiddenDbs} database(s): custom config files and Docker options` : "",
    ].filter(Boolean);
    warnings.push(
      `the API token cannot read the sensitive fields of ${what.join("; ")} — they will NOT be carried and must be re-entered after the import. To carry them, create the Coolify token with the read:sensitive ability as a team admin or owner (Coolify ignores the ability for other members), then reconnect`,
    );
  }
  const unknownDbs = databases.filter((d) => d.engine === "UNKNOWN").length;
  if (unknownDbs > 0) warnings.push(`${unknownDbs} database(s) have an engine with no Tugra equivalent (e.g. SQLite) and cannot be imported`);

  return {
    servers: input.servers.map(foreignServerOf),
    apps,
    databases,
    services,
    volumes: [], // Coolify volumes are always resource-owned (attached above); no standalone volumes
    sharedEnv: [], // team/project shared vars are resolved at apply time (read:sensitive); not in discover
    warnings,
  };
}
