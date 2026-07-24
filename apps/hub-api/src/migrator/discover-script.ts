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
}

// Tugra APPS use an underscore (tugra_<appId>); INFRA containers use a hyphen. Both are Tugra-owned
// and must be excluded from adoption. (Matches deploy-script containerName / tunnel / agent installer.)
const INFRA_NAMES = new Set(["tugra-proxy", "tugra-cfd", "tugra-agent"]);
// Docker/base-image-injected keys that are never meaningful app config to carry into an adopted app.
const NOISE_ENV_KEYS = new Set(["PATH", "HOSTNAME"]);

/** Emitted when the host has no docker at all — the one hard-failure marker (mirrors patch-script). */
export const NO_DOCKER_MARKER = "TUGRA_NO_DOCKER";

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
export function parseDiscovered(output: string): DiscoveredContainer[] {
  const out: DiscoveredContainer[] = [];
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
    const composeProject = config.Labels?.["com.docker.compose.project"] ?? null;
    out.push({
      id: typeof raw.Id === "string" ? raw.Id : "",
      name,
      image: typeof config.Image === "string" ? config.Image : "",
      state: typeof state.Status === "string" ? state.Status : "",
      ports: parsePorts(raw),
      env: parseEnv(raw),
      mounts: parseMounts(raw),
      restartPolicy: hostConfig.RestartPolicy?.Name ?? "",
      isTugra: name.startsWith("tugra_") || INFRA_NAMES.has(name),
      composeProject,
    });
  }
  return out;
}
