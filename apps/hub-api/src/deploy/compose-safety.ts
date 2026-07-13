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
const SAFE_CAPS = new Set([
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

function isSensitivePath(raw: string): boolean {
  const src = raw.trim();
  // An env-interpolated source (`${VAR}` / `$VAR`) could smuggle a sensitive path via envOverride at
  // deploy time — a bind source must be a literal path, so reject any interpolation outright.
  if (/\$\{?\w/.test(src)) return true;
  // Canonicalize the way the kernel / compose-go do: collapse duplicate slashes and resolve `.`/`..`
  // so `//etc`, `/./etc`, `/a/../etc` all reduce to the real target before prefix-matching.
  const p = posix.normalize(src.replace(/\/{2,}/g, "/")).replace(/\/+$/, "") || "/";
  if (!posix.isAbsolute(p)) {
    // Not a host bind: a bare name is a named volume (safe). A relative path that climbs out of the
    // (Tugra-managed) compose dir with `..` is a traversal → reject; a contained `./data` is fine.
    return p.startsWith("..");
  }
  if (SAFE_HOST_FILES.has(p)) return false;
  if (p === "/") return true;
  return SENSITIVE_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

function checkVolume(v: unknown): void {
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
  if (isSensitivePath(source)) throw disallowed(`bind of sensitive host path ${source}`);
}

function checkService(svc: Record<string, unknown>): void {
  if (isTrue(svc.privileged)) throw disallowed("privileged: true");
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
  for (const key of FORBIDDEN_SERVICE_KEYS) {
    if (svc[key] != null) throw disallowed(key);
  }
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
  for (const v of toArray(svc.volumes)) checkVolume(v);
}

/** Throw BadRequestException if a user-supplied compose override contains a host-escaping directive. */
export function assertSafeCompose(compose: string): void {
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
      if (svc && typeof svc === "object" && !Array.isArray(svc)) checkService(svc as Record<string, unknown>);
    }
  }
  // Top-level secrets/configs with `file:` bind a host file into the container (compose-go implements
  // file-based secrets as a read-only host bind). Overrides never legitimately need them → reject.
  const d = doc as Record<string, unknown>;
  if (d.secrets != null) throw disallowed("top-level secrets (host file bind)");
  if (d.configs != null) throw disallowed("top-level configs (host file bind)");
  // A top-level named volume can bind a host path via driver_opts (type: none, o: bind, device: /etc).
  const volumes = (doc as { volumes?: unknown }).volumes;
  if (volumes && typeof volumes === "object" && !Array.isArray(volumes)) {
    for (const vol of Object.values(volumes)) {
      const device = (vol as { driver_opts?: { device?: unknown } } | null)?.driver_opts?.device;
      if (typeof device === "string" && isSensitivePath(device)) {
        throw disallowed(`bind of sensitive host path ${device}`);
      }
    }
  }
}

function disallowed(what: string): BadRequestException {
  return new BadRequestException(`compose override contains a disallowed directive: ${what}`);
}
