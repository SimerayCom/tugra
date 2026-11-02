import { BadRequestException } from "@nestjs/common";
import { SAFE_CAPS, isSensitivePath } from "./compose-safety";
import { tokenizeDockerOptions, type HostMount } from "./deploy-script";

/** Max host bind-mounts per app — a sane cap so one app can't attach an unbounded number of host dirs. */
export const MAX_HOST_MOUNTS = 20;

/**
 * Validate an app's structured host bind-mounts (the friendly "Host folders" UI) with the SAME safety bar
 * the free-form dockerOptions `-v` path already enforces: each source must be an absolute host path that is
 * NOT the docker socket and NOT a sensitive system path (isSensitivePath also rejects `..`, `${}` and
 * normalizes `/./`, `//`). A `:` is rejected in either path so docker's `-v host:ctr[:ro]` parse stays
 * unambiguous. Returns the cleaned list (trimmed, readOnly coerced to a real boolean); throws on any
 * violation so a bad mount fails with a clear 400 now, not a broken deploy later.
 */
export function validateHostMounts(mounts: unknown): HostMount[] {
  if (mounts == null) return [];
  if (!Array.isArray(mounts)) throw new BadRequestException("hostMounts must be a list");
  if (mounts.length > MAX_HOST_MOUNTS) throw new BadRequestException(`at most ${MAX_HOST_MOUNTS} host folders per app`);
  const okPath = (p: string) => typeof p === "string" && p.startsWith("/") && !p.includes(":") && !/[\s\n\r]/.test(p) && p.length <= 1024;
  return mounts.map((raw) => {
    const m = (raw ?? {}) as { hostPath?: unknown; containerPath?: unknown; readOnly?: unknown };
    const hostPath = typeof m.hostPath === "string" ? m.hostPath.trim() : "";
    const containerPath = typeof m.containerPath === "string" ? m.containerPath.trim() : "";
    if (!okPath(hostPath)) throw new BadRequestException(`host path must be an absolute path without ':' — got "${hostPath}"`);
    if (!okPath(containerPath)) throw new BadRequestException(`container path must be an absolute path without ':' — got "${containerPath}"`);
    if (isDockerSock(hostPath)) throw new BadRequestException("the docker socket cannot be mounted");
    if (isSensitivePath(hostPath)) throw new BadRequestException(`host path ${hostPath} is a protected system path`);
    return { hostPath, containerPath, readOnly: m.readOnly !== false }; // default read-only (safer for media)
  });
}

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
  "-v", "--volume", "--volumes-from", "--mount", "--device", "--device-cgroup-rule", "--cap-add",
  "--network", "--net", "--pid", "--ipc", "--uts", "--userns", "--cgroupns",
  "--security-opt", "--cgroup-parent", "--label", "-l",
]);

// docker-run short flags, split by whether they take a value (pflag semantics). Only `-v`/`-l` are gated,
// but we must parse the WHOLE short-flag cluster to know whether a `v`/`l` sits at a flag position (a real
// `-v`/`-l`) or inside another flag's attached value. A boolean short is consumed and parsing continues; a
// value short owns the rest of the token as its value and ends the cluster; an unknown short letter fails
// closed (we can't prove a later `-v`/`-l` isn't a live flag).
const BOOL_SHORTS = new Set(["d", "i", "t", "P"]);
const VALUE_SHORTS = new Set(["a", "c", "e", "h", "l", "m", "p", "u", "v", "w"]);

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

export function assertSafeDockerOptions(raw: string | null | undefined, opts: { allowPrivileged?: boolean } = {}): void {
  if (!raw || !raw.trim()) return;
  // Host-escape / privilege class is RELAXED only when the INSTANCE OWNER opted this app in
  // (Application.allowPrivilegedDockerOptions). The owner owns the box, so --privileged/--device/--cap-add/
  // host namespaces/host binds/docker.sock/--security-opt are their call. The Tugra-integrity class below
  // (traefik.* labels, --label-file, --name, --env-file) stays blocked REGARDLESS — those hijack Tugra's
  // own routing/naming or read arbitrary host files, not a "my own box" prerogative (separate Dilim-2).
  const allow = opts.allowPrivileged === true;
  let tokens: string[];
  try {
    tokens = tokenizeDockerOptions(raw);
  } catch {
    throw new BadRequestException("dockerOptions has an unterminated quote");
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("-")) continue; // a bare value / positional — not a flag we gate
    if (tok === "-") continue; // a lone dash is not a flag
    let name: string;
    let value: string | undefined;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      name = eq === -1 ? tok : tok.slice(0, eq);
      value = eq === -1 ? undefined : tok.slice(eq + 1);
    } else {
      // Single-dash short flag (or cluster). pflag accepts an ATTACHED value (`-v/data`, `-ltraefik.x=y`)
      // and short-flag bundling (`-itv/data`), so a naive `slice(0,'=')` split lets a gated short flag
      // smuggle its value past the switch (e.g. `-v/:/host` had name `-v/:/host`, matching no case). Walk
      // the cluster per pflag rules; fail closed on anything we can't resolve.
      const body = tok.slice(1);
      name = tok; // default: no value-taking short found (all-boolean cluster) → matches no gated case
      value = undefined;
      for (let j = 0; j < body.length; j++) {
        const ch = body[j];
        if (BOOL_SHORTS.has(ch)) continue; // boolean flag, keep scanning the cluster
        if (VALUE_SHORTS.has(ch)) {
          name = `-${ch}`;
          let rest = body.slice(j + 1);
          if (rest.startsWith("=")) rest = rest.slice(1); // `-v=/foo` attached-with-equals
          value = rest === "" ? undefined : rest;
          break; // this value short owns the remainder; cluster ends
        }
        throw disallowed(`unrecognized short flag "-${ch}" in "${tok}" — use the explicit --flag form`);
      }
    }
    // `--flag value` form: pull the next token as the value (docker requires one; a following flag means
    // the value is absent, which docker would reject anyway).
    if (value === undefined && VALUE_FLAGS.has(name) && i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
      value = tokens[++i];
    }
    const val = value ?? "";

    switch (name) {
      // ---- host-escape / privilege class: relaxed when `allow` (owner opted in) ----
      case "--privileged":
        if (allow) break;
        throw disallowed("--privileged");
      case "--cgroup-parent":
        if (allow) break;
        throw disallowed("--cgroup-parent");
      case "--device":
        if (allow) break;
        throw disallowed("--device (host device passthrough)");
      case "--device-cgroup-rule":
        if (allow) break;
        throw disallowed("--device-cgroup-rule (host device access)");
      case "--network":
      case "--net":
        if (allow) break;
        if (dangerousNamespace(val)) throw disallowed(`${name} host/container`);
        break;
      case "--pid":
      case "--ipc":
      case "--uts":
        if (allow) break;
        if (dangerousNamespace(val)) throw disallowed(`${name} host/container`);
        break;
      case "--userns":
      case "--cgroupns":
        if (allow) break;
        if (val.trim().toLowerCase() === "host") throw disallowed(`${name} host`);
        break;
      case "--cap-add":
        if (allow) break;
        if (!SAFE_CAPS.has(val.trim().toUpperCase().replace(/^CAP_/, ""))) {
          throw disallowed(`--cap-add of a non-allowlisted capability ${val}`);
        }
        break;
      case "--volumes-from":
        if (allow) break;
        // Mounts ALL of another container's volumes into this one. Tugra's own managed containers (and the
        // agent) may carry docker.sock / sensitive host binds, so borrowing them is a host escape. There is
        // no safe sub-case to carve out — block the whole flag unless the owner opted in.
        throw disallowed("--volumes-from (inherits another container's mounts, incl. the agent's)");
      case "-v":
      case "--volume":
        if (allow) break;
        // short syntax: source[:target[:opts]] — a bare name (no leading /) is a named volume (safe).
        checkVolumeSource(val.split(":")[0], "bind");
        break;
      case "--mount": {
        if (allow) break;
        // CSV key=value list. The `type=` field is NOT trusted to decide whether to check: it can be cased
        // (Type=bind), duplicated (type=volume,type=bind) or omitted to dodge a type-gated check. Instead
        // check EVERY source/src value (case-insensitive, quote-tolerant) with checkVolumeSource — a named
        // volume isn't an absolute path so it no-ops, while any bind of a sensitive host path / docker.sock
        // throws regardless of the declared type.
        const re = /(?:^|,)\s*(?:source|src)\s*=\s*"?([^,"]*)"?/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(val)) !== null) checkVolumeSource(m[1].trim(), "mount");
        break;
      }
      case "--security-opt":
        if (allow) break;
        if (/(seccomp|apparmor|systempaths)\s*[:=]\s*unconfined|label\s*[:=]\s*disable/i.test(val)) {
          throw disallowed("--security-opt disabling confinement");
        }
        break;
      // ---- Tugra-integrity / cross-tenant class: ALWAYS blocked, even with `allow` ----
      case "--label":
      case "-l":
        // Tugra owns the `traefik.*` label namespace — it is how ingress routing/middleware is wired on the
        // shared proxy network. A user-supplied `traefik.*` label is additive at `docker run`, so a member
        // with `apps:config` could declare a NEW router (`traefik.http.routers.x.rule=Host(`victim.com`)`)
        // that points ANOTHER team's hostname at their own container — a cross-tenant ingress hijack. Block
        // the namespace; non-traefik labels (monitoring, metadata) stay allowed.
        if (val.split("=")[0].trim().toLowerCase().startsWith("traefik.")) {
          throw disallowed("--label in the traefik.* namespace (would hijack shared ingress routing)");
        }
        break;
      case "--label-file":
        // Labels from an unvalidated host file would bypass the traefik.* check above.
        throw disallowed("--label-file (labels from an unvalidated file could inject traefik routing)");
      case "--name":
        // The container name is managed by Tugra and is the key for every lifecycle op (stop/logs/health/
        // remove) and the Traefik service binding. Overriding it detaches the app from its own controls and
        // lets one app squat another's managed name.
        throw disallowed("--name (the container name is managed by Tugra)");
      case "--env-file":
        // `docker run --env-file <path>` reads a host file into the container env at run time, so an
        // arbitrary path (e.g. an agent-host secrets file) would be disclosed into the app's environment.
        throw disallowed("--env-file (could read an arbitrary host file into the container env)");
    }
  }
}
