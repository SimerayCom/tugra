import { SHA256_HEX } from "./update-manifest";

/**
 * Shell for the hub's "converge the local stack" step, run on the LOCAL agent (the one container besides the updater
 * that has docker.sock, and the only one that survives the hub being recreated). Pure string builders + parsers, so
 * the decisions and the exact commands are unit-tested without docker.
 *
 * WHY THIS EXISTS: the updater sidecar runs the checkout's scripts/update.sh. An install that was last installed on a
 * release before the updater learned to refresh itself (and to apply a release's compose/scripts) keeps an old
 * updater image AND an old update.sh forever: those old scripts ignore the job's host-files digest and never recreate
 * the updater, so only an operator running scripts/install.sh by hand could ever bring it forward. After an update
 * the NEW hub notices the lag and, once per release and never mid-job, asks the local agent to run the script below.
 *
 * What the script does (each step only when needed):
 *   1. pulls the release's updater image (by the signed INDEX digest when the verified manifest carries one) and
 *      the bundled agent image (by the signed per-arch manifest digest — never the tag's index, whose attestation
 *      entries are what `docker compose pull` choked on, see scripts/lib/images.sh); both must carry the release's
 *      version label; the tag the compose file resolves is pointed at them;
 *   2. in the NEW updater image (which bakes the scripts of its release) runs the one-shot
 *      `update.sh --apply-host-files <version> <digest>` against the checkout: signature + hash verified, backed up,
 *      validated, atomically replaced — the same code path as an in-app update;
 *   3. starts a detached one-shot helper (the new updater image has docker + compose) that, a few seconds later,
 *      recreates ONLY the lagging services with `up -d --no-deps` — a container cannot recreate itself, and the agent
 *      running this very script is one of the targets.
 */

/** The compose project the hub stack runs under (same default the hub backup uses). */
export const DEFAULT_COMPOSE_PROJECT = "tugra";
export const UPDATER_IMAGE_REPO = "ghcr.io/simeraycom/tugra-updater";
export const AGENT_IMAGE_REPO = "ghcr.io/simeraycom/tugra-agent";
export const VERSION_LABEL = "org.opencontainers.image.version";

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]*$/;
const REPO_RE = /^[a-z0-9][a-z0-9._-]*(:[0-9]+)?(\/[a-z0-9._-]+)+$/;

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

function assertSafe(project: string, version?: string, repos: string[] = [], digests: Array<string | undefined> = []): void {
  if (!PROJECT_RE.test(project)) throw new Error("invalid compose project name");
  if (version !== undefined && (version.length > 64 || !VERSION_RE.test(version))) throw new Error("invalid release version");
  for (const r of repos) if (r.length > 200 || !REPO_RE.test(r)) throw new Error("invalid image repository");
  for (const d of digests) if (d !== undefined && !SHA256_HEX.test(d)) throw new Error("invalid digest");
}

/** `CID=…` of the updater container of the project, shared by the probe and the refresh script. */
function findUpdater(project: string): string[] {
  return [
    `P=${shq(project)}`,
    `CID="$(docker ps -aq --filter "label=com.docker.compose.project=$P" --filter "label=com.docker.compose.service=tugra-updater" | head -n1)"`,
  ];
}

/** Read-only: what version is the updater container running? One `TUGRA_PROBE key=value` line per fact. */
export function buildProbeScript(project: string): string {
  assertSafe(project);
  return [
    "set -u",
    ...findUpdater(project),
    `if [ -z "$CID" ]; then echo "TUGRA_PROBE updater=absent"; exit 0; fi`,
    `echo "TUGRA_PROBE updater=present"`,
    `echo "TUGRA_PROBE version=$(docker inspect -f '{{index .Config.Labels "${VERSION_LABEL}"}}' "$CID" 2>/dev/null | tr -d '\\r\\n')"`,
    `echo "TUGRA_PROBE image=$(docker inspect -f '{{.Config.Image}}' "$CID" 2>/dev/null | tr -d '\\r\\n')"`,
    `echo "TUGRA_PROBE running=$(docker inspect -f '{{.State.Running}}' "$CID" 2>/dev/null | tr -d '\\r\\n')"`,
  ].join("\n");
}

export interface StackProbe {
  present: boolean;
  /** The release the updater container runs, from its image's version label (or a version-looking tag). */
  version: string | null;
  image: string | null;
  running: boolean;
}

const SAFE_VALUE = /^[A-Za-z0-9._:/@+,-]*$/;
const PLAIN_VERSION = /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$/;

/** Parse the probe output. Anything unexpected yields "unknown" (version null), never a guess. */
export function parseProbeOutput(out: string): StackProbe {
  const kv: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^TUGRA_PROBE ([a-z]+)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]] = SAFE_VALUE.test(m[2]) ? m[2] : "";
  }
  const present = kv.updater === "present";
  if (!present) return { present: false, version: null, image: null, running: false };
  const image = kv.image || null;
  let version: string | null = kv.version && kv.version !== "<no value>" ? kv.version : null;
  if (!version && image) {
    const tag = image.includes("@") ? undefined : /:([^:/]+)$/.exec(image)?.[1];
    if (tag && PLAIN_VERSION.test(tag)) version = tag;
  }
  return { present: true, version: version && PLAIN_VERSION.test(version) ? version.replace(/^v/, "") : null, image, running: kv.running === "true" };
}

export interface ConvergeInputs {
  /** The running hub release. */
  own: string;
  /** What the updater container runs (null = unknown or absent). */
  updaterVersion: string | null;
  updaterPresent: boolean;
  /** The local agent's reported version (null = unknown). */
  agentVersion: string | null;
}

/** Is `candidate` strictly older than `own`? Unparseable on either side = not behind (never act on a guess). */
export type IsBehind = (own: string, other: string | null) => boolean;

export interface ConvergeDecision {
  refreshUpdater: boolean;
  refreshAgent: boolean;
}

/** What needs to move onto the hub's release. Pure. */
export function decideConverge(i: ConvergeInputs, isBehind: IsBehind): ConvergeDecision {
  return {
    refreshUpdater: i.updaterPresent && isBehind(i.own, i.updaterVersion),
    refreshAgent: isBehind(i.own, i.agentVersion),
  };
}

export interface RefreshPlan {
  project: string;
  /** The hub's own release: what every pulled image must be labelled with. */
  version: string;
  refreshUpdater: boolean;
  refreshAgent: boolean;
  /** Signed INDEX digest of the updater image (bare hex), when the verified manifest is for this release. */
  updaterDigest?: string;
  /** Signed per-platform manifest digest of the agent image for the local engine's arch (bare hex). */
  agentDigest?: string;
  /** Signed host-files digest: when present the checkout's compose/scripts are brought to the release too. */
  hostFilesDigest?: string;
  updaterRepo?: string;
  agentRepo?: string;
}

/** The compose services the detached helper recreates. */
export function plannedServices(p: Pick<RefreshPlan, "refreshUpdater" | "refreshAgent">): string[] {
  return [...(p.refreshUpdater ? ["tugra-updater"] : []), ...(p.refreshAgent ? ["agent"] : [])];
}

/**
 * The refresh script (bash). Exit codes: 0 helper scheduled, 3 the install cannot be handled (no updater container /
 * no checkout path), 4 a pull or label check failed (nothing was changed). Each outcome prints a `TUGRA_STEP` line.
 */
export function buildRefreshScript(plan: RefreshPlan): string {
  const updaterRepo = plan.updaterRepo ?? UPDATER_IMAGE_REPO;
  const agentRepo = plan.agentRepo ?? AGENT_IMAGE_REPO;
  assertSafe(plan.project, plan.version, [updaterRepo, agentRepo], [plan.updaterDigest, plan.agentDigest, plan.hostFilesDigest]);
  const services = plannedServices(plan);
  if (services.length === 0) throw new Error("nothing to refresh");
  // The agent is only ever pulled by its signed per-platform digest: the tag's index is exactly what failed to pull.
  if (plan.refreshAgent && !plan.agentDigest) throw new Error("the agent refresh needs a signed platform digest");

  const lines: string[] = [
    "set -u",
    `VERSION=${shq(plan.version)}`,
    `UPD_REPO=${shq(updaterRepo)}`,
    `AGENT_REPO=${shq(agentRepo)}`,
    ...findUpdater(plan.project),
    `[ -n "$CID" ] || { echo "TUGRA_STEP error=no-updater-container"; exit 3; }`,
    `SRC="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' "$CID" 2>/dev/null | tr -d '\\r\\n')"`,
    `case "$SRC" in /*) ;; *) echo "TUGRA_STEP error=no-checkout-path"; exit 3 ;; esac`,
    // pull_release <repo> <digest-or-empty>: by signed digest + label check + local tag, else a plain tag pull.
    `pull_release() {`,
    `  repo="$1"; d="$2"`,
    `  if [ -n "$d" ]; then`,
    `    docker pull "$repo@sha256:$d" >/dev/null 2>&1 || return 1`,
    `    have="$(docker image inspect -f '{{index .Config.Labels "${VERSION_LABEL}"}}' "$repo@sha256:$d" 2>/dev/null | tr -d '[:space:]')"`,
    `    [ "\${have#v}" = "\${VERSION#v}" ] || { echo "TUGRA_STEP error=version-mismatch:$repo:\${have:-none}"; return 1; }`,
    `    id="$(docker image inspect -f '{{.Id}}' "$repo@sha256:$d" 2>/dev/null | tr -d '[:space:]')"`,
    `    [ -n "$id" ] && docker tag "$id" "$repo:$VERSION"`,
    `  else`,
    `    docker pull "$repo:$VERSION" >/dev/null 2>&1`,
    `  fi`,
    `}`,
    // The updater image first: it is also the helper's image and carries the host-files bootstrap.
    `pull_release "$UPD_REPO" ${shq(plan.updaterDigest ?? "")} || { echo "TUGRA_STEP error=pull-updater"; exit 4; }`,
  ];
  if (plan.refreshAgent) {
    lines.push(`pull_release "$AGENT_REPO" ${shq(plan.agentDigest ?? "")} || { echo "TUGRA_STEP error=pull-agent"; exit 4; }`);
  }
  if (plan.hostFilesDigest) {
    // Foreground: its result is reported. A failure does not stop the refresh (the image refresh still helps).
    lines.push(
      `if docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$SRC:$SRC" -w "$SRC" -e TUGRA_REPO_DIR="$SRC" -e ENV_FILE="$SRC/.env" --entrypoint bash "$UPD_REPO:$VERSION" /opt/tugra/scripts/update.sh --apply-host-files "$VERSION" ${shq(plan.hostFilesDigest)} >/dev/null 2>&1; then echo "TUGRA_STEP hostfiles=applied"; else echo "TUGRA_STEP hostfiles=failed"; fi`,
    );
  }
  lines.push(
    `docker rm -f tugra-updater-refresh >/dev/null 2>&1 || true`,
    // Detached + delayed: this very script runs inside the agent, which is one of the services being recreated.
    `if docker run -d --rm --name tugra-updater-refresh -v /var/run/docker.sock:/var/run/docker.sock -v "$SRC:$SRC" -w "$SRC" --entrypoint sh "$UPD_REPO:$VERSION" -c 'sleep 5; d="$1"; shift; exec docker compose --profile updater --project-directory "$d/deploy" --env-file "$d/.env" -f "$d/deploy/docker-compose.yml" up -d --no-deps "$@"' sh "$SRC" ${services.join(" ")} >/dev/null 2>&1; then echo "TUGRA_STEP scheduled=${services.join(",")}"; else echo "TUGRA_STEP error=helper-start"; exit 4; fi`,
  );
  return lines.join("\n");
}

export interface RefreshResult {
  ok: boolean;
  scheduled: string[];
  hostFiles: "applied" | "failed" | null;
  error: string | null;
}

/** Parse the refresh script's output + exit code. */
export function parseRefreshOutput(exitCode: number, out: string): RefreshResult {
  let scheduled: string[] = [];
  let hostFiles: RefreshResult["hostFiles"] = null;
  let error: string | null = null;
  for (const line of out.split("\n")) {
    const m = /^TUGRA_STEP ([a-z-]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const value = SAFE_VALUE.test(m[2]) ? m[2] : "";
    if (m[1] === "scheduled") scheduled = value.split(",").filter(Boolean);
    else if (m[1] === "hostfiles") hostFiles = value === "applied" ? "applied" : "failed";
    else if (m[1] === "error") error = value || "failed";
  }
  return { ok: exitCode === 0 && scheduled.length > 0, scheduled, hostFiles, error: exitCode === 0 && scheduled.length > 0 ? null : (error ?? `exit ${exitCode}`) };
}
