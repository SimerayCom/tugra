/**
 * Pure builders + parser for OS package patching. Auto-detects the server's package
 * manager (apt / dnf / yum / apk) so the same Tugra "check / upgrade" flow works on
 * Debian-Ubuntu, RHEL-Rocky-Fedora and Alpine. The agent runs these shell scripts
 * as-is; output is parsed back here. Markers (TUGRA_*) carry the manager, the upgradable
 * list and reboot-required back without a second round-trip.
 */

// Allows the name forms every manager uses (incl. dnf's `name.x86_64` arch suffix with `_`, and
// capitalised RPM names like NetworkManager). Rejects shell metacharacters, spaces and leading flags.
// A trailing `-` is apt syntax for "REMOVE this package" (`apt-get install --only-upgrade foo-`), so it can never end a name.
const PKG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9._+])?$/;

export type PkgManager = "apt" | "dnf" | "yum" | "apk";

/**
 * Packages whose install/upgrade/configure restarts (or can restart) the container engine. Upgrading one of these
 * from inside a container that the engine itself runs is suicide: dockerd restarts and kills the container
 * mid-configure, leaving dpkg half-configured. Exact names, plus `moby-*`; rpm names may carry an `.arch` suffix.
 */
export const CONTAINER_ENGINE_PACKAGES = [
  "docker-ce",
  "docker-ce-cli",
  "docker-ce-rootless-extras",
  "docker-buildx-plugin",
  "docker-compose-plugin",
  "containerd.io",
  "containerd",
  "runc",
  "docker.io",
  "docker-engine",
  "docker",
  "podman",
] as const;

const ENGINE_ERE = `^(${[...CONTAINER_ENGINE_PACKAGES.map((n) => n.replace(/\./g, "\\.")), "moby-[A-Za-z0-9._+-]+"].join("|")})(\\.[A-Za-z0-9_]+)?$`;
const ENGINE_JS_RE = new RegExp(ENGINE_ERE);

/** Is this a container-engine package (see {@link CONTAINER_ENGINE_PACKAGES})? */
export function isContainerEnginePackage(name: string): boolean {
  return ENGINE_JS_RE.test(name);
}

/** Where the host-side patch unit keeps its script, log and exit code (survives a Docker restart, unlike the helper). */
export const PATCH_STATE_DIR = "/etc/tugra/patch";
const SYSTEMD_DIR = "/run/systemd/system";

// Shell fragments shared by the check (read-only) and the apply. All POSIX sh, no bashisms.
// tugra_dpkg_broken: READ-ONLY. One "<state> <package>" line per package dpkg left unfinished — half-configured
// (F), unpacked-not-configured (U), half-installed (H), triggers pending (W/t) — i.e. what `dpkg --audit` lists.
const DPKG_BROKEN_FN =
  "tugra_dpkg_broken() { dpkg-query -W -f='${db:Status-Abbrev} ${Package}\\n' 2>/dev/null | awk '{ s = substr($1, 2, 1); " +
  "if (s == \"F\") st = \"half-configured\"; else if (s == \"U\") st = \"unpacked\"; else if (s == \"H\") st = \"half-installed\"; " +
  "else if (s == \"W\" || s == \"t\") st = \"triggers-pending\"; else next; print st \" \" $2 }'; }";

// A patch unit started by an earlier apply is still running (its apt holds the dpkg lock).
const patchRunningFn = (systemdDir: string) =>
  `tugra_patch_running() { [ -d '${systemdDir}' ] && command -v systemctl >/dev/null 2>&1 && ` +
  "systemctl list-units --plain --no-legend --no-pager --state=active,activating,deactivating,reloading 'tugra-patch-*' 2>/dev/null | grep -q .; }";

// Keeps just apt's "deferred due to phasing" block (the header and its indented package lines) from the simulation.
const PHASED_AWK =
  "/^The following upgrades have been deferred due to phasing:/ { p = 1; print; next } p && /^[ \\t]/ { print; next } { p = 0 }";

/**
 * Refresh the index, list upgradables, flag reboot-required — for whichever package
 * manager the server has. Emits `TUGRA_MGR=<mgr>`, then `TUGRA_UPGRADABLE` + the raw list,
 * then `TUGRA_REBOOT` when a reboot is pending. `TUGRA_UNSUPPORTED` when no manager is found.
 *
 * READ-ONLY by contract: a check never configures, installs or upgrades anything (the only write is the
 * package index refresh). In particular it NEVER runs `dpkg --configure -a`: re-running a half-configured
 * docker-ce's postinst restarts dockerd, so a mere "Check for updates" would bounce every container. An
 * interrupted dpkg is REPORTED instead (`TUGRA_DPKG_BROKEN=<pkg>:<state>`, one per package) and healed only by an
 * explicit apply. `TUGRA_PATCH_RUNNING` says an apply unit is still running on the host (the list is then
 * mid-flight, and the index refresh is skipped so it cannot fight apt for the lock).
 */
export function buildCheckScript(systemdDir = SYSTEMD_DIR): string {
  return [
    patchRunningFn(systemdDir),
    DPKG_BROKEN_FN,
    "if tugra_patch_running; then TUGRA_BUSY=1; echo TUGRA_PATCH_RUNNING; else TUGRA_BUSY=; fi",
    "if command -v apt-get >/dev/null 2>&1; then",
    "  echo TUGRA_MGR=apt",
    '  tugra_dpkg_broken | while read -r st pkg; do echo "TUGRA_DPKG_BROKEN=$pkg:$st"; done',
    '  [ -n "$TUGRA_BUSY" ] || apt-get update -qq >/dev/null 2>&1 || true',
    "  echo TUGRA_UPGRADABLE",
    "  apt list --upgradable 2>/dev/null",
    "  [ -f /var/run/reboot-required ] && echo TUGRA_REBOOT || true",
    // READ-ONLY simulation (-s): apt lists packages Ubuntu is still phasing in under `apt list --upgradable`, yet a
    // normal upgrade defers them. The simulation names those; only that block of its output is kept.
    "  echo TUGRA_PHASED_SIM",
    `  LC_ALL=C apt-get -s upgrade 2>/dev/null | awk '${PHASED_AWK}' || true`,
    "elif command -v dnf >/dev/null 2>&1; then",
    "  echo TUGRA_MGR=dnf",
    "  echo TUGRA_UPGRADABLE",
    "  COLUMNS=1000 dnf -q check-update 2>/dev/null", // wide COLUMNS stops long names wrapping onto 2 lines
    "  rc=$?", // check-update: 0 = none, 100 = updates available, anything else = the check itself failed
    '  [ "$rc" -ne 0 ] && [ "$rc" -ne 100 ] && echo TUGRA_CHECK_FAILED',
    "  command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo TUGRA_REBOOT; } || true",
    "elif command -v yum >/dev/null 2>&1; then",
    "  echo TUGRA_MGR=yum",
    "  echo TUGRA_UPGRADABLE",
    "  COLUMNS=1000 yum -q check-update 2>/dev/null",
    "  rc=$?",
    '  [ "$rc" -ne 0 ] && [ "$rc" -ne 100 ] && echo TUGRA_CHECK_FAILED',
    "  command -v needs-restarting >/dev/null 2>&1 && { needs-restarting -r >/dev/null 2>&1 || echo TUGRA_REBOOT; } || true",
    "elif command -v apk >/dev/null 2>&1; then",
    "  echo TUGRA_MGR=apk",
    '  [ -n "$TUGRA_BUSY" ] || apk update >/dev/null 2>&1 || true',
    "  echo TUGRA_UPGRADABLE",
    "  apk version -l '<' 2>/dev/null", // list world packages whose installed < available
    "else",
    "  echo TUGRA_UNSUPPORTED",
    "fi",
  ].join("\n");
}

// apt hardening for an unattended host upgrade: keep the running config on conffile conflicts
// (--force-confold) and don't let needrestart stop for input (NEEDRESTART_SUSPEND).
const APT_UP = "DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get -o Dpkg::Options::=--force-confold";
// Finish an interrupted dpkg before an apt upgrade. A prior run that was cut off mid-configure (the hub giving up,
// the container the upgrade ran in being killed by the engine restart it caused, a reboot) leaves dpkg
// "interrupted", after which EVERY apt operation exits 100 ("dpkg was interrupted, you must manually run
// 'dpkg --configure -a'") and the server is stuck. `dpkg --configure -a` is the documented recovery, but it re-runs
// the postinst of whatever was half-configured — for docker-ce that restarts dockerd — so it lives ONLY here, in the
// APPLY (which runs as a host-side unit that outlives the restart), is announced first, and only runs when there is
// really something to finish. A check never gets near it.
const APT_HEAL = [
  "  " + DPKG_BROKEN_FN,
  "  BROKEN=$(tugra_dpkg_broken | awk '{print $2}' | tr '\\n' ' ')",
  '  if [ -n "$BROKEN" ]; then',
  '    echo "TUGRA_WARN: dpkg was interrupted (${BROKEN}) - finishing its configuration first. If that includes the container engine, Docker restarts now and every container with it."',
  "    DEBIAN_FRONTEND=noninteractive dpkg --configure -a 2>&1 || true",
  "  fi",
].join("\n");

/** Upgrade every package, for whichever manager the server has. */
export function buildUpgradeAllScript(): string {
  return [
    "if command -v apt-get >/dev/null 2>&1; then",
    APT_HEAL,
    `  ${APT_UP} upgrade -y;`,
    "elif command -v dnf >/dev/null 2>&1; then dnf -y upgrade;",
    "elif command -v yum >/dev/null 2>&1; then yum -y update;",
    "elif command -v apk >/dev/null 2>&1; then apk upgrade;",
    "else echo TUGRA_UNSUPPORTED; exit 1; fi",
  ].join("\n");
}

/** Upgrade a single package. `pkg` is strictly validated (no shell metacharacters / flags). */
export function buildUpgradeOneScript(pkg: string): string {
  if (!PKG_RE.test(pkg)) throw new Error("invalid package name");
  return [
    "if command -v apt-get >/dev/null 2>&1; then",
    APT_HEAL,
    `  ${APT_UP} install --only-upgrade -y ${pkg};`,
    `elif command -v dnf >/dev/null 2>&1; then dnf -y upgrade ${pkg};`,
    `elif command -v yum >/dev/null 2>&1; then yum -y update ${pkg};`,
    `elif command -v apk >/dev/null 2>&1; then apk upgrade ${pkg};`,
    "else echo TUGRA_UNSUPPORTED; exit 1; fi",
  ].join("\n");
}

/**
 * Install ONE phased (gradually rolled out) apt package right now, bypassing Ubuntu's phasing for that package only.
 * `-o APT::Get::Always-Include-Phased-Updates=true` appears here and nowhere else: "update all" and the plain
 * per-package update keep honouring the rollout. apt only — other managers have no phasing, so they refuse.
 */
export function buildInstallPhasedScript(pkg: string): string {
  if (!PKG_RE.test(pkg)) throw new Error("invalid package name");
  return [
    "if command -v apt-get >/dev/null 2>&1; then",
    APT_HEAL,
    `  ${APT_UP} -o APT::Get::Always-Include-Phased-Updates=true install --only-upgrade -y ${pkg};`,
    'else echo "TUGRA_PHASED_UNSUPPORTED: phased rollouts exist only on apt"; exit 1; fi',
  ].join("\n");
}

/**
 * Wrap a package-manager script so it runs ON THE HOST, not inside the agent's own container.
 *
 * Why: the agent is a debian:bookworm-slim container; running the inner `apt-get upgrade` in the agent's
 * shell patches the AGENT, never the host — a silent "looks patched but isn't" lie on every managed server.
 * Here the agent (which already has docker.sock + root) launches ONE ephemeral `--rm` helper FROM ITS OWN
 * image and `nsenter`s into PID 1, so the command runs in the host's real namespaces (host apt/dpkg, host
 * /var/run/reboot-required, host networking). The agent process itself gains NO privilege — only the
 * short-lived helper is `--privileged`, which is unavoidable for host patching (and no stronger than the
 * docker.sock the agent already holds).
 *
 * The inner script travels as base64 in an env var, so its own quoting (e.g. `apk version -l '<'`), newlines
 * and `$?` survive untouched; it is decoded + run by the host's `/bin/sh`. Every unmet precondition prints a
 * `TUGRA_HOST_UNAVAILABLE reason=…` marker and exits non-zero — there is NEVER a fallback to patching the
 * container (which would re-create the original lie). `--pull never` keeps it offline/air-gap safe, and the
 * fixed `--name tugra-patch` is a per-host mutex (a STOPPED leftover with that name — the engine restart killed the
 * helper — is removed first; `docker rm` without -f refuses a running one, which stays the mutex).
 *
 * The helper's lifetime is the container's: an engine restart kills it. A CHECK is short and read-only so that is
 * harmless; an APPLY therefore does not run the package manager as the helper's child — see buildPatchRunScript.
 *
 * The helper image is the agent's OWN image, taken ONLY from the `$TUGRA_AGENT_IMAGE` env the agent learned
 * at install/self-update (never from the hub, never tenant-settable) — the SAME trusted source the `fsd`
 * file-ops helper uses. We deliberately do NOT resolve it via `docker inspect $(hostname)`: a tenant compose
 * app may set `container_name` to the agent's short id (compose-safety does not block container_name), so a
 * name match would run the tenant's image `--privileged --pid=host` as host root. Empty env ⇒ fail-closed.
 */
export function wrapHostExec(inner: string, opts: { deadlineSec: number; killSec: number }): string {
  const prelude = "echo TUGRA_HOST_ENTERED; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; ";
  const b64 = Buffer.from(prelude + inner, "utf8").toString("base64");
  // The payload must be pure base64 so it cannot break out of the single-quoted `-e` value on the agent shell.
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) throw new Error("non-base64 host-exec payload");
  const d = Math.trunc(opts.deadlineSec);
  const k = Math.trunc(opts.killSec);
  return [
    // The image is the agent's OWN image from the trusted $TUGRA_AGENT_IMAGE env ONLY — never resolved by
    // container name/hostname (a tenant could name a container the agent's short id and get their image run
    // as host root). Empty ⇒ fail-closed. Same trusted source + fail-closed posture as the fsd file helper.
    `IMG="$TUGRA_AGENT_IMAGE"`,
    `[ -n "$IMG" ] || { echo "TUGRA_HOST_UNAVAILABLE reason=no-image"; exit 1; }`,
    `docker rm tugra-patch >/dev/null 2>&1 || true`,
    `docker run --rm --pull never --name tugra-patch --label tugra.role=patch-helper \\`,
    `  --privileged --pid=host --userns=host --network none \\`,
    `  -e TUGRA_PATCH_B64='${b64}' --entrypoint sh "$IMG" -c '`,
    `[ "$(readlink /proc/1/ns/mnt)" != "$(readlink /proc/self/ns/mnt)" ] || { echo "TUGRA_HOST_UNAVAILABLE reason=not-host-pid"; exit 1; }`,
    `grep -Eq "^ *0 +0 +4294967295$" /proc/self/uid_map || { echo "TUGRA_HOST_UNAVAILABLE reason=userns"; exit 1; }`,
    `command -v nsenter >/dev/null 2>&1 || { echo "TUGRA_HOST_UNAVAILABLE reason=no-nsenter"; exit 1; }`,
    `exec timeout -k ${k} ${d} nsenter -t 1 -m -u -i -n -p -- /bin/sh -c "$(printf %s "$TUGRA_PATCH_B64" | base64 -d)"`,
    `'`,
    `rc=$?; [ $rc -ne 0 ] && echo "TUGRA_HOST_EXEC_RC=$rc"; exit $rc`,
  ].join("\n");
}

export interface HostExecStatus {
  entered: boolean; // the inner script actually ran on the host (TUGRA_HOST_ENTERED seen)
  unavailableReason?: string; // no-image | not-host-pid | userns | no-nsenter — host could NOT be entered
  busy: boolean; // a prior patch helper still holds the tugra-patch name
}

/** Did the host-exec wrapper actually reach the host? Used so a wrapper failure surfaces as a clear error
 *  instead of being mis-parsed as "unsupported OS" (which would be a second lie). */
export function parseHostExec(output: string): HostExecStatus {
  const m = /TUGRA_HOST_UNAVAILABLE reason=(\S+)/.exec(output);
  return {
    entered: output.includes("TUGRA_HOST_ENTERED"),
    unavailableReason: m ? m[1] : undefined,
    busy: /is already in use/.test(output) || output.includes("TUGRA_PATCH_BUSY"),
  };
}

// ── APPLY: run the package manager OUTSIDE the helper container's lifecycle ─────────────────────────────────────
// Upgrading docker-ce / containerd.io restarts dockerd, which kills every container — including the one-shot
// helper whose child the package manager would be. dpkg is then left half-configured and the next run starts
// from a broken host. So an APPLY starts the package manager as a transient systemd unit on the HOST (PID 1's
// namespaces, its own cgroup — an engine restart cannot touch it), with its script, output and exit code in a
// Tugra state dir, and the helper merely FOLLOWS that unit. When the helper (and the agent) die with the engine,
// the hub re-sends the very same driver once the agent is back: it finds the unit's state files, does NOT start a
// second unit, and resumes streaming after the log lines the hub already has. Hosts without systemd fall back to
// running the script inline (as before) and then REFUSE container-engine packages — see below.

const RUN_ID_RE = /^[a-f0-9]{8,32}$/;
const DIR_RE = /^\/[A-Za-z0-9._/-]+$/;
const POLL_RE = /^\d+(\.\d+)?$/;

export type PatchGuard = { kind: "all" } | { kind: "one"; pkg: string };

export interface PatchRunOptions {
  /** Run id (hex). The same id attaches to the same unit; a new id starts a new one. */
  id: string;
  /** Hard cap on the package manager's runtime (seconds). */
  deadlineSec: number;
  /** Complete lines of the unit's log the hub already has — the follower resumes after them. 0 on the first attach. */
  lines: number;
  /** What is being upgraded: drives the container-engine refusal on hosts without systemd. */
  guard: PatchGuard;
  /** Seconds between polls of the unit (fractions allowed, for tests). Default 2. */
  pollSec?: string;
  /** Overrides, for tests only. */
  stateDir?: string;
  systemdDir?: string;
}

// Names of the packages an apply would upgrade (apt / dnf / yum / apk), one per line — for the engine guard.
const PENDING_NAMES_FN =
  "tugra_pending_names() { " +
  "if command -v apt-get >/dev/null 2>&1; then apt list --upgradable 2>/dev/null | sed -n 's|^\\([^/ ]*\\)/.*|\\1|p'; " +
  "elif command -v dnf >/dev/null 2>&1; then COLUMNS=1000 dnf -q check-update 2>/dev/null | awk 'NF==3 && $3 !~ /^@/ {print $1}'; " +
  "elif command -v yum >/dev/null 2>&1; then COLUMNS=1000 yum -q check-update 2>/dev/null | awk 'NF==3 && $3 !~ /^@/ {print $1}'; " +
  "elif command -v apk >/dev/null 2>&1; then apk version -l '<' 2>/dev/null | sed 's/-[0-9][^ ]* *<.*$//'; " +
  "fi; }";

// Print the COMPLETE lines of the unit's log past $POS and advance it. $POS counts lines, matching the hub's resume
// point: a byte offset would drift from the hub's decoded text on any non-UTF-8 byte or multibyte character split
// across the agent's reads, whereas a newline survives every re-encoding. tugra_emit_rest prints what follows the last
// newline (an unterminated final line) — only once the unit has ended and the log can no longer grow.
const EMIT_LOG_FN =
  'tugra_emit_log() { [ -f "$D/$ID.log" ] || return 0; N=$(wc -l < "$D/$ID.log" | tr -d " "); ' +
  'if [ "$N" -gt "$POS" ]; then tail -n +$((POS + 1)) "$D/$ID.log" | head -n $((N - POS)); POS=$N; fi; }; ' +
  'tugra_emit_rest() { [ -f "$D/$ID.log" ] && tail -n +$((POS + 1)) "$D/$ID.log"; return 0; }';

/**
 * The script the host runs (inside the helper's nsenter) for ONE apply attach. Marker protocol on stdout:
 *   TUGRA_PATCH_MODE=unit|inline     how it runs (inline = no systemd, never resumable)
 *   TUGRA_PATCH_STARTED              this attach started the unit (absent when it re-attached to a running/finished one)
 *   TUGRA_PATCH_BEGIN                everything after this line is the package manager's output
 *   TUGRA_PATCH_RC=<n>               the package manager's exit code (-1: the unit vanished without one); last line
 *   TUGRA_PATCH_BUSY                 another patch unit is already running (exit 1, nothing started)
 *   TUGRA_PATCH_START_FAILED         systemd-run refused (exit 1)
 *   TUGRA_PATCH_ENGINE_BLOCKED=a,b   inline mode only: container-engine packages must not be touched from here (exit 1)
 */
export function buildPatchRunScript(inner: string, o: PatchRunOptions): string {
  if (!RUN_ID_RE.test(o.id)) throw new Error("invalid patch run id");
  const deadline = Math.trunc(o.deadlineSec);
  const lines = Math.trunc(o.lines);
  if (!(deadline > 0) || !(lines >= 0)) throw new Error("invalid patch run bounds");
  const stateDir = o.stateDir ?? PATCH_STATE_DIR;
  const systemdDir = o.systemdDir ?? SYSTEMD_DIR;
  const poll = o.pollSec ?? "2";
  if (!DIR_RE.test(stateDir) || !DIR_RE.test(systemdDir) || !POLL_RE.test(poll)) throw new Error("invalid patch run option");
  if (o.guard.kind === "one" && !PKG_RE.test(o.guard.pkg)) throw new Error("invalid package name");

  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64"); // base64 alphabet only: safe in single quotes
  const runner = [
    "#!/bin/sh",
    'export PATH="${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    `timeout -k 30 ${deadline} /bin/sh "${stateDir}/${o.id}.sh" >"${stateDir}/${o.id}.log" 2>&1`,
    "rc=$?",
    `echo "$rc" >"${stateDir}/${o.id}.rc.tmp" && mv "${stateDir}/${o.id}.rc.tmp" "${stateDir}/${o.id}.rc"`,
    "",
  ].join("\n");
  const pending = o.guard.kind === "one" ? `PEND='${o.guard.pkg}'` : "PEND=$(tugra_pending_names)";

  return [
    `D='${stateDir}'`,
    `ID='${o.id}'`,
    'UNIT="tugra-patch-$ID"',
    `POS=${lines}`,
    `ENGINE_RE='${ENGINE_ERE}'`,
    DPKG_BROKEN_FN,
    PENDING_NAMES_FN,
    EMIT_LOG_FN,
    `if [ -d '${systemdDir}' ] && command -v systemd-run >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then`,
    "  echo TUGRA_PATCH_MODE=unit",
    '  mkdir -p "$D" && chmod 700 "$D" || { echo TUGRA_PATCH_START_FAILED; exit 1; }',
    '  if [ ! -f "$D/$ID.run" ]; then',
    // One patch unit at a time on a host: two package managers would fight over the dpkg lock.
    "    if systemctl list-units --plain --no-legend --no-pager --state=active,activating,deactivating,reloading 'tugra-patch-*' 2>/dev/null | grep -q .; then echo TUGRA_PATCH_BUSY; exit 1; fi",
    '    find "$D" -type f -mtime +7 -delete 2>/dev/null',
    `    printf %s '${b64(inner)}' | base64 -d > "$D/$ID.sh" && printf %s '${b64(runner)}' | base64 -d > "$D/$ID.run.tmp" && mv "$D/$ID.run.tmp" "$D/$ID.run" || { echo TUGRA_PATCH_START_FAILED; rm -f "$D/$ID.run" "$D/$ID.run.tmp"; exit 1; }`,
    '    if ! systemd-run --unit "$UNIT" --collect --quiet --description "Tugra OS package update" /bin/sh "$D/$ID.run" >"$D/$ID.start.err" 2>&1; then',
    '      echo TUGRA_PATCH_START_FAILED; cat "$D/$ID.start.err" 2>/dev/null; rm -f "$D/$ID.run"; exit 1',
    "    fi",
    "    echo TUGRA_PATCH_STARTED",
    "  fi",
    "  echo TUGRA_PATCH_BEGIN",
    "  GONE=0",
    "  while :; do",
    "    tugra_emit_log",
    '    if [ -f "$D/$ID.rc" ]; then tugra_emit_log; tugra_emit_rest; echo; echo "TUGRA_PATCH_RC=$(cat "$D/$ID.rc")"; exit 0; fi',
    '    case "$(systemctl is-active "$UNIT" 2>/dev/null)" in active|activating|deactivating) GONE=0 ;; *) GONE=$((GONE + 1)) ;; esac',
    // The unit is gone and left no exit code (killed, host rebooted): report that rather than polling forever.
    '    if [ "$GONE" -ge 3 ]; then tugra_emit_log; tugra_emit_rest; echo; echo "TUGRA_PATCH_RC=-1"; exit 0; fi',
    `    sleep ${poll}`,
    "  done",
    "else",
    "  echo TUGRA_PATCH_MODE=inline",
    // No systemd: the package manager would run as the helper's child, so an engine upgrade/configure would kill
    // it mid-way (the very bug this prevents). Refuse every container-engine package — also a half-configured one
    // that the pre-upgrade `dpkg --configure -a` would re-run — rather than risk it.
    `  ${pending}`,
    "  BROKEN=$(tugra_dpkg_broken | awk '{print $2}')",
    `  BLOCK=$(printf '%s\\n%s\\n' "$PEND" "$BROKEN" | grep -E "$ENGINE_RE" | sort -u | tr '\\n' ',' | sed 's/,$//')`,
    '  if [ -n "$BLOCK" ]; then echo "TUGRA_PATCH_ENGINE_BLOCKED=$BLOCK"; exit 1; fi',
    "  echo TUGRA_PATCH_BEGIN",
    `  timeout -k 30 ${deadline} /bin/sh -c "$(printf %s '${b64(inner)}' | base64 -d)" 2>&1`,
    "  rc=$?",
    '  echo; echo "TUGRA_PATCH_RC=$rc"',
    "fi",
  ].join("\n");
}

export interface PatchRunStatus {
  mode: "unit" | "inline" | null;
  /** The package manager's own output so far (everything after TUGRA_PATCH_BEGIN, minus the RC marker). */
  log: string;
  begun: boolean;
  /** The package manager's exit code; null while it has not finished (or the attach ended before it did). */
  rc: number | null;
  busy: boolean;
  startFailed: boolean;
  /** Inline mode refused these container-engine packages. */
  engineBlocked: string[] | null;
}

/** Parse one attach's output (or the partial output streamed so far). */
export function parsePatchRun(output: string): PatchRunStatus {
  const mode = /TUGRA_PATCH_MODE=(unit|inline)/.exec(output);
  const blocked = /TUGRA_PATCH_ENGINE_BLOCKED=(\S+)/.exec(output);
  const begin = output.indexOf("TUGRA_PATCH_BEGIN\n");
  let log = "";
  let rc: number | null = null;
  if (begin >= 0) {
    const body = output.slice(begin + "TUGRA_PATCH_BEGIN\n".length);
    const at = body.lastIndexOf("TUGRA_PATCH_RC=");
    if (at >= 0 && (at === 0 || body[at - 1] === "\n")) {
      const m = /^TUGRA_PATCH_RC=(-?\d+)/.exec(body.slice(at));
      if (m) {
        rc = Number(m[1]);
        // The driver prints "\n" before the marker so it always starts a line; drop exactly that one.
        log = body.slice(0, at > 0 ? at - 1 : 0);
      }
    }
    if (rc === null) log = body;
  }
  return {
    mode: mode ? (mode[1] as "unit" | "inline") : null,
    log,
    begun: begin >= 0,
    rc,
    busy: output.includes("TUGRA_PATCH_BUSY"),
    startFailed: output.includes("TUGRA_PATCH_START_FAILED"),
    engineBlocked: blocked ? blocked[1].split(",").filter(Boolean) : null,
  };
}

export interface UpgradablePackage {
  name: string;
  current: string; // "" when the manager's check doesn't report the installed version (dnf/yum)
  candidate: string;
}

/** A package dpkg left unfinished by an interrupted run, and how. */
export interface InterruptedPackage {
  name: string;
  state: "half-configured" | "unpacked" | "half-installed" | "triggers-pending";
}

/** dpkg is in an interrupted state — its own finding, never healed silently by a check. */
export interface DpkgInterrupted {
  packages: InterruptedPackage[];
  /** At least one of them is a container-engine package: finishing it restarts Docker (and every container). */
  containerEngine: boolean;
}

export interface PatchInfo {
  supported: boolean;
  manager: PkgManager | null;
  checkFailed: boolean; // the manager's check ran but errored (repo unreachable / bad GPG) — result is NOT "up to date"
  rebootRequired: boolean;
  /** Upgradable packages a normal update installs. Excludes {@link phased}. */
  packages: UpgradablePackage[];
  /** `packages.length` — phased packages are not counted. */
  count: number;
  /** apt only: upgradable packages Ubuntu is still rolling out gradually; a normal update defers them until this
   *  server's turn. Empty on every other manager. */
  phased: UpgradablePackage[];
  /** apt only: packages a previous (cut-off) run left half-configured; null when dpkg is clean. */
  dpkgInterrupted: DpkgInterrupted | null;
  /** A patch unit started earlier is still running on the host — the list is mid-flight, not final. */
  applyRunning: boolean;
}

// apt: "docker-ce/noble 5:29.6.0-1~noble amd64 [upgradable from: 5:29.5.0-1~noble]"
const APT_RE = /^([a-z0-9][a-z0-9.+-]*)\/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/i;
// dnf/yum -q check-update: "curl.x86_64   7.76.1-26.el9_3.2   baseos" (exactly 3 columns)
const RPM_RE = /^([a-zA-Z0-9][a-zA-Z0-9._+-]*)\s+(\S+)\s+(\S+)\s*$/;
// apk version -l '<': "zlib-1.2.13-r0 < 1.2.13-r1" (name-installed < available)
const APK_RE = /^(.+)-(\d[^\s]*)\s+<\s+(\S+)\s*$/;

function readManager(output: string): PkgManager | null {
  const m = /TUGRA_MGR=(apt|dnf|yum|apk)/.exec(output);
  return m ? (m[1] as PkgManager) : null;
}

const UNSUPPORTED: PatchInfo = { supported: false, manager: null, checkFailed: false, rebootRequired: false, packages: [], count: 0, phased: [], dpkgInterrupted: null, applyRunning: false };

const BROKEN_STATES = new Set<string>(["half-configured", "unpacked", "half-installed", "triggers-pending"]);

function readInterrupted(output: string): DpkgInterrupted | null {
  const packages: InterruptedPackage[] = [];
  for (const m of output.matchAll(/^TUGRA_DPKG_BROKEN=([^:\s]+):(\S+)$/gm)) {
    if (BROKEN_STATES.has(m[2])) packages.push({ name: m[1], state: m[2] as InterruptedPackage["state"] });
  }
  if (packages.length === 0) return null;
  return { packages, containerEngine: packages.some((p) => isContainerEnginePackage(p.name)) };
}

const PHASED_HEADER = "The following upgrades have been deferred due to phasing:";

/** Names apt's simulated upgrade says it deferred because of Ubuntu's phased rollout. Accepts the full
 *  `apt-get -s upgrade` text or just the block; the names are indented lines right after the header. Pure. */
export function parsePhasedNames(sim: string): string[] {
  const lines = sim.split("\n");
  const at = lines.findIndex((l) => l.trim() === PHASED_HEADER);
  if (at < 0) return [];
  const names = new Set<string>();
  for (const raw of lines.slice(at + 1)) {
    if (!/^\s+\S/.test(raw)) break;
    for (const tok of raw.trim().split(/\s+/)) {
      const name = tok.replace(/:[a-z0-9-]+$/i, ""); // multiarch "libfoo:i386"
      if (PKG_RE.test(name)) names.add(name);
    }
  }
  return [...names];
}

/** Parse the agent's check-script output into structured update info (manager-aware). */
export function parseUpgradable(output: string): PatchInfo {
  if (output.includes("TUGRA_UNSUPPORTED")) return UNSUPPORTED;
  const manager = readManager(output);
  if (!manager) return UNSUPPORTED;

  const checkFailed = output.includes("TUGRA_CHECK_FAILED");
  const rebootRequired = output.includes("TUGRA_REBOOT");
  const packages: UpgradablePackage[] = [];
  // Only the lines after the TUGRA_UPGRADABLE marker are the package list.
  const start = output.indexOf("TUGRA_UPGRADABLE");
  const afterList = start >= 0 ? output.slice(start + "TUGRA_UPGRADABLE".length) : output;
  // apt appends the phasing simulation after a marker; it is not part of the package list.
  const simAt = afterList.indexOf("TUGRA_PHASED_SIM");
  const body = simAt >= 0 ? afterList.slice(0, simAt) : afterList;
  const phasedNames = manager === "apt" && simAt >= 0 ? new Set(parsePhasedNames(afterList.slice(simAt))) : new Set<string>();

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("TUGRA_") || line.startsWith("Listing")) continue;
    if (manager === "apt") {
      const m = APT_RE.exec(line);
      if (m) packages.push({ name: m[1], candidate: m[2], current: m[3].trim() });
    } else if (manager === "apk") {
      const m = APK_RE.exec(line);
      if (m) packages.push({ name: m[1], current: m[2], candidate: m[3] });
    } else {
      // dnf / yum: check-update reports the available version + repo, not the installed one.
      const lower = line.toLowerCase();
      if (lower.startsWith("last metadata")) continue;
      // "Obsoleting Packages" is a trailing informational block (an obsoleting pkg followed by an
      // indented already-installed pkg). `dnf/yum upgrade` handles obsoletes itself, so stop here
      // rather than list those rows as phantom upgrades (the indented @System line would otherwise
      // trim to a normal 3-column match and inflate the count with an already-installed version).
      if (lower.startsWith("obsoleting")) break;
      const m = RPM_RE.exec(line);
      // Skip installed packages (repo column @System / @anaconda / …) — never an available upgrade.
      if (m && !m[3].startsWith("@")) {
        packages.push({ name: m[1], candidate: m[2], current: "" });
      }
    }
  }
  const phased = packages.filter((p) => phasedNames.has(p.name));
  const ready = phased.length === 0 ? packages : packages.filter((p) => !phasedNames.has(p.name));
  return {
    supported: true,
    manager,
    checkFailed,
    rebootRequired,
    packages: ready,
    count: ready.length,
    phased,
    dpkgInterrupted: manager === "apt" ? readInterrupted(output) : null,
    applyRunning: /^TUGRA_PATCH_RUNNING$/m.test(output),
  };
}
