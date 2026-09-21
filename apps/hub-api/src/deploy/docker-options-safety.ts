import { BadRequestException } from "@nestjs/common";
import { SAFE_CAPS, isSensitivePath } from "./compose-safety";
import { tokenizeDockerOptions } from "./deploy-script";

/**
 * Structural safety check for an app's free-form `dockerOptions` (advanced `docker run` flags on IMAGE/GIT
 * apps). Shell INJECTION is already neutralized by dockerOptionsArgs (tokenize + shell-quote per word) —
 * but a value that is a LEGITIMATE docker flag still runs verbatim, and flags like `--privileged`,
 * `-v /:/host`, a docker.sock bind, host namespaces, host devices or `--cap-add=ALL` let a team member
 * escape the container and take over the shared host. Compose overrides already get this class of check
 * (compose-safety.ts); this is the `docker run` equivalent, reusing the same allowlist/denylist so an
 * `apps:config` member cannot grant themselves host root. Throws BadRequestException on a disallowed flag
 * (or an unterminated quote — fail closed).
 */

// Flags that consume a value (either `--flag=value` or `--flag value`).
const VALUE_FLAGS = new Set([
  "-v", "--volume", "--mount", "--device", "--device-cgroup-rule", "--cap-add",
  "--network", "--net", "--pid", "--ipc", "--uts", "--userns", "--cgroupns",
  "--security-opt", "--cgroup-parent",
]);

function dangerousNamespace(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === "host" || s.startsWith("container:");
}

function isDockerSock(source: string): boolean {
  return source === "/var/run/docker.sock" || source === "/run/docker.sock" || /(^|\/)docker\.sock$/.test(source);
}

function checkVolumeSource(source: string, what: string): void {
  if (!source) return;
  if (isDockerSock(source)) throw disallowed("docker socket bind");
  if (isSensitivePath(source)) throw disallowed(`${what} of sensitive host path ${source}`);
}

function disallowed(what: string): BadRequestException {
  return new BadRequestException(`dockerOptions contains a disallowed flag: ${what}`);
}

export function assertSafeDockerOptions(raw: string | null | undefined): void {
  if (!raw || !raw.trim()) return;
  let tokens: string[];
  try {
    tokens = tokenizeDockerOptions(raw);
  } catch {
    throw new BadRequestException("dockerOptions has an unterminated quote");
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("-")) continue; // a bare value / positional — not a flag we gate
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok : tok.slice(0, eq);
    let value = eq === -1 ? undefined : tok.slice(eq + 1);
    // `--flag value` form: pull the next token as the value (docker requires one; a following flag means
    // the value is absent, which docker would reject anyway).
    if (value === undefined && VALUE_FLAGS.has(name) && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
      value = tokens[++i];
    }
    const val = value ?? "";

    switch (name) {
      case "--privileged":
        throw disallowed("--privileged");
      case "--cgroup-parent":
        throw disallowed("--cgroup-parent");
      case "--device":
        throw disallowed("--device (host device passthrough)");
      case "--device-cgroup-rule":
        throw disallowed("--device-cgroup-rule (host device access)");
      case "--network":
      case "--net":
        if (dangerousNamespace(val)) throw disallowed(`${name} host/container`);
        break;
      case "--pid":
      case "--ipc":
      case "--uts":
        if (dangerousNamespace(val)) throw disallowed(`${name} host/container`);
        break;
      case "--userns":
      case "--cgroupns":
        if (val.trim().toLowerCase() === "host") throw disallowed(`${name} host`);
        break;
      case "--cap-add":
        if (!SAFE_CAPS.has(val.trim().toUpperCase().replace(/^CAP_/, ""))) {
          throw disallowed(`--cap-add of a non-allowlisted capability ${val}`);
        }
        break;
      case "-v":
      case "--volume":
        // short syntax: source[:target[:opts]] — a bare name (no leading /) is a named volume (safe).
        checkVolumeSource(val.split(":")[0], "bind");
        break;
      case "--mount": {
        // key=value,comma-separated — a bind exposes a host path via source=/src=.
        const type = /(?:^|,)type=([^,]*)/.exec(val)?.[1]?.trim().toLowerCase();
        if (type && type !== "bind") break; // volume/tmpfs/npipe don't expose a host path
        const src = /(?:^|,)(?:source|src)=([^,]*)/.exec(val)?.[1] ?? "";
        checkVolumeSource(src, "mount");
        break;
      }
      case "--security-opt":
        if (/(seccomp|apparmor|systempaths)\s*[:=]\s*unconfined|label\s*[:=]\s*disable/i.test(val)) {
          throw disallowed("--security-opt disabling confinement");
        }
        break;
    }
  }
}
