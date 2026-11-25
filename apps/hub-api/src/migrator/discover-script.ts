/**
 * Pure builders + parser for the migrator "discover / adopt" flow. The agent runs these shell
 * scripts as-is and returns their stdout; we parse `docker inspect --format '{{json .}}'` output
 * back into structured container info here. A container reference (name or id) flows into
 * `docker inspect <ref>` / `docker rename <ref> …`, so it is strictly validated (CONTAINER_REF_RE)
 * exactly like PKG_RE in patch-script — no shell metacharacters, spaces or leading flags.
 */

// Docker's own name/id charset: first char alphanumeric, then [A-Za-z0-9_.-]. Rejects metachars,
// spaces, `;`/`|`/`$`/backticks and a leading `-` (flag). Long enough for a 64-char id + `tugra_` names.
export const CONTAINER_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function assertValidContainerRef(ref: string): void {
  if (!CONTAINER_REF_RE.test(ref)) throw new Error("invalid container reference");
}

export interface DiscoveredPort {
  host: number | null; // published host port, or null when only exposed (unpublished)
  container: number;
  protocol: "tcp" | "udp";
}
export interface DiscoveredEnv {
  key: string;
  value: string;
}
export interface DiscoveredMount {
  type: string; // "volume" | "bind" | …
  source: string; // named volume → its name; bind → host path
  target: string; // in-container path
}
/** Why a container is Tugra's own (never listed, never adoptable). */
export type TugraOwnedReason = "stack" | "proxy" | "tunnel" | "helper" | "managed" | "reserved";

export interface DiscoveredContainer {
  id: string;
  name: string;
  image: string;
  state: string; // docker's raw State.Status: running | exited | …
  ports: DiscoveredPort[];
  env: DiscoveredEnv[];
  mounts: DiscoveredMount[];
  restartPolicy: string;
  isTugra: boolean;
  composeProject: string | null;
  /** Another platform runs this container (its own stack or one of its apps): move it with that platform's import. */
  managedBy: ForeignPlatform | null;
}

export type ForeignPlatform = "coolify" | "dokploy";

/**
 * Which platform manages a container, from its labels, name and image. Coolify labels every app, database and service
 * it deploys (`coolify.*`) and names its own stack `coolify-*` (proxy, sentinel, realtime, helper); Dokploy does the
 * same with `dokploy*` names and images. Adopting such a container would fight the platform, so it is never offered.
 */
export function foreignPlatform(c: { name: string; image: string; labelKeys: readonly string[] }): ForeignPlatform | null {
  const image = c.image.toLowerCase();
  if (c.labelKeys.some((k) => k.startsWith("coolify.")) || /^coolify[-_]/.test(c.name) || /(^|\/)coollabsio\//.test(image)) return "coolify";
  if (c.labelKeys.some((k) => k.startsWith("dokploy")) || /^dokploy[-_]/.test(c.name) || /(^|\/)dokploy\//.test(image)) return "dokploy";
  return null;
}

/** Parser-internal view: the public fields plus the identity signals the Tugra-ownership classifier reads. */
export interface ParsedContainer extends DiscoveredContainer {
  composeService: string | null;
  composeWorkingDir: string | null;
  /** `com.docker.compose.project.config_files` as docker recorded it (comma-separated absolute paths), or null. */
  composeConfigFiles: string | null;
  labelKeys: string[];
  tugraReason: TugraOwnedReason | null;
  /** True when this container proves its compose project is Tugra's own install (see {@link isProjectAnchor}). */
  projectAnchor: boolean;
}

/** Strip the internal classifier fields before a container goes over the wire. */
export function toPublicContainer(c: ParsedContainer): DiscoveredContainer {
  const { composeService: _s, composeWorkingDir: _w, composeConfigFiles: _f, labelKeys: _l, tugraReason: _r, projectAnchor: _a, ...pub } = c;
  void _s; void _w; void _f; void _l; void _r; void _a;
  return pub;
}

// Tugra APPS/DBs/services use an underscore (tugra_<id>, tugra_db_<id>, tugra_<id>-<svc>-1); INFRA + helper
// containers use a hyphen (tugra-proxy, tugra-agent, tugra-cfd, tugra-patch, tugra-vx-*, tugra-reboot, ...).
// The whole `tugra_` / `tugra-` name space is reserved and never listed or adopted (exact families get a precise
// reason, anything else a "reserved name" one). (Matches deploy-script
// containerName / tunnel / agent installer / the compose default `<project>-<service>-<n>` for project "tugra".)
const TUGRA_NAME_RE = /^tugra[_-]/;
const PROXY_NAMES = new Set(["tugra-proxy", "tugra-swarm-proxy"]);
// Tugra-deployed app / database / compose-service containers: tugra_<id>, tugra_db_<id>, tugra_<id>-<svc>-1
// where <id> is a cuid (25 chars). A user's `tugra_db` / `tugra_blog` is not this shape.
const TUGRA_APP_NAME_RE = /^tugra_(db_)?[a-z0-9]{20,}([_-]|$)/;
const TUNNEL_NAME_RE = /^tugra-cfd/;
const HELPER_NAME_RE = /^tugra[_-](vx|pat|patch|reboot|mig|migrate|migrator|objmig|restore|backup|wal|verify|fsd|part|updater-refresh|swarm-dns|gpuprobe)([_-]|$)/;
// The services of Tugra's own install stack (deploy/docker-compose.yml).
const STACK_SERVICES = new Set(["hub-api", "web", "agent", "tugra-updater", "postgres", "redis"]);
function imageRepo(image: string): string {
  const noDigest = image.split("@")[0] ?? "";
  const lastSlash = noDigest.lastIndexOf("/");
  const colon = noDigest.indexOf(":", lastSlash + 1);
  return (colon === -1 ? noDigest : noDigest.slice(0, colon)).toLowerCase();
}

/**
 * `ghcr.io/simeraycom/tugra-*` (or a mirror of it) and locally built (registry-less) `tugra-*` / `tugra_*` images.
 * A foreign org's `myorg/tugra-fan` is NOT Tugra's.
 */
export function isTugraImage(image: string): boolean {
  const repo = imageRepo(image);
  if (repo.includes("simeraycom/tugra")) return true;
  return !repo.includes("/") && /^tugra[_-]/.test(repo);
}

/** First-party image of the stack's hub/web/updater (the agent image is excluded: it may legitimately sit in any project). */
function isStackAnchorImage(image: string): boolean {
  const repo = imageRepo(image);
  return repo.includes("simeraycom/tugra") && !/simeraycom\/tugra-agent$/.test(repo);
}

const TUGRA_DIR_RE = /(^|\/)tugra(\/|$)/;

/**
 * Whether a compose-project member proves its whole project is Tugra's install: a first-party hub/web/updater
 * image, or a stack service running from Tugra's install dir. Weaker signals (a look-alike name, a lone
 * `hub-api` service name) hide the container itself but never its siblings.
 */
export function isProjectAnchor(c: { image: string; composeProject: string | null; composeService: string | null; composeWorkingDir: string | null }): boolean {
  if (!c.composeProject) return false;
  if (isStackAnchorImage(c.image)) return true;
  return c.composeService !== null && STACK_SERVICES.has(c.composeService) && c.composeWorkingDir !== null && TUGRA_DIR_RE.test(c.composeWorkingDir);
}

/**
 * Per-container Tugra-ownership check from the container's own identity (name, labels, image, compose
 * service + working dir). Members of Tugra's compose project that carry no Tugra signal of their own (the
 * bundled postgres/redis) are caught by the project pass in {@link parseDiscovered}.
 */
export function classifyTugraOwned(c: {
  name: string;
  image: string;
  composeProject: string | null;
  composeService: string | null;
  composeWorkingDir: string | null;
  labelKeys: string[];
}): TugraOwnedReason | null {
  if (PROXY_NAMES.has(c.name) || c.labelKeys.some((k) => k.startsWith("tugra.proxy."))) return "proxy";
  if (TUNNEL_NAME_RE.test(c.name)) return "tunnel";
  if (HELPER_NAME_RE.test(c.name) || c.labelKeys.includes("tugra.role")) return "helper";
  if (c.name === "tugra-agent") return "stack"; // standalone-installed agent container
  if (TUGRA_APP_NAME_RE.test(c.name)) return "managed";
  if (isTugraImage(c.image)) return "stack";
  // Tugra's install dir (a `tugra` path segment) + one of the stack's compose services.
  const svc = c.composeService;
  if (svc !== null && STACK_SERVICES.has(svc) && c.composeWorkingDir !== null && TUGRA_DIR_RE.test(c.composeWorkingDir)) return "stack";
  if (svc === "hub-api" || svc === "tugra-updater") return "stack"; // service names unique to Tugra's compose file
  if (c.labelKeys.some((k) => k.startsWith("tugra."))) return "managed";
  if (c.composeProject !== null && c.composeProject.startsWith("tugra_")) return "managed"; // Tugra-deployed compose app
  // Everything else in the tugra-/tugra_ name space is reserved (never listed) but may be a user's own naming.
  if (TUGRA_NAME_RE.test(c.name)) return "reserved";
  return null;
}

// Docker/base-image-injected keys that are never meaningful app config to carry into an adopted app.
const NOISE_ENV_KEYS = new Set(["PATH", "HOSTNAME"]);

/** Emitted when the host has no docker at all — the one hard-failure marker (mirrors patch-script). */
export const NO_DOCKER_MARKER = "TUGRA_NO_DOCKER";
/** Prefix of the line carrying the script host's hostname (inside the agent container: its short container id). */
export const SELF_MARKER = "TUGRA_SELF=";

/**
 * List every container on the host and inspect them in one round-trip. Resilient to a docker-less
 * host (marker) and to a container vanishing between `ps` and `inspect` (JSON for the survivors is
 * still emitted; the non-zero exit is deliberately NOT used as the gate — the parser tolerates it).
 */
export function buildDiscoverScript(): string {
  return [
    "if ! command -v docker >/dev/null 2>&1; then",
    `  echo ${NO_DOCKER_MARKER}`,
    "else",
    // The agent's own container id (its hostname) — lets the parser find the compose project Tugra itself runs in.
    `  echo ${SELF_MARKER}$(hostname 2>/dev/null)`,
    "  ids=$(docker ps -aq 2>/dev/null)",
    '  if [ -n "$ids" ]; then',
    "    docker inspect --format '{{json .}}' $ids 2>/dev/null",
    "  fi",
    "fi",
  ].join("\n");
}

/** Re-inspect a single container fresh (adopt-time TOCTOU guard). `ref` must be validated. */
export function buildInspectOneScript(ref: string): string {
  assertValidContainerRef(ref);
  return `docker inspect --format '{{json .}}' ${ref} 2>/dev/null`;
}

/** Rename a foreign container to Tugra's convention so all lifecycle code works unchanged. */
export function buildRenameScript(from: string, to: string): string {
  assertValidContainerRef(from);
  assertValidContainerRef(to);
  return `docker rename ${from} ${to}`;
}

/** Printed by {@link buildUnadoptScript} when the container to restore no longer exists (nothing to undo). */
export const CONTAINER_GONE_MARKER = "TUGRA_CONTAINER_GONE";

/**
 * Rollback of an adoption: rename `from` (tugra_<appId>) back to `to` (the original name) ONLY if it still
 * exists; otherwise print {@link CONTAINER_GONE_MARKER} and exit 0 (nothing to undo). This lets `unadopt`
 * distinguish "already gone / restored" (exit 0 → safe to drop the record) from a genuine rename failure
 * such as a name collision or an offline agent (non-zero exit / rejection → keep the record, stay retryable).
 */
export function buildUnadoptScript(from: string, to: string): string {
  assertValidContainerRef(from);
  assertValidContainerRef(to);
  return `if docker container inspect ${from} >/dev/null 2>&1; then docker rename ${from} ${to}; else echo ${CONTAINER_GONE_MARKER}; fi`;
}

/** The hostname line the discover script prints (the agent container's own id), or null. */
export function parseSelfHostname(output: string): string | null {
  for (const line of output.split("\n")) {
    const t = line.trim();
    if (t.startsWith(SELF_MARKER)) return t.slice(SELF_MARKER.length).trim() || null;
  }
  return null;
}

function stripSlash(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

function parsePorts(raw: Record<string, unknown>): DiscoveredPort[] {
  const out: DiscoveredPort[] = [];
  const push = (key: string, host: number | null) => {
    const [portStr, proto] = key.split("/");
    const container = Number(portStr);
    if (!Number.isInteger(container)) return;
    out.push({ host, container, protocol: proto === "udp" ? "udp" : "tcp" });
  };
  const hostConfig = raw.HostConfig as { PortBindings?: Record<string, Array<{ HostPort?: string }>> } | undefined;
  const bindings = hostConfig?.PortBindings;
  if (bindings && typeof bindings === "object") {
    for (const key of Object.keys(bindings)) {
      const arr = bindings[key];
      if (Array.isArray(arr) && arr.length > 0) {
        const hp = arr[0]?.HostPort;
        push(key, hp && /^\d+$/.test(hp) ? Number(hp) : null);
      }
    }
  }
  // No published bindings → fall back to exposed-only ports (host unknown/unpublished).
  if (out.length === 0) {
    const config = raw.Config as { ExposedPorts?: Record<string, unknown> } | undefined;
    const exposed = config?.ExposedPorts;
    if (exposed && typeof exposed === "object") {
      for (const key of Object.keys(exposed)) push(key, null);
    }
  }
  return out;
}

function parseEnv(raw: Record<string, unknown>): DiscoveredEnv[] {
  const config = raw.Config as { Env?: unknown } | undefined;
  const env = config?.Env;
  if (!Array.isArray(env)) return [];
  const out: DiscoveredEnv[] = [];
  for (const item of env) {
    if (typeof item !== "string") continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue; // no key, or "=value"
    const key = item.slice(0, eq);
    if (NOISE_ENV_KEYS.has(key)) continue;
    out.push({ key, value: item.slice(eq + 1) });
  }
  return out;
}

function parseMounts(raw: Record<string, unknown>): DiscoveredMount[] {
  const mounts = raw.Mounts;
  if (!Array.isArray(mounts)) return [];
  const out: DiscoveredMount[] = [];
  for (const m of mounts) {
    if (!m || typeof m !== "object") continue;
    const mm = m as { Type?: string; Name?: string; Source?: string; Destination?: string };
    const type = typeof mm.Type === "string" ? mm.Type : "";
    // For named volumes the human-meaningful id is the volume Name, not the /var/lib/... path.
    const source = type === "volume" ? mm.Name ?? mm.Source ?? "" : mm.Source ?? "";
    out.push({ type, source, target: mm.Destination ?? "" });
  }
  return out;
}

/**
 * Parse the discover script's NDJSON (one `docker inspect` object per line) into structured
 * containers. Line-tolerant: blank / marker / malformed-JSON lines are skipped, never thrown on;
 * 0 containers → []. Tugra-owned containers are returned too (flagged isTugra) — the caller filters.
 */
export function parseDiscovered(output: string): ParsedContainer[] {
  const out: ParsedContainer[] = [];
  for (const line of output.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("TUGRA_")) continue;
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(t);
      if (!parsed || typeof parsed !== "object") continue;
      raw = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = stripSlash(typeof raw.Name === "string" ? raw.Name : "");
    if (!name) continue;
    const config = (raw.Config ?? {}) as { Image?: string; Labels?: Record<string, string> };
    const state = (raw.State ?? {}) as { Status?: string };
    const hostConfig = (raw.HostConfig ?? {}) as { RestartPolicy?: { Name?: string } };
    const labels = config.Labels && typeof config.Labels === "object" ? config.Labels : {};
    const composeProject = labels["com.docker.compose.project"] ?? null;
    const composeService = labels["com.docker.compose.service"] ?? null;
    const composeWorkingDir = labels["com.docker.compose.project.working_dir"] ?? null;
    const composeConfigFiles = labels["com.docker.compose.project.config_files"] ?? null;
    const labelKeys = Object.keys(labels);
    const image = typeof config.Image === "string" ? config.Image : "";
    const tugraReason = classifyTugraOwned({ name, image, composeProject, composeService, composeWorkingDir, labelKeys });
    const projectAnchor = isProjectAnchor({ image, composeProject, composeService, composeWorkingDir });
    out.push({
      id: typeof raw.Id === "string" ? raw.Id : "",
      name,
      image: typeof config.Image === "string" ? config.Image : "",
      state: typeof state.Status === "string" ? state.Status : "",
      ports: parsePorts(raw),
      env: parseEnv(raw),
      mounts: parseMounts(raw),
      restartPolicy: hostConfig.RestartPolicy?.Name ?? "",
      isTugra: tugraReason !== null,
      composeProject,
      managedBy: foreignPlatform({ name, image, labelKeys }),
      composeService,
      composeWorkingDir,
      composeConfigFiles,
      labelKeys,
      tugraReason,
      projectAnchor,
    });
  }
  // Project pass: members of a compose project that Tugra itself runs in are the install stack — this is what
  // catches the bundled postgres/redis, which carry no Tugra-specific name, image or label. A project counts as
  // Tugra's only when a member proves it (first-party hub/web/updater image, or a stack service in Tugra's install
  // dir) or it is the project of the agent's own container; no project name is assumed (a foreign project that
  // happens to be called `tugra`, or one with a single look-alike member, keeps all its other services).
  const self = parseSelfHostname(output);
  const ownProjects = new Set<string>();
  for (const c of out) {
    if (!c.composeProject) continue;
    if (c.projectAnchor || (self && /^[0-9a-f]{12,64}$/.test(self) && c.id.startsWith(self))) ownProjects.add(c.composeProject);
  }
  for (const c of out) {
    if (c.tugraReason === null && c.composeProject && ownProjects.has(c.composeProject)) {
      c.tugraReason = "stack";
      c.isTugra = true;
    }
  }
  return out;
}
