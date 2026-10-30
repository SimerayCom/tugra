import { posix } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { parse } from "yaml";

// A fork-free compose OVERRIDE is user-authored, written verbatim to the host, and run by the agent
// (`docker compose up`) with the host docker socket — so `privileged`, a docker.sock bind, host
// namespaces, dangerous capabilities, device passthrough, or a sensitive host-path bind would let a
// team member escape the container and take over the shared host (and other tenants' data). We PARSE
// the YAML and inspect the structure: a line-based regex cannot be trusted (flow style `{privileged:
// true}`, flow sequences `["/:/host"]`, anchors/aliases, and `key=value` separators all defeat it).
// Curated templates and a user's own generic app are trusted; only a user composeOverride comes here.

// cap_add is an ALLOWLIST, not a blocklist: capability escapes are a moving target (CAP_BPF /
// CAP_PERFMON were split out of CAP_SYS_ADMIN in Linux 5.8, and more will follow), so we permit only
// a small set that is either already in Docker's default grant (adding it is a no-op) or is a common,
// harmless addition. Anything else — including any future dangerous cap — is rejected.
export const SAFE_CAPS = new Set([
  // Docker default set (adding these via cap_add is a no-op):
  "CHOWN", "DAC_OVERRIDE", "FSETID", "FOWNER", "MKNOD", "NET_RAW", "SETGID", "SETUID", "SETFCAP",
  "SETPCAP", "NET_BIND_SERVICE", "SYS_CHROOT", "KILL", "AUDIT_WRITE",
  // Common, non-escaping extras:
  "SYS_NICE", "IPC_LOCK",
]);

// Service-level keys that flow into host escapes and have no place in a fork-free template override:
// build (arbitrary build steps), extends (pulls in an unvalidated file), volumes_from/external_links
// (borrow another container's mounts/network), secrets/configs (file: binds a host file — see below),
// uts (`uts: host` shares the host UTS namespace).
const FORBIDDEN_SERVICE_KEYS = ["build", "extends", "volumes_from", "external_links", "secrets", "configs"];
// COMPOSE-from-git only: `build` IS legitimate (the stack builds its own checked-out source), so it is
// lifted out of the forbidden set and validated by checkBuild instead. The rest stay forbidden — and a
// rendered config never carries `extends` (compose inlines it) anyway.
const FORBIDDEN_SERVICE_KEYS_GIT = FORBIDDEN_SERVICE_KEYS.filter((k) => k !== "build");
// Tugra's own containers are named `tugra-<infra>` (tugra-proxy/agent/patch/cfd) and `tugra_<id>`
// (managed apps/DBs). A tenant compose that sets `container_name` to one of these could collide with — or
// impersonate — a Tugra-managed container (e.g. DoS the one-shot `tugra-patch` host-patch helper, or get a
// name-based lookup to resolve to the tenant's container). The prefix is reserved.
const RESERVED_CONTAINER_NAME = /^tugra[-_]/i;

// Host path prefixes whose bind-mount exposes the host filesystem / runtime to the container.
const SENSITIVE_PREFIXES = [
  "/etc", "/root", "/home", "/var/lib/docker", "/var/run", "/run", "/proc", "/sys", "/dev", "/boot",
  "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/srv", "/var",
];
// Ubiquitous, harmless single-file host mounts (timezone) — allowed despite sitting under /etc.
const SAFE_HOST_FILES = new Set(["/etc/localtime", "/etc/timezone"]);

/** A namespace directive that shares the host's OR another container's namespace — either escapes the
 *  container's isolation (`host`, `container:<id>`, `service:<name>`). */
function isDangerousNamespace(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return s === "host" || s.startsWith("container:") || s.startsWith("service:");
}
// `privileged` is the one boolean-typed escape, and the YAML lib (1.2 core schema) parses `yes/on/y`
// as STRINGS while docker-compose (compose-go) casts them to boolean true. So we reject the key unless
// it is UNAMBIGUOUSLY false — matching compose-go's toBoolean falsy grammar — rather than trusting a
// single "true" spelling.
function isNotFalse(v: unknown): boolean {
  if (v == null) return false; // absent → defaults to false
  // Coerce boolean / number / string uniformly, then treat only compose-go's falsy words as false.
  return !["false", "no", "off", "n", "0", "f"].includes(String(v).trim().toLowerCase());
}
function isTrue(v: unknown): boolean {
  return isNotFalse(v);
}
function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

/** True when `child` (an absolute path) resolves inside `root` (absolute). Canonicalizes both the way the
 *  kernel does (collapse `//`, resolve `.`/`..`) before the prefix test, so neither trailing slashes nor a
 *  `..` escape fools it. Non-absolute inputs (a named volume, a `${VAR}` that never rendered) are never
 *  "under" a root → the caller rejects them. */
export function isUnderRoot(child: string, root: string): boolean {
  const norm = (s: string) => posix.normalize(s.trim().replace(/\/{2,}/g, "/")).replace(/\/+$/, "") || "/";
  const c = norm(child);
  const r = norm(root);
  if (!posix.isAbsolute(c) || !posix.isAbsolute(r)) return false;
  return c === r || c.startsWith(`${r}/`);
}

export function isSensitivePath(raw: string): boolean {
  const src = raw.trim();
  // An env-interpolated source (`${VAR}` / `$VAR`) could smuggle a sensitive path via envOverride at
  // deploy time — a bind source must be a literal path, so reject any interpolation outright.
  if (/\$\{?\w/.test(src)) return true;
  // Canonicalize the way the kernel / compose-go do: collapse duplicate slashes and resolve `.`/`..`
  // so `//etc`, `/./etc`, `/a/../etc` all reduce to the real target before prefix-matching.
  const p = posix.normalize(src.replace(/\/{2,}/g, "/")).replace(/\/+$/, "") || "/";
  if (!posix.isAbsolute(p)) {
    // Not a host bind: a bare name is a named volume (safe). A RELATIVE path binds INSIDE the
    // Tugra-managed compose dir, which holds `.env` (ALL resolved secrets), the materialized config
    // mounts and the compose files. Reject a `..` traversal, the dir itself, and those sensitive
    // siblings; a bare named volume and a fresh relative subdir (e.g. `./data`) are still fine.
    if (p.startsWith("..")) return true;
    const first = p.split("/")[0];
    return p === "." || first === ".env" || first === "mounts" || /^docker-compose.*\.ya?ml$/.test(first);
  }
  if (SAFE_HOST_FILES.has(p)) return false;
  if (p === "/") return true;
  return SENSITIVE_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

function checkVolume(v: unknown, gitCloneRoot: string | null): void {
  let source: unknown;
  if (typeof v === "string") {
    // Short syntax with NO colon is an ANONYMOUS volume (the string is the CONTAINER path, e.g.
    // `- /var/lib/mysql`) — Docker manages it, there is no host source, so it is never a host bind.
    if (!v.includes(":")) return;
    source = v.split(":")[0];
  } else if (v && typeof v === "object") {
    // Long syntax: only a bind exposes a host path; a named volume / tmpfs / npipe does not.
    const type = (v as { type?: unknown }).type;
    if (type != null && type !== "bind") return;
    source = (v as { source?: unknown }).source;
  }
  if (typeof source !== "string" || source === "") return; // a named volume (no leading `/`) is fine
  if (source === "/var/run/docker.sock" || source === "/run/docker.sock" || /(^|\/)docker\.sock$/.test(source)) {
    throw disallowed("docker socket bind");
  }
  if (gitCloneRoot) {
    // Rendered git-compose: a bind may only reach the stack's OWN checked-out files, i.e. a path inside the
    // clone. A bare name (no leading `/` or `.`) is a docker-managed named volume → fine. Anything else — an
    // absolute path outside the clone, or an unresolved relative/`${VAR}` source — is a host reach → reject.
    if (!source.startsWith("/") && !source.startsWith(".")) return;
    if (isUnderRoot(source, gitCloneRoot)) return;
    throw disallowed(`bind of a path outside the build directory (${source})`);
  }
  if (isSensitivePath(source)) throw disallowed(`bind of sensitive host path ${source}`);
}

/** COMPOSE-from-git only: validate a service `build:` (rendered config normalizes it to an object with an
 *  absolute `context`). The context must stay inside the clone, and the build features that reach the host
 *  or its credentials (build secrets, ssh-agent forwarding, extra named contexts, the host build network)
 *  are refused — an untrusted stack builds only its own source, nothing more. */
function checkBuild(build: unknown, gitCloneRoot: string): void {
  if (build == null) return;
  if (typeof build === "string") {
    if (!isUnderRoot(build, gitCloneRoot)) throw disallowed(`build context outside the build directory (${build})`);
    return;
  }
  if (typeof build !== "object" || Array.isArray(build)) throw disallowed("build (unexpected shape)");
  const b = build as Record<string, unknown>;
  const ctx = b.context;
  if (typeof ctx === "string" && ctx !== "" && !isUnderRoot(ctx, gitCloneRoot)) {
    throw disallowed(`build context outside the build directory (${ctx})`);
  }
  if (b.secrets != null) throw disallowed("build.secrets (host build-secret mount)");
  if (b.ssh != null) throw disallowed("build.ssh (host ssh-agent forwarding)");
  if (b.additional_contexts != null) throw disallowed("build.additional_contexts (host/arbitrary context)");
  if (isDangerousNamespace(b.network)) throw disallowed("build.network host");
}

function checkService(svc: Record<string, unknown>, gitCloneRoot: string | null): void {
  if (isTrue(svc.privileged)) throw disallowed("privileged: true");
  if (typeof svc.container_name === "string" && RESERVED_CONTAINER_NAME.test(svc.container_name)) {
    throw disallowed(`container_name "${svc.container_name}" (the tugra-/tugra_ prefix is reserved for Tugra-managed containers)`);
  }
  if (isDangerousNamespace(svc.network_mode)) throw disallowed("network_mode host/container");
  if (isDangerousNamespace(svc.pid)) throw disallowed("pid host/container");
  if (isDangerousNamespace(svc.ipc)) throw disallowed("ipc host/container");
  if (isDangerousNamespace(svc.userns_mode)) throw disallowed("userns_mode host");
  if (isDangerousNamespace(svc.uts)) throw disallowed("uts host");
  // `cgroup: host` (--cgroupns=host) is the sixth namespace join — exposes the host cgroup hierarchy
  // and is the precondition for the cgroup-v1 release_agent escape. Distinct from `cgroup_parent`.
  if (isDangerousNamespace(svc.cgroup)) throw disallowed("cgroup host");
  if (svc.cgroup_parent != null) throw disallowed("cgroup_parent");
  if (toArray(svc.devices).length > 0) throw disallowed("devices (host device passthrough)");
  // device_cgroup_rules rewrites the container's device-cgroup allowlist; with Docker's default
  // CAP_MKNOD a rule like "a *:* rwm" / "b 8:0 rwm" lets the container mknod + read the host's raw disk.
  if (toArray(svc.device_cgroup_rules).length > 0) throw disallowed("device_cgroup_rules (host device access)");
  for (const key of gitCloneRoot ? FORBIDDEN_SERVICE_KEYS_GIT : FORBIDDEN_SERVICE_KEYS) {
    if (svc[key] != null) throw disallowed(key);
  }
  if (gitCloneRoot) checkBuild(svc.build, gitCloneRoot);
  for (const c of toArray(svc.cap_add)) {
    if (!SAFE_CAPS.has(String(c).toUpperCase().replace(/^CAP_/, ""))) {
      throw disallowed(`cap_add of a non-allowlisted capability ${String(c)}`);
    }
  }
  for (const o of toArray(svc.security_opt)) {
    // seccomp/apparmor/systempaths unconfined or SELinux label:disable → unmask host/kernel surfaces
    // (`:` or `=` separator).
    if (/(seccomp|apparmor|systempaths)\s*[:=]\s*unconfined|label\s*[:=]\s*disable/i.test(String(o))) {
      throw disallowed("security_opt disabling confinement");
    }
  }
  for (const v of toArray(svc.volumes)) checkVolume(v, gitCloneRoot);
}

/** Options for assertSafeCompose. */
export interface SafeComposeOpts {
  /** COMPOSE-from-git: the absolute clone directory the rendered config was produced in. When set, the
   *  input is treated as a rendered git stack — `build:` is allowed (its context must stay inside the clone)
   *  and bind SOURCES are confined to the clone instead of the host sensitive-path rules; when unset (a
   *  pasted/stored override) `build` is forbidden and binds are checked against the host rules. */
  gitCloneRoot?: string | null;
}

/** Throw BadRequestException if a user-supplied compose (override, or a rendered git stack) contains a
 *  host-escaping directive. */
export function assertSafeCompose(compose: string, opts: SafeComposeOpts = {}): void {
  const gitCloneRoot = opts.gitCloneRoot ?? null;
  let doc: unknown;
  try {
    // `merge: true` resolves YAML merge keys (`<<: *anchor`) the way docker-compose does, so a merged-in
    // `privileged`/etc. is visible to the structural check instead of hiding under a literal `<<` key.
    // maxAliasCount (yaml default 100) caps alias expansion → no billion-laughs DoS on hostile input.
    doc = parse(compose, { merge: true });
  } catch {
    throw new BadRequestException("compose override is not valid YAML");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new BadRequestException("compose override must be a compose mapping");
  }
  const services = (doc as { services?: unknown }).services;
  if (services && typeof services === "object" && !Array.isArray(services)) {
    for (const svc of Object.values(services)) {
      if (svc && typeof svc === "object" && !Array.isArray(svc)) checkService(svc as Record<string, unknown>, gitCloneRoot);
    }
  }
  // Top-level secrets/configs with `file:` bind a host file into the container (compose-go implements
  // file-based secrets as a read-only host bind). Overrides never legitimately need them → reject.
  const d = doc as Record<string, unknown>;
  if (d.secrets != null) throw disallowed("top-level secrets (host file bind)");
  if (d.configs != null) throw disallowed("top-level configs (host file bind)");
  // A top-level named volume can bind a host path via driver_opts (type: none, o: bind, device: /etc).
  // Git mode: the clone root itself lives under /etc/tugra, so the host sensitive-path rules can't apply —
  // the device must simply resolve inside the clone (anything else is a host reach).
  const volumes = (doc as { volumes?: unknown }).volumes;
  if (volumes && typeof volumes === "object" && !Array.isArray(volumes)) {
    for (const vol of Object.values(volumes)) {
      const device = (vol as { driver_opts?: { device?: unknown } } | null)?.driver_opts?.device;
      if (typeof device !== "string") continue;
      if (gitCloneRoot) {
        if (!isUnderRoot(device, gitCloneRoot)) throw disallowed(`bind of a path outside the build directory (${device})`);
      } else if (isSensitivePath(device)) {
        throw disallowed(`bind of sensitive host path ${device}`);
      }
    }
  }
}

function disallowed(what: string): BadRequestException {
  return new BadRequestException(`compose override contains a disallowed directive: ${what}`);
}
