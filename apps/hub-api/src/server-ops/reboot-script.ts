/**
 * Shell builders + parsers for the "Reboot server" feature. Reboots are never automatic: these scripts run only
 * because a person (or their token) asked for one.
 *
 * Three kinds of script, by WHERE they run:
 *  - HOST scripts (wrapped by patch-script's wrapHostExec, i.e. nsenter into PID 1): the read-only preflight / reboot-required
 *    flag, and the one that creates the reboot unit (a transient systemd timer, so the agent can report "rebooting"
 *    before the host goes down).
 *  - AGENT scripts (run in the agent's own container, which sees the docker socket and, because containers share the
 *    kernel, the host's boot id): the container state snapshot / verification read.
 *  - a HELPER-container script (agent image, `--network host`): the loopback domain probe. The agent's own network
 *    namespace is not the host's, so the proxy on 127.0.0.1:80/443 is reachable only from a host-network container.
 *
 * Every output is a line-oriented marker protocol; app output can never forge a marker because container and domain
 * lines are built from docker's own fields and curl's status code only, never from a response body.
 */
import { shq } from "../deploy/deploy-script";

/** The transient unit name (a `.timer` + a `.service`). One reboot at a time per host, by construction. */
export const REBOOT_UNIT = "tugra-reboot";
/** Delay between creating the unit and `systemctl reboot` running, so the agent can still report "rebooting". */
export const REBOOT_DELAY_SEC = 15;
const SYSTEMD_DIR = "/run/systemd/system";
/** Debian/Ubuntu's marker file (the same one the patch check reads). */
const REBOOT_FLAG_FILES = ["/var/run/reboot-required", "/run/reboot-required"];
const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const DIR_RE = /^\/[A-Za-z0-9._/-]+$/;

// ── host: preflight + reboot-required flag (read-only) ─────────────────────────────────────────────────────────────

/**
 * READ-ONLY host script (wrap with wrapHostExec). Markers:
 *   TUGRA_RB_SYSTEMD=1|0        systemd-run + systemctl are usable (a reboot unit can be created)
 *   TUGRA_RB_PATCH_RUNNING      a `tugra-patch-*` unit (an OS update) is running: a reboot would cut it off mid-dpkg
 *   TUGRA_RB_PENDING            a reboot unit created earlier is still counting down
 *   TUGRA_RB_REQUIRED=1|0       the host says it needs a reboot (Debian's reboot-required file; needs-restarting on rpm)
 */
export function buildRebootPreflightScript(o: { systemdDir?: string; flagFiles?: string[] } = {}): string {
  const systemdDir = o.systemdDir ?? SYSTEMD_DIR;
  const flagFiles = o.flagFiles ?? REBOOT_FLAG_FILES;
  if (!DIR_RE.test(systemdDir) || !flagFiles.every((f) => DIR_RE.test(f))) throw new Error("invalid reboot option");
  const flagTest = flagFiles.map((f) => `[ -f '${f}' ]`).join(" || ");
  return [
    `if [ -d '${systemdDir}' ] && command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then`,
    "  echo TUGRA_RB_SYSTEMD=1",
    "  if systemctl list-units --plain --no-legend --no-pager --state=active,activating,deactivating,reloading 'tugra-patch-*' 2>/dev/null | grep -q .; then echo TUGRA_RB_PATCH_RUNNING; fi",
    `  if systemctl is-active ${REBOOT_UNIT}.timer >/dev/null 2>&1 || systemctl is-active ${REBOOT_UNIT}.service >/dev/null 2>&1; then echo TUGRA_RB_PENDING; fi`,
    "else",
    "  echo TUGRA_RB_SYSTEMD=0",
    "fi",
    `if ${flagTest}; then echo TUGRA_RB_REQUIRED=1`,
    "elif command -v needs-restarting >/dev/null 2>&1; then if needs-restarting -r >/dev/null 2>&1; then echo TUGRA_RB_REQUIRED=0; else echo TUGRA_RB_REQUIRED=1; fi",
    "else echo TUGRA_RB_REQUIRED=0; fi",
  ].join("\n");
}

export interface RebootHostState {
  /** The wrapper reached the host and the script ran (TUGRA_HOST_ENTERED seen by the caller via parseHostExec). */
  systemd: boolean | null;
  patchRunning: boolean;
  pending: boolean;
  /** null: the host did not say. */
  rebootRequired: boolean | null;
}

export function parseRebootHost(output: string): RebootHostState {
  const sd = /^TUGRA_RB_SYSTEMD=([01])$/m.exec(output);
  const req = /^TUGRA_RB_REQUIRED=([01])$/m.exec(output);
  return {
    systemd: sd ? sd[1] === "1" : null,
    patchRunning: /^TUGRA_RB_PATCH_RUNNING$/m.test(output),
    pending: /^TUGRA_RB_PENDING$/m.test(output),
    rebootRequired: req ? req[1] === "1" : null,
  };
}

// ── host: create the reboot unit ───────────────────────────────────────────────────────────────────────────────────

export interface RebootStartOptions {
  /** Seconds until `systemctl reboot` runs. */
  delaySec?: number;
  /** Override, for tests only. */
  systemdDir?: string;
}

/**
 * HOST script (wrap with wrapHostExec) that arms the reboot: `systemd-run --on-active=<delay>s systemctl reboot` as a
 * transient timer. It refuses (nothing created) while an OS update unit runs, and is idempotent while an earlier reboot
 * timer still counts down. Markers (one of):
 *   TUGRA_REBOOT_SCHEDULED delay=<n> [already=1]
 *   TUGRA_REBOOT_BUSY=patch            an update unit is running (exit 1)
 *   TUGRA_REBOOT_UNSUPPORTED reason=no-systemd   no systemd to hold a delayed reboot (exit 1)
 *   TUGRA_REBOOT_START_FAILED          systemd-run refused (exit 1; its message follows)
 */
export function buildRebootStartScript(o: RebootStartOptions = {}): string {
  const delay = Math.trunc(o.delaySec ?? REBOOT_DELAY_SEC);
  const systemdDir = o.systemdDir ?? SYSTEMD_DIR;
  if (!(delay >= 5 && delay <= 600)) throw new Error("invalid reboot delay");
  if (!DIR_RE.test(systemdDir)) throw new Error("invalid reboot option");
  return [
    `if [ -d '${systemdDir}' ] && command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then`,
    "  if systemctl list-units --plain --no-legend --no-pager --state=active,activating,deactivating,reloading 'tugra-patch-*' 2>/dev/null | grep -q .; then echo TUGRA_REBOOT_BUSY=patch; exit 1; fi",
    `  if systemctl is-active ${REBOOT_UNIT}.timer >/dev/null 2>&1 || systemctl is-active ${REBOOT_UNIT}.service >/dev/null 2>&1; then echo "TUGRA_REBOOT_SCHEDULED delay=${delay} already=1"; exit 0; fi`,
    `  if ERR=$(systemd-run --unit ${REBOOT_UNIT} --on-active=${delay}s --collect --quiet --description 'Tugra server reboot' systemctl reboot 2>&1); then`,
    `    echo "TUGRA_REBOOT_SCHEDULED delay=${delay}"`,
    "  else",
    '    echo TUGRA_REBOOT_START_FAILED; printf "%s\\n" "$ERR" | head -n 3; exit 1',
    "  fi",
    "else",
    "  echo 'TUGRA_REBOOT_UNSUPPORTED reason=no-systemd'; exit 1",
    "fi",
  ].join("\n");
}

export interface RebootStartResult {
  scheduled: boolean;
  alreadyPending: boolean;
  busy: "patch" | null;
  unsupported: boolean;
  startFailed: boolean;
}

export function parseRebootStart(output: string): RebootStartResult {
  const sched = /^TUGRA_REBOOT_SCHEDULED delay=\d+( already=1)?$/m.exec(output);
  return {
    scheduled: !!sched,
    alreadyPending: !!sched && !!sched[1],
    busy: /^TUGRA_REBOOT_BUSY=patch$/m.test(output) ? "patch" : null,
    unsupported: /^TUGRA_REBOOT_UNSUPPORTED/m.test(output),
    startFailed: /^TUGRA_REBOOT_START_FAILED$/m.test(output),
  };
}

// ── agent: container state (snapshot before, verification after) ───────────────────────────────────────────────────

/**
 * AGENT script (runs in the agent's container; needs only the docker socket): the kernel's boot id, whether the docker
 * daemon answers, and one line per container (running or not). Space-separated fields, none of which can contain a space:
 *   TUGRA_RB_BOOT=<boot id>
 *   TUGRA_RB_DOCKER=active|inactive
 *   TUGRA_RB_C <name> <state> <health|none> <restart policy> <swarm 0|1> <image>
 *   TUGRA_RB_END                    always last when the script ran to completion (a cut-off read is detected by its absence)
 */
export function buildRebootStateScript(o: { bootIdFile?: string } = {}): string {
  const bootFile = o.bootIdFile ?? BOOT_ID_FILE;
  if (!DIR_RE.test(bootFile)) throw new Error("invalid reboot option");
  return [
    "set +e",
    `echo TUGRA_RB_BOOT=$(cat '${bootFile}' 2>/dev/null | tr -d '\\n ')`,
    "if docker info >/dev/null 2>&1; then",
    "  echo TUGRA_RB_DOCKER=active",
    "  ids=$(docker ps -aq 2>/dev/null)",
    "  [ -z \"$ids\" ] || docker inspect --format 'TUGRA_RB_C {{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{or .HostConfig.RestartPolicy.Name \"no\"}} {{if index .Config.Labels \"com.docker.swarm.task.id\"}}1{{else}}0{{end}} {{.Config.Image}}' $ids 2>/dev/null",
    "else",
    "  echo TUGRA_RB_DOCKER=inactive",
    "fi",
    "echo TUGRA_RB_END",
  ].join("\n");
}

/** AGENT script: only the boot id (what "did the host really reboot?" needs; no docker work). Parse with parseRebootState. */
export function buildBootIdScript(o: { bootIdFile?: string } = {}): string {
  const bootFile = o.bootIdFile ?? BOOT_ID_FILE;
  if (!DIR_RE.test(bootFile)) throw new Error("invalid reboot option");
  return `echo TUGRA_RB_BOOT=$(cat '${bootFile}' 2>/dev/null | tr -d '\\n ')`;
}

export type ContainerRunState = "running" | "exited" | "created" | "restarting" | "paused" | "removing" | "dead" | string;

export interface RebootContainerState {
  name: string;
  state: ContainerRunState;
  /** "none" = the image/app defines no healthcheck. */
  health: "healthy" | "unhealthy" | "starting" | "none" | string;
  restartPolicy: string;
  swarm: boolean;
  image: string;
}

export interface RebootStateRead {
  bootId: string | null;
  /** null: the script's docker marker is missing (a cut-off read). */
  docker: boolean | null;
  containers: RebootContainerState[];
  /** TUGRA_RB_END seen: the read is whole. */
  complete: boolean;
}

const C_RE = /^TUGRA_RB_C (\S+) (\S+) (\S+) (\S+) ([01]) (\S+)$/;

export function parseRebootState(output: string): RebootStateRead {
  const boot = /^TUGRA_RB_BOOT=([A-Za-z0-9-]+)$/m.exec(output);
  const dock = /^TUGRA_RB_DOCKER=(active|inactive)$/m.exec(output);
  const containers: RebootContainerState[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const m = C_RE.exec(line.trim());
    if (!m) continue;
    const name = m[1].replace(/^\//, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    containers.push({ name, state: m[2], health: m[3], restartPolicy: m[4], swarm: m[5] === "1", image: m[6] });
  }
  return { bootId: boot ? boot[1] : null, docker: dock ? dock[1] === "active" : null, containers, complete: /^TUGRA_RB_END$/m.test(output) };
}

// ── helper container: loopback domain probe ────────────────────────────────────────────────────────────────────────

export interface DomainTarget {
  host: string;
  scheme: "http" | "https";
  /** Starts with "/". */
  path: string;
}

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const PATH_RE = /^\/[A-Za-z0-9._~/%-]{0,200}$/;
/** Most domains one probe command checks (each is bounded to a few seconds, probed several at a time). */
export const MAX_PROBE_DOMAINS = 100;

/** A host/path that is safe to hand to curl as an argument. */
export function isProbeableTarget(t: DomainTarget): boolean {
  return HOST_RE.test(t.host) && PATH_RE.test(t.path) && (t.scheme === "http" || t.scheme === "https");
}

/**
 * AGENT script: start a throwaway `--network host` container from the agent's OWN image (`$TUGRA_AGENT_IMAGE`, the same
 * trusted source the patch helper uses; never pulled) and curl each domain against the host's proxy on 127.0.0.1
 * with `--resolve`, so the Host header and SNI are the real domain while no DNS is involved. Only the status code is
 * printed, never a body. The target list travels as base64 in an env var (no quoting to break). Markers:
 *   TUGRA_RB_D <host> <code>        one per target (000 = no answer)
 *   TUGRA_RB_PROBE=unavailable      no image to run the probe from
 *   TUGRA_RB_PROBE_END              last
 */
export function buildDomainProbeScript(targets: DomainTarget[]): string {
  const ok = targets.filter(isProbeableTarget).slice(0, MAX_PROBE_DOMAINS);
  const list = ok.map((t) => `${t.scheme} ${t.host} ${t.path}`).join("\n") + "\n";
  const b64 = Buffer.from(list, "utf8").toString("base64");
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error("non-base64 probe payload");
  const inner = [
    'xargs -P 8 -L 1 sh -c \'if [ "$0" = https ]; then P=443; else P=80; fi; ',
    'c=$(curl -ksS -o /dev/null -m 5 --connect-timeout 3 -w "%{http_code}" --resolve "$1:$P:127.0.0.1" "$0://$1$2" 2>/dev/null) || c=000; ',
    'printf "TUGRA_RB_D %s %s\\n" "$1" "${c:-000}"\'',
  ].join("");
  return [
    "set +e",
    'IMG="$TUGRA_AGENT_IMAGE"',
    '[ -n "$IMG" ] || { echo TUGRA_RB_PROBE=unavailable; exit 0; }',
    "docker run --rm --pull never --network host --label tugra.role=reboot-probe \\",
    `  -e TUGRA_RB_LIST='${b64}' --entrypoint sh "$IMG" -c ${shq(`printf %s "$TUGRA_RB_LIST" | base64 -d | ${inner}`)} 2>/dev/null || echo TUGRA_RB_PROBE=unavailable`,
    "echo TUGRA_RB_PROBE_END",
  ].join("\n");
}

export interface DomainProbeRead {
  unavailable: boolean;
  /** host -> HTTP status (0 = no answer). */
  codes: Map<string, number>;
  complete: boolean;
}

export function parseDomainProbe(output: string): DomainProbeRead {
  const codes = new Map<string, number>();
  for (const m of output.matchAll(/^TUGRA_RB_D (\S+) (\d{3})$/gm)) codes.set(m[1], Number(m[2]));
  return { unavailable: /^TUGRA_RB_PROBE=unavailable$/m.test(output) && codes.size === 0, codes, complete: /^TUGRA_RB_PROBE_END$/m.test(output) };
}
