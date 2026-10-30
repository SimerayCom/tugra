/**
 * Pure builders for deploying a COMPOSE app whose docker-compose.yml lives in a git repo (source=COMPOSE
 * + gitUrl + composePath) instead of being pasted/stored on the hub.
 *
 * The flow is deliberately two-step so the hub can validate what actually runs:
 *   1. RENDER  (buildComposeGitRenderScript): clone the repo, run `docker compose config` to fully resolve
 *      the stack (interpolation, extends, relative paths → absolute), and echo it back base64 + its sha256.
 *      The hub then runs assertSafeCompose() over that rendered YAML (with the clone as the allowed root).
 *   2. UP      (buildComposeGitUpScript): re-clone the SAME branch, re-render, and refuse to run unless the
 *      sha matches the one the hub validated (a TOCTOU lock — the repo must not have changed in between),
 *      then `docker compose up -d --build --force-recreate`.
 *
 * A symlink-escape guard runs after each clone: lexical containment on the hub cannot see symlinks, so a
 * `build: ./app` (or a bind) where `app` is a symlink to `/` would still reach the host — the guard resolves
 * every symlink in the clone and refuses the deploy if any points outside it.
 */

import { createHash } from "node:crypto";
import {
  gitCloneSteps,
  registryLoginPrelude,
  registryLogoutSteps,
  envFileB64,
  certPreludeFor,
  type AppSpec,
} from "./deploy-script";
import { composeOverride, composeProject, composeGitDir, composeGitCloneDir, composeOpFile } from "./compose-script";

// Re-export the shared path helpers (defined in compose-script.ts so the lifecycle builders there can reuse
// them without a circular import) for this module's callers and tests.
export { composeGitDir, composeGitCloneDir } from "./compose-script";

export const COMPOSE_RENDERED_MARKER = "TUGRA_COMPOSE_RENDERED_B64=";
export const COMPOSE_SHA_MARKER = "TUGRA_COMPOSE_SHA=";

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}
function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

/** The compose file to pass to `-f`: the clone root joined with the repo-relative composePath (validated by
 *  REPO_PATH at the DTO boundary; shell-quoted at each use as defense-in-depth). */
function composeFileArg(app: AppSpec): string {
  return composeOpFile(app);
}

/** Refuse the deploy if any symlink in the clone resolves outside it (host-reach via a build context or a
 *  bind). Uses readlink -f / realpath (fail-closed if the agent has neither). `$CLONE` is set by the caller. */
function symlinkGuardSteps(): string[] {
  return [
    `command -v readlink >/dev/null 2>&1 || command -v realpath >/dev/null 2>&1 || { echo "TUGRA: this agent lacks readlink/realpath — update it to deploy a git compose stack"; exit 1; }`,
    `CLONE_REAL=$(cd "$CLONE" && pwd -P)`,
    `if find "$CLONE" -type l -exec sh -c 'root=$1; shift; for l do t=$(readlink -f "$l" 2>/dev/null) || t=$(realpath "$l" 2>/dev/null) || t=; case "\${t:-/dev/null}/" in "$root"/*) ;; *) exit 7;; esac; done' _ "$CLONE_REAL" {} +; then :; else echo "TUGRA: a repository symlink points outside the clone — refusing to deploy a git compose stack"; exit 1; fi`,
  ];
}

/** Shared head: clone into `$CLONE`, run the symlink guard, and (when the app has env) write the resolved
 *  .env OUTSIDE the clone. Used by both the render and up scripts so they produce an identical rendered
 *  config (same clone, same env → same sha). */
function cloneAndEnvSteps(app: AppSpec): { lines: string[]; envArg: string } {
  const clone = composeGitCloneDir(app);
  const env = app.env && typeof app.env === "object" ? app.env : {};
  const hasEnv = Object.keys(env).length > 0;
  const envPath = `${composeGitDir(app)}/.env`;
  const lines = [
    "set -e",
    `mkdir -p ${composeGitDir(app)}`,
    `CLONE=${clone}`,
    ...gitCloneSteps(app, clone),
    ...symlinkGuardSteps(),
  ];
  if (hasEnv) {
    lines.push(
      `printf %s ${shq(envFileB64(env))} | base64 -d > ${envPath}`,
      `chmod 600 ${envPath}`,
    );
  }
  return { lines, envArg: hasEnv ? `--env-file ${envPath} ` : "" };
}

/** The `docker compose config` invocation that renders the stack. `2>/dev/null` keeps compose's warnings
 *  off stdout so only the canonical YAML is captured. */
function renderExpr(app: AppSpec, envArg: string): string {
  const proj = composeProject(app);
  return `docker compose -p ${proj} -f ${shq(composeFileArg(app))} ${envArg}config 2>/dev/null`;
}

/**
 * Step 1 — clone + render. Emits the rendered compose (base64, single line) and its sha256 as markers the
 * hub parses with parseRenderedCompose(). The commit markers from gitCloneSteps precede these, so the same
 * output also carries the deployed commit for the deployment record.
 */
export function buildComposeGitRenderScript(app: AppSpec): string {
  const { lines, envArg } = cloneAndEnvSteps(app);
  lines.push(
    `TUGRA_RENDERED=$(${renderExpr(app, envArg)})`,
    `[ -n "$TUGRA_RENDERED" ] || { echo "TUGRA: docker compose could not render ${shq(composeFileArg(app))} — check the compose path and the file's validity"; exit 1; }`,
    `printf '%s%s\\n' "${COMPOSE_RENDERED_MARKER}" "$(printf %s "$TUGRA_RENDERED" | base64 | tr -d '\\n')"`,
    `printf '%s%s\\n' "${COMPOSE_SHA_MARKER}" "$(printf %s "$TUGRA_RENDERED" | sha256sum | cut -d' ' -f1)"`,
  );
  return lines.join("\n");
}

/**
 * Step 2 — clone + re-render + sha-lock + up. Refuses to run unless the freshly-rendered sha matches
 * `sha` (the digest the hub already validated), then brings the stack up (building from the clone). When
 * the app has per-service domains, the Tugra routing override is layered with a second `-f`.
 */
export function buildComposeGitUpScript(app: AppSpec, sha: string, noCache = false): string {
  const { lines, envArg } = cloneAndEnvSteps(app);
  const proj = composeProject(app);
  const file = composeFileArg(app);
  const rows = app.serviceDomains ?? [];
  const writeOverride = rows.length > 0;
  const overridePath = `${composeGitDir(app)}/override.yml`;
  lines.push(
    `TUGRA_RENDERED=$(${renderExpr(app, envArg)})`,
    `TUGRA_SHA=$(printf %s "$TUGRA_RENDERED" | sha256sum | cut -d' ' -f1)`,
    // TOCTOU lock: the repo must still render to exactly what the hub validated. A mismatch means the branch
    // moved (or the render was non-deterministic) between validation and run → refuse rather than run unvetted.
    `[ "$TUGRA_SHA" = ${shq(sha)} ] || { echo "TUGRA: the repository changed since it was validated (compose digest mismatch) — redeploy to re-validate"; exit 1; }`,
    ...certPreludeFor(app),
  );
  if (writeOverride) {
    lines.push(`printf %s ${shq(b64(composeOverride(app)))} | base64 -d > ${overridePath}`);
  }
  lines.push(...registryLoginPrelude(app.registryAuth));
  const overrideArg = writeOverride ? `-f ${overridePath} ` : "";
  lines.push(
    `docker compose --progress plain -p ${proj} -f ${shq(file)} ${overrideArg}${envArg}up -d --build ${noCache ? "--pull always --no-cache " : ""}--force-recreate --remove-orphans`,
    ...registryLogoutSteps(app.registryAuth),
    `docker compose -p ${proj} -f ${shq(file)} ${overrideArg}ps`,
  );
  return lines.join("\n");
}

/** Parse the render script's markers out of the agent output: the rendered compose YAML (decoded) and its
 *  sha256. Returns null if either marker is missing/malformed (fail-closed — the caller refuses to deploy). */
export function parseRenderedCompose(output: string): { compose: string; sha: string } | null {
  const b64Line = firstMarker(output, COMPOSE_RENDERED_MARKER);
  const shaLine = firstMarker(output, COMPOSE_SHA_MARKER);
  if (!b64Line || !shaLine) return null;
  if (!/^[0-9a-f]{64}$/.test(shaLine)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64Line)) return null;
  let compose: string;
  try {
    compose = Buffer.from(b64Line, "base64").toString("utf8");
  } catch {
    return null;
  }
  if (!compose) return null;
  // Defense-in-depth: the sha the hub locks on MUST be the digest of the exact bytes it validated, so verify
  // the decoded YAML hashes to the reported sha (a tampered/truncated transport is then caught here).
  if (createHash("sha256").update(compose, "utf8").digest("hex") !== shaLine) return null;
  return { compose, sha: shaLine };
}

/** The value of the first `MARKER=...` line in the output (anchored at a line start). */
function firstMarker(output: string, marker: string): string | null {
  for (const line of output.split("\n")) {
    const t = line.trim();
    if (t.startsWith(marker)) return t.slice(marker.length).trim();
  }
  return null;
}
