/**
 * The `coolify-host-loop` source runner (R32/C2): ONE script the operator runs on the Coolify host. The fleet's only reach to
 * its source servers is SSH from that host, which keeps one key per managed server; the hub cannot reach them and holds no key.
 * The script loops over the run's source hosts and, on each, over that host's own key:
 *
 *   DATA_SEED / DATA_FINAL  start the migrator DETACHED (the same idempotent launcher the same-host `agent` runner uses, so the
 *                           copy survives an ssh drop) with the flags of the phase plus `--only` for the items of THAT host, then
 *                           poll it to the end;
 *   FREEZE                  stop (or, with `TUGRA_LOOP_ACTION=unfreeze`, start again) the writers of the host with the
 *                           identity-checked remote freeze script (`host-freeze-script.ts`);
 *   INVENTORY               run `migrator.sh --inventory` on the host: docker ps / volumes / `du` of binds / hub reach probe.
 *
 * Properties (asserted by `host-loop-script.spec.ts`, which runs the script for real against a fake ssh/docker/curl):
 *  - NO KEY MATERIAL is stored, read or printed: the script only reads the key DIRECTORY the run options name, and passes the
 *    key FILE PATH to `ssh -i`. The Coolify host's own database is asked only for `uuid, ip, port, user` and the key's uuid.
 *  - THE TOKEN IS ON NO ARGV: remote scripts travel on ssh's stdin, the inventory command reads its token from stdin; the hub
 *    POST gets it as a curl config on stdin.
 *  - IDEMPOTENT AND RESUMABLE: re-running it re-attaches to a launched migrator (`already`) instead of starting a second one,
 *    and the freeze re-reports its record; `TUGRA_LOOP_ONLY="ref ref"` restricts a re-run to some hosts, `TUGRA_LOOP_RELAUNCH=1`
 *    archives a launch that ended without a usable result, `TUGRA_LOOP_NO_WAIT=1` launches and returns.
 *  - STREAMS per-host status back: each state change is one `TUGRA_AT ... TUGRA_HOST` line, printed and POSTed to the hub at
 *    once (best effort: a Coolify host that cannot reach the hub still runs everything; the migrator reports its own progress).
 *  - EVERY interpolated value is validated here and embedded single-quoted (`shq`); the per-host values read from the Coolify
 *    database (ip, port, user) are validated in the shell before they reach `ssh`.
 *
 * The shell uses `@{` for brace expansion so the text can live in a `String.raw` template.
 */
import { assertSafeBase } from "../../../../importer/migration-command";
import { isMigrationToken } from "../../../../importer/migration-token";
import { SERVER_MAP_MAX } from "../../../core/run-contract";
import { assertSafeFlags, type MigratorPhase } from "../data-logic";
import { LAUNCH_MARK, MIGRATE_RUN_ROOT, MIG_MARK, buildLaunchTemplate, buildLauncherStatusScript, type LaunchTag } from "../launcher/migrator-launcher";
import { buildFreezeTemplate, freezePrelude } from "./host-freeze-script";
import { shq } from "./source-scripts";

export const LOOP_SCRIPT_STEPS = ["DATA_SEED", "FREEZE", "DATA_FINAL", "INVENTORY"] as const;
export type LoopScriptStep = (typeof LOOP_SCRIPT_STEPS)[number];

export interface LoopHostInput {
  /** The Coolify server uuid of the source host. */
  ref: string;
  /** The migrator flags for this host (the phase's flags plus one `--only <itemRef>` per item that lives here). */
  flags: readonly string[];
  /** FREEZE: the itemRefs (`app:`/`service:`/`database:`) whose containers this host stops. */
  freezeItems: readonly string[];
}

export interface HostLoopInput {
  runId: string;
  step: LoopScriptStep;
  /** DATA_SEED / DATA_FINAL: the migrator phase (names the remote run directory). */
  phase?: MigratorPhase;
  hubBase: string;
  token: string;
  hosts: readonly LoopHostInput[];
  keyDir: string;
  parallel: number;
  connectTimeoutSec: number;
  retries: number;
  /** FREEZE: the operator attested the stop-list items no container matched (`unresolved-items` no longer blocks). */
  allowUnresolved?: boolean;
  /** FREEZE: seconds `docker stop` waits. */
  graceSec?: number;
  /** Override of the remote run directory root (specs). */
  root?: string;
}

const REF_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KEYDIR_RE = /^\/[A-Za-z0-9._@/-]{1,200}$/;
const ITEM_RE = /^[a-z]+:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}(:[A-Za-z0-9_-]{1,64})?$/;

/** The attempt number of each phase's remote run directory: `inspect` and `warm-db` share the `seed` tag, so they must differ. */
export function launchAttemptFor(phase: MigratorPhase): number {
  return phase === "warm-db" ? 2 : 1;
}
export const launchTagFor = (phase: MigratorPhase): LaunchTag => (phase === "final" ? "final" : "seed");

/** The `--only` flags that restrict a migrator to the items of one host. */
export function onlyFlags(itemRefs: readonly string[]): string[] {
  return itemRefs.flatMap((r) => ["--only", r]);
}

const heredoc = (name: string, body: string): string => {
  if (body.split("\n").some((l) => l === name)) throw new Error("heredoc delimiter collision");
  return `cat <<'${name}'\n${body.replace(/\n$/, "")}\n${name}`;
};

const SCRIPT = String.raw`
#!/bin/sh
# Tugra coolify-host-loop: @@TITLE@@
# Run this ON THE COOLIFY HOST (as root, or a user that can read the key directory and use docker).
# Re-running is safe and resumes: a migrator that is already running on a host is re-attached, not started twice.
#   TUGRA_LOOP_ONLY="<server-uuid> ..."  restrict this run to some hosts        TUGRA_LOOP_NO_WAIT=1  launch and return
#   TUGRA_LOOP_RELAUNCH=1                start a host again whose launch ended without a usable result
#   TUGRA_LOOP_ACTION=unfreeze           (FREEZE only) start the stopped writers again, exactly the recorded containers
#   TUGRA_COOLIFY_DB=<container>         the Coolify database container (default coolify-db), asked only for server uuid/ip/port/user
set -u
umask 077
HUB=@@HUB@@
TOK=@@TOK@@
RUNID=@@RUNID@@
STEP=@@STEP@@
KEYDIR=@@KEYDIR@@
CTO=@@CTO@@
RETRIES=@@RETRIES@@
PAR=@@PAR@@
REFS=@@REFS@@
TAB=$(printf '\t')
ACTION=@{TUGRA_LOOP_ACTION:-run}
RELAUNCH=@{TUGRA_LOOP_RELAUNCH:-0}
NOWAIT=@{TUGRA_LOOP_NO_WAIT:-0}
POLL=@{TUGRA_LOOP_POLL:-20}
CDB=@{TUGRA_COOLIFY_DB:-coolify-db}
CDBUSER=@{TUGRA_COOLIFY_DB_USER:-coolify}
STATE=@{TUGRA_LOOP_STATE:-@{HOME:-/root}/.tugra-host-loop}
case "$ACTION" in run|unfreeze) ;; *) echo "TUGRA_LOOP_ACTION must be run or unfreeze" >&2; exit 2 ;; esac
case "$CDB$CDBUSER" in *[!A-Za-z0-9_.-]*) echo "invalid TUGRA_COOLIFY_DB / TUGRA_COOLIFY_DB_USER" >&2; exit 2 ;; esac
case "$POLL" in ''|*[!0-9]*) POLL=20 ;; esac
mkdir -p "$STATE" && chmod 700 "$STATE" || { echo "cannot create $STATE" >&2; exit 2; }
KH="$STATE/known_hosts"
W=$(mktemp -d "$STATE/w.XXXXXX") || { echo "cannot create a work directory" >&2; exit 2; }
trap 'rm -rf "$W"' EXIT
: > "$W/states"

@@FLAGS_FOR@@

@@ITEMS_FOR@@

@@BODIES@@

only() { case " @{TUGRA_LOOP_ONLY:-} " in "  ") return 0 ;; *" $1 "*) return 0 ;; esac; return 1; }

post_file() {
  [ -s "$1" ] || return 0
  printf 'header = "Authorization: Bearer %s"\n' "$TOK" | curl -sS --max-time 30 --config - -X POST -H 'Content-Type: text/plain' --data-binary "@$1" -o /dev/null "$HUB/import/migration/host-report" 2>/dev/null || printf 'note: could not post to the hub (this terminal keeps the report)\n' >&2
  return 0
}
flush() { post_file "$W/o.$ref"; : > "$W/o.$ref"; }
rep() { # state code rc
  printf 'TUGRA_AT\t%s\tTUGRA_HOST\t%s\t%s\t%s\t%s\n' "$ref" "$STEP" "$1" "$2" "$3" >> "$W/o.$ref"
  printf '[%s] %s %s%s\n' "$ref" "$1" "$2" "$( [ "$3" = - ] || printf ' rc=%s' "$3")"
  printf '%s %s\n' "$ref" "$1" >> "$W/states"
  flush
}

prelude_launch() {
  printf "L_TOKEN='%s'\n" "$TOK"
  printf "L_HUB='%s'\n" "$HUB"
  printf "L_RELAUNCH='%s'\n" "$RELAUNCH"
  printf "L_FLAGS='%s'\n" "$(flags_for "$1")"
}
prelude_freeze() {
  case "$ACTION" in unfreeze) act=unfreeze ;; *) act=freeze ;; esac
  printf "F_REF='%s'\nF_RUNID='%s'\nF_ACTION='%s'\nF_GRACE='@@GRACE@@'\nF_ALLOW_UNRESOLVED='@@ALLOW@@'\n" "$1" "$RUNID" "$act"
  printf "F_ITEMS='%s'\n" "$(items_for "$1")"
}
produce_launch() { prelude_launch "$ref"; body_launch; }
produce_status() { body_status; }
produce_freeze() { prelude_freeze "$ref"; body_freeze; }
produce_inventory() { printf '%s\n' "$TOK"; }

# run_remote <producer> [remote command]: the producer's output is the remote stdin; the remote output lands in $W/r.$ref.
# ssh exit 255 (could not connect) is retried; any other result is the remote's own.
run_remote() {
  cmd=@{2:-sh -s}
  try=0
  while :; do
    if [ "$LOCAL" = 1 ]; then "$1" | sh -c "$cmd" > "$W/r.$ref" 2>&1; rc=$?
    else "$1" | ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout="$CTO" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$KH" -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -p "$PORT" "$SSHUSER@$IP" "$cmd" > "$W/r.$ref" 2>&1; rc=$?
    fi
    if [ "$rc" = 255 ] && [ "$try" -lt "$RETRIES" ]; then try=$((try + 1)); sleep 3; continue; fi
    return $rc
  done
}

migrator_state() { awk -F"$TAB" '$1=="@@MIG@@" { print $2, $3; exit }' "$W/r.$ref"; }

act_migrate() {
  run_remote produce_launch; rc=$?
  if [ "$rc" = 255 ]; then rep unreachable ssh-failed -; return; fi
  if [ "$rc" != 0 ]; then rep failed "ssh-rc-$rc" -; return; fi
  res=$(awk -F"$TAB" '$1=="@@LAUNCH@@" { print $2; exit }' "$W/r.$ref")
  case "$res" in
    started) rep launched started - ;;
    already) rep already already - ;;
    fetch-failed) rep failed hub-unreachable-from-host -; return ;;
    mkdir-failed) rep failed mkdir-failed -; return ;;
    *) rep failed launch-unknown -; return ;;
  esac
  [ "$NOWAIT" = 1 ] && return
  last=""
  while :; do
    run_remote produce_status; rc=$?
    if [ "$rc" != 0 ]; then rep unreachable ssh-failed -; return; fi
    set -- $(migrator_state)
    s=@{1:-}
    c=@{2:-}
    case "$s" in
      finished)
        case "$c" in 0) code=ok ;; 1) code=partial ;; *) code="exit-$c" ;; esac
        rep finished "$code" "$c"; return ;;
      running) [ "$last" = running ] || rep running migrating -; last=running ;;
      died|none) rep died "$s" -; return ;;
      *) rep failed status-unknown -; return ;;
    esac
    sleep "$POLL"
  done
}

act_freeze() {
  run_remote produce_freeze; rc=$?
  grep '^TUGRA_AT' "$W/r.$ref" >> "$W/o.$ref"
  if [ "$rc" = 255 ]; then rep unreachable ssh-failed -; return; fi
  if [ "$rc" != 0 ]; then rep failed "ssh-rc-$rc" -; return; fi
  err=$(awk -F"$TAB" '$3=="TUGRA_FZ" && $4=="error" { print $5; exit }' "$W/r.$ref")
  if [ -n "$err" ]; then rep failed "$err" -; return; fi
  if awk -F"$TAB" '$3=="TUGRA_FZ" && $4=="done" { f=1 } END { exit !f }' "$W/r.$ref"; then
    if [ "$ACTION" = unfreeze ]; then rep finished unfrozen 0; else rep finished frozen 0; fi
  else rep failed no-result -; fi
}

act_inventory() {
  run_remote produce_inventory "IFS= read -r TK && curl -fsSL '$HUB/install/migrator.sh' | TUGRA_MIGRATION_TOKEN=\$TK sh -s -- --hub '$HUB' --inventory --server-ref '$ref'"; rc=$?
  grep '^TUGRA_AT' "$W/r.$ref" >> "$W/o.$ref"
  if [ "$rc" = 255 ]; then rep unreachable ssh-failed -; return; fi
  if awk -F"$TAB" '$3=="TUGRA_INV" && $4=="end" { f=1 } END { exit !f }' "$W/r.$ref"; then rep finished ok 0
  else rep failed hub-unreachable-from-host -; fi
}

do_host() {
  ref=$1
  only "$ref" || return 0
  : > "$W/o.$ref"
  rec=$(grep "^$ref|" "$W/hosts" 2>/dev/null | head -n 1)
  if [ -z "$rec" ]; then
    if [ "$LOOKUP_FAILED" = 1 ]; then rep no-host lookup-failed -; else rep no-host host-unknown -; fi
    return
  fi
  IP=$(printf '%s' "$rec" | cut -d'|' -f2)
  PORT=$(printf '%s' "$rec" | cut -d'|' -f3)
  SSHUSER=$(printf '%s' "$rec" | cut -d'|' -f4)
  KEYU=$(printf '%s' "$rec" | cut -d'|' -f5)
  [ -n "$PORT" ] || PORT=22
  [ -n "$SSHUSER" ] || SSHUSER=root
  case "$IP" in ''|-*|*[!A-Za-z0-9._:-]*) rep no-host ip-invalid -; return ;; esac
  case "$PORT" in ''|*[!0-9]*) rep no-host port-invalid -; return ;; esac
  case "$SSHUSER" in ''|-*|[!a-z_]*|*[!a-z0-9_-]*) rep no-host user-invalid -; return ;; esac
  case "$KEYU" in *[!A-Za-z0-9_-]*) rep no-key key-invalid -; return ;; esac
  LOCAL=0
  case "$IP" in host.docker.internal|localhost|127.0.0.1|::1) LOCAL=1 ;; esac
  KEY=""
  if [ "$LOCAL" = 0 ]; then
    for cand in @{KEYU:+"$KEYDIR/ssh_key@$KEYU"} "$KEYDIR/ssh_key@$ref"; do
      if [ -r "$cand" ]; then KEY=$cand; break; fi
    done
    if [ -z "$KEY" ]; then rep no-key key-missing -; return; fi
  fi
  rep connecting ssh -
  case "$STEP" in
    FREEZE) act_freeze ;;
    INVENTORY) act_inventory ;;
    *) act_migrate ;;
  esac
}

if [ "$STEP" = FREEZE ] || [ "$ACTION" = run ]; then :; else echo "TUGRA_LOOP_ACTION=unfreeze applies to the FREEZE step only" >&2; exit 2; fi

LOOKUP_FAILED=0
LIST=$(for r in $REFS; do printf "'%s'," "$r"; done | sed 's/,$//')
SQL="select s.uuid, s.ip, s.port, s.\"user\", coalesce(k.uuid, '') from servers s left join private_keys k on k.id = s.private_key_id where s.uuid in ($LIST)"
if ! docker exec -i "$CDB" psql -U "$CDBUSER" -d coolify -At -F '|' -c "$SQL" > "$W/hosts" 2>"$W/hosts.err" </dev/null; then LOOKUP_FAILED=1; : > "$W/hosts"; fi

echo "Tugra host loop: @@TITLE@@ ($(printf '%s\n' $REFS | wc -l | tr -d ' ') hosts, parallel $PAR)"
i=0
for r in $REFS; do
  do_host "$r" &
  i=$((i + 1))
  if [ "$i" -ge "$PAR" ]; then wait; i=0; fi
done
wait

bad=0
for r in $REFS; do
  only "$r" || continue
  s=$(grep "^$r " "$W/states" | tail -n 1 | cut -d' ' -f2)
  case "$s" in unreachable|no-key|no-host|failed|died|'') bad=$((bad + 1)) ;; esac
done
echo "Done: $bad of $(printf '%s\n' $REFS | wc -l | tr -d ' ') hosts need attention. Re-run this script to retry them (it resumes)."
[ "$bad" = 0 ]
`;

/** Build the script. Throws (a plain Error) on any input that is not safe to embed in a shell script run as root. */
export function buildHostLoopScript(i: HostLoopInput): string {
  assertSafeBase(i.hubBase);
  if (!isMigrationToken(i.token)) throw new Error("invalid migration token");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(i.runId)) throw new Error("invalid run id");
  if (!(LOOP_SCRIPT_STEPS as readonly string[]).includes(i.step)) throw new Error("unsupported step");
  if (!KEYDIR_RE.test(i.keyDir) || i.keyDir.includes("..") || i.keyDir.includes("//")) throw new Error("invalid key directory");
  if (!Number.isInteger(i.parallel) || i.parallel < 1 || i.parallel > 8) throw new Error("invalid parallel");
  if (!Number.isInteger(i.connectTimeoutSec) || i.connectTimeoutSec < 5 || i.connectTimeoutSec > 120) throw new Error("invalid connect timeout");
  if (!Number.isInteger(i.retries) || i.retries < 0 || i.retries > 5) throw new Error("invalid retries");
  const hosts = [...i.hosts].sort((a, b) => (a.ref < b.ref ? -1 : 1));
  if (hosts.length === 0 || hosts.length > SERVER_MAP_MAX) throw new Error("invalid host list");
  if (new Set(hosts.map((h) => h.ref)).size !== hosts.length) throw new Error("duplicate host");
  for (const h of hosts) {
    if (!REF_RE.test(h.ref)) throw new Error("invalid host ref");
    assertSafeFlags(h.flags);
    if (h.freezeItems.length > 2000 || h.freezeItems.some((x) => !ITEM_RE.test(x))) throw new Error("invalid freeze item");
  }
  const dataStep = i.step === "DATA_SEED" || i.step === "DATA_FINAL";
  if (dataStep && !i.phase) throw new Error("a data step needs its phase");
  const root = i.root ?? MIGRATE_RUN_ROOT;
  const phase: MigratorPhase = i.phase ?? "inspect";
  const attempt = launchAttemptFor(phase);
  const tag = launchTagFor(phase);

  const bodies: string[] = [];
  if (i.step === "FREEZE") {
    bodies.push(`body_freeze() {\n${heredoc("TUGRA_BODY_FREEZE", buildFreezeTemplate(root))}\n}`);
    // keep the prelude validator honest: it is the one that rejects a bad grace/run id for the remote text
    freezePrelude({ ref: hosts[0].ref, runId: i.runId, action: "freeze", items: hosts[0].freezeItems, graceSec: i.graceSec ?? 120, allowUnresolved: !!i.allowUnresolved });
  }
  if (dataStep) {
    bodies.push(`body_launch() {\n${heredoc("TUGRA_BODY_LAUNCH", buildLaunchTemplate({ runId: i.runId, attempt, root, tag }))}\n}`);
    bodies.push(`body_status() {\n${heredoc("TUGRA_BODY_STATUS", buildLauncherStatusScript(i.runId, attempt, root, tag))}\n}`);
  }

  const flagsFor = [
    "flags_for() {",
    '  case "$1" in',
    ...hosts.map((h) => `    ${shq(h.ref)}) ${h.flags.length ? `printf '%s\\n' ${h.flags.map(shq).join(" ")}` : ":"} ;;`),
    "  esac",
    "}",
  ].join("\n");
  const itemsFor = [
    "items_for() {",
    '  case "$1" in',
    ...hosts.map((h) => `    ${shq(h.ref)}) ${h.freezeItems.length ? `printf '%s\\n' ${h.freezeItems.map(shq).join(" ")}` : ":"} ;;`),
    "  esac",
    "}",
  ].join("\n");

  const title = `${i.step}${dataStep ? ` (${phase})` : ""} for run ${i.runId}`;
  const text = SCRIPT.replace(/^\n/, "")
    .replaceAll("@{", () => "${")
    .replaceAll("@@TITLE@@", () => title)
    .replace("@@HUB@@", () => shq(i.hubBase))
    .replace("@@TOK@@", () => shq(i.token))
    .replace("@@RUNID@@", () => shq(i.runId))
    .replace("@@STEP@@", () => shq(i.step))
    .replace("@@KEYDIR@@", () => shq(i.keyDir))
    .replace("@@CTO@@", () => String(i.connectTimeoutSec))
    .replace("@@RETRIES@@", () => String(i.retries))
    .replace("@@PAR@@", () => String(i.parallel))
    .replace("@@REFS@@", () => shq(hosts.map((h) => h.ref).join(" ")))
    .replace("@@FLAGS_FOR@@", () => flagsFor)
    .replace("@@ITEMS_FOR@@", () => itemsFor)
    .replace("@@BODIES@@", () => bodies.join("\n\n"))
    .replace("@@GRACE@@", () => String(i.graceSec ?? 120))
    .replace("@@ALLOW@@", () => i.allowUnresolved ? "1" : "0")
    .replace("@@MIG@@", () => MIG_MARK)
    .replace("@@LAUNCH@@", () => LAUNCH_MARK);
  return text;
}

/**
 * The command the operator pastes on the Coolify host: the script runs through `sh -s` fed by a quoted here-document, so the
 * token (inside the script) is never written to a file and no shell history entry holds more than the one pasted block.
 * Prefix the first line with `VAR=value` to set the script's knobs (`TUGRA_LOOP_ONLY`, `TUGRA_LOOP_NO_WAIT`, ...).
 */
export function wrapHostLoopCommand(script: string): string {
  const delim = "TUGRA_HOST_LOOP_EOF";
  if (script.split("\n").some((l) => l === delim)) throw new Error("heredoc delimiter collision");
  return `sh -s <<'${delim}'\n${script.replace(/\n$/, "")}\n${delim}\n`;
}
