import { shq } from "../deploy/deploy-script";
import { wrapHostExec } from "../server-ops/patch-script";
import { PM2_NAME_RE, PM2_USER_RE, isSafePm2Name } from "./pm2-facts";

/**
 * The in-place cutover of ONE PM2 process, as one script for the agent's shell (bash). Phases:
 *
 *   precheck  the process is online in PM2 (and the account / pm2 binary resolve)           nothing changed yet
 *   pull      the node image is pulled and tagged BEFORE the process is touched              nothing changed yet
 *   stop      pm2 stop <name>   (the process stays in PM2, stopped)                          downtime starts
 *   start     the Tugra container is started (the normal Tugra `docker run` script)
 *   health    the container keeps running, the port listens, an optional HTTP path answers
 *   delete    pm2 delete <name> + pm2 save   (only after a healthy container)                downtime over
 *   rollback  any failure after `stop`: remove the container, `pm2 restart <name>`, wait for the port
 *
 * Everything that must act on the host's PM2 (a host process tree, a host user, host paths) runs through the same
 * audited `wrapHostExec` (privileged helper + nsenter into PID 1) that patching uses; the container itself is started
 * by the agent's own docker, exactly like any Tugra deploy. Nothing here ever prints an environment value.
 *
 * Output protocol (stdout): `TUGRA_PM2MOVE: step=<s>` progress and exactly one final `TUGRA_PM2MOVE: result=<r> reason=<code>`.
 * Anything that comes from the app or docker is prefixed (`TUGRA_PM2MOVE_LOG:` / `TUGRA_PM2MOVE_ERR:`) after being reduced
 * to printable ASCII, so it can never pass for a protocol line.
 */

export const MOVE_PREFIX = "TUGRA_PM2MOVE: ";
export const MOVE_LOG_PREFIX = "TUGRA_PM2MOVE_LOG: ";
export const MOVE_ERR_PREFIX = "TUGRA_PM2MOVE_ERR: ";

export const HEALTH_TIMEOUT_SEC_DEFAULT = 60;
const HOST_DEADLINE = { deadlineSec: 90, killSec: 10 };
/** The longest a whole move script may run: pull 300 + stop/port wait ~40 + start ~60 + health + delete/rollback ~150. */
export const MOVE_SCRIPT_TIMEOUT_MS = 12 * 60_000;
export const RECOVER_SCRIPT_TIMEOUT_MS = 4 * 60_000;

export interface Pm2ScriptInput {
  appId: string;
  user: string;
  home: string;
  userUid: number;
  name: string;
  image: string;
  /** The directory of the node binary PM2 ran with (a sibling `pm2` is looked for there first). */
  interpreterDir: string | null;
  healthPort: number | null;
  probePath: string | null;
  healthTimeoutSec?: number;
  /** The Tugra `docker run` script of the app (ApplicationsService.buildLocalRunScript). Only the move script uses it. */
  runScript?: string;
  /** Local tag the pulled image is given (`tugra_<id>:<version>`); the run script starts exactly this tag. */
  tag: string;
}

const HOME_RE = /^\/(root|home\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})$/;
const IMAGE_RE = /^node:\d{2}$/;
const DIR_RE = /^\/[A-Za-z0-9._@+/-]{1,512}$/;
const TAG_RE = /^tugra_[A-Za-z0-9]{1,40}:[A-Za-z0-9_.-]{1,64}$/;
const APP_RE = /^[A-Za-z0-9]{1,40}$/;

function assertInput(i: Pm2ScriptInput): void {
  if (!APP_RE.test(i.appId)) throw new Error("invalid app id");
  if (!PM2_USER_RE.test(i.user) || !HOME_RE.test(i.home)) throw new Error("invalid pm2 account");
  if (!Number.isInteger(i.userUid) || i.userUid < 0) throw new Error("invalid pm2 uid");
  if (!PM2_NAME_RE.test(i.name) || !isSafePm2Name(i.name)) throw new Error("invalid pm2 process name");
  if (!IMAGE_RE.test(i.image)) throw new Error("invalid node image");
  if (i.interpreterDir !== null && !DIR_RE.test(i.interpreterDir)) throw new Error("invalid interpreter dir");
  if (i.healthPort !== null && !(Number.isInteger(i.healthPort) && i.healthPort >= 1 && i.healthPort <= 65535)) throw new Error("invalid port");
  if (i.probePath !== null && !/^\/[A-Za-z0-9._~/-]{0,200}$/.test(i.probePath)) throw new Error("invalid probe path");
  if (!TAG_RE.test(i.tag) || !i.tag.startsWith(`tugra_${i.appId}:`)) throw new Error("invalid image tag");
}

type HostOp = "pid" | "stop" | "start" | "delete";

/** The script the HOST shell (POSIX sh, nsenter'd into PID 1) runs for one PM2 operation. */
export function hostPm2Inner(op: HostOp, i: Pick<Pm2ScriptInput, "user" | "home" | "userUid" | "name" | "interpreterDir">): string {
  const lines = [
    `U=${shq(i.user)}; H=${shq(i.home)}; N=${shq(i.name)}; WANT_UID=${i.userUid}; HINT=${shq(i.interpreterDir ?? "")}`,
    '[ "$(id -u "$U" 2>/dev/null)" = "$WANT_UID" ] || { echo "TUGRA_PM2_ERR=user"; exit 21; }',
    '[ -d "$H/.pm2" ] || { echo "TUGRA_PM2_ERR=nohome"; exit 22; }',
    'BIN=""',
    'for c in "${HINT:+$HINT/pm2}" /usr/local/bin/pm2 /usr/bin/pm2 "$H/.volta/bin/pm2" "$H/.local/bin/pm2" "$H/.npm-global/bin/pm2" "$H/.yarn/bin/pm2"; do',
    '  [ -n "$c" ] && [ -x "$c" ] && { BIN="$c"; break; }',
    "done",
    'if [ -z "$BIN" ]; then for d in $(ls -d "$H"/.nvm/versions/node/*/bin 2>/dev/null | sort -V -r); do [ -x "$d/pm2" ] && { BIN="$d/pm2"; break; }; done; fi',
    '[ -n "$BIN" ] || { echo "TUGRA_PM2_ERR=nobin"; exit 23; }',
    'BD=$(dirname "$BIN")',
    'if [ "$U" != root ]; then command -v runuser >/dev/null 2>&1 || { echo "TUGRA_PM2_ERR=norunuser"; exit 24; }; fi',
    // `pm2 <seconds> <args...>`: the bounded call lives INSIDE the function (`timeout` cannot run a shell function).
    'pm2() { t=$1; shift; if [ "$U" = root ]; then timeout "$t" env HOME="$H" PM2_HOME="$H/.pm2" PATH="$BD:/usr/local/bin:/usr/bin:/bin" "$BIN" "$@"; else timeout "$t" runuser -u "$U" -- env HOME="$H" PM2_HOME="$H/.pm2" PATH="$BD:/usr/local/bin:/usr/bin:/bin" "$BIN" "$@"; fi; }',
    // Exactly one live pid (a cluster or a duplicate would print several); empty / 0 / text means "not running".
    'pidof_() { p=$(pm2 30 pid "$N" 2>/dev/null | tr -d "[:space:]"); case "$p" in ""|0|*[!0-9]*) echo 0;; *) echo "$p";; esac; }',
    'report() { echo "TUGRA_PM2_PID=$(pidof_)"; if pm2 30 describe "$N" >/dev/null 2>&1; then echo "TUGRA_PM2_EXISTS=1"; else echo "TUGRA_PM2_EXISTS=0"; fi; }',
  ];
  switch (op) {
    case "pid":
      lines.push("report");
      break;
    case "stop":
      lines.push(
        'pm2 60 stop "$N" >/dev/null 2>&1',
        "n=0; while [ $n -lt 15 ]; do [ \"$(pidof_)\" = 0 ] && break; n=$((n+1)); sleep 1; done",
        '[ "$(pidof_)" = 0 ] && echo "TUGRA_PM2_STOPPED=1" || echo "TUGRA_PM2_STOPPED=0"',
      );
      break;
    case "start":
      lines.push(
        'pm2 60 restart "$N" >/dev/null 2>&1',
        "n=0; while [ $n -lt 20 ]; do [ \"$(pidof_)\" != 0 ] && break; n=$((n+1)); sleep 1; done",
        '[ "$(pidof_)" != 0 ] && echo "TUGRA_PM2_STARTED=1" || echo "TUGRA_PM2_STARTED=0"',
      );
      break;
    case "delete":
      lines.push(
        'if pm2 60 delete "$N" >/dev/null 2>&1; then echo "TUGRA_PM2_DELETED=1"; else echo "TUGRA_PM2_DELETED=0"; fi',
        'if pm2 60 save --force >/dev/null 2>&1 || pm2 60 save >/dev/null 2>&1; then echo "TUGRA_PM2_SAVED=1"; else echo "TUGRA_PM2_SAVED=0"; fi',
      );
      break;
  }
  return lines.join("\n");
}

/** A bash function body running one host op through the privileged helper; `( … )` keeps the wrapper's `exit`s local. */
function hostFn(op: HostOp, i: Pm2ScriptInput): string {
  return `hx_${op}() (\n${wrapHostExec(hostPm2Inner(op, i), HOST_DEADLINE)}\n)`;
}

/** The shell fragments both scripts share: markers, host ops with retry, and the probes (all done with the node image itself). */
function common(i: Pm2ScriptInput): string[] {
  const probeFor = (port: number) => `docker run --rm --pull never --network host --entrypoint bash "$NIMG" -c 'if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then exit 0; else exit 42; fi' >/dev/null 2>&1`;
  return [
    "set +e",
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `M() { echo "${MOVE_PREFIX}$*"; }`,
    `NAME=${shq(`tugra_${i.appId}`)}; TAG=${shq(i.tag)}; NIMG=${shq(i.image)}; ENVF=${shq(`/etc/tugra/env/${i.appId}.env`)}`,
    hostFn("pid", i),
    hostFn("stop", i),
    hostFn("start", i),
    hostFn("delete", i),
    // A host op can lose the single-slot helper name (a patch check running); retry before giving up.
    'hxrun() { local n=0 o=""; while [ $n -lt 6 ]; do o=$("hx_$1" 2>&1); if printf %s "$o" | grep -q "TUGRA_HOST_ENTERED"; then printf "%s\\n" "$o"; return 0; fi; n=$((n+1)); sleep 4; done; printf "%s\\n" "$o"; return 1; }',
    // Not listening = exit 42 from the probe; anything else that is not 0 (docker itself failed) is NOT read as "listening".
    ...(i.healthPort === null
      ? ["listening() { return 1; }", "free() { return 0; }"]
      : [`probe() { ${probeFor(i.healthPort)}; }`, "listening() { probe; [ $? -eq 0 ]; }", "free() { probe; [ $? -eq 42 ]; }"]),
    'sanitize() { tr -cd "[:print:]\\n" | cut -c1-300; }',
  ];
}

/** Wait (bounded) for the process to be reachable again after a restart; never fails the rollback itself. */
function waitBack(i: Pm2ScriptInput): string[] {
  if (i.healthPort === null) return [];
  return ["n=0; while [ $n -lt 20 ]; do listening && break; n=$((n+1)); sleep 1; done"];
}

function rollbackFn(i: Pm2ScriptInput): string[] {
  return [
    "rollback() {",
    '  M "step=rollback"',
    // Last lines of the container's own output explain most failures (EADDRINUSE, a missing module, ...).
    `  docker logs --tail 15 "$NAME" 2>&1 | sanitize | sed 's/^/${MOVE_LOG_PREFIX}/'`,
    '  docker rm -f "$NAME" >/dev/null 2>&1',
    '  docker rmi "$TAG" >/dev/null 2>&1',
    '  rm -f "$ENVF"',
    '  o=$(hxrun start)',
    '  if printf %s "$o" | grep -q "TUGRA_PM2_STARTED=1"; then',
    ...waitBack(i).map((l) => `    ${l}`),
    '    M "result=rolled_back reason=$1"',
    "  else",
    '    M "result=rollback_failed reason=$1"',
    "  fi",
    "  exit 0",
    "}",
  ];
}

/** The reason code a failed host op reports (`TUGRA_PM2_ERR=`, or the helper's own unavailable marker). */
const HOST_REASON =
  'hostreason() { r=$(printf %s "$1" | sed -n "s/.*TUGRA_PM2_ERR=\\([a-z]*\\).*/\\1/p" | head -n1); if [ -z "$r" ]; then if printf %s "$1" | grep -q TUGRA_HOST_UNAVAILABLE; then r=host_unavailable; else r=not_online; fi; fi; echo "$r"; }';

export function buildPm2MoveScript(i: Pm2ScriptInput): string {
  assertInput(i);
  if (!i.runScript) throw new Error("the Tugra run script is required");
  const timeout = Math.max(10, Math.min(300, Math.trunc(i.healthTimeoutSec ?? HEALTH_TIMEOUT_SEC_DEFAULT)));
  const httpProbe = i.healthPort !== null && i.probePath !== null;
  const url = httpProbe ? `http://127.0.0.1:${i.healthPort}${i.probePath}` : "";
  return [
    ...common(i),
    HOST_REASON,
    // The Tugra deploy script (env file, docker rm -f, docker run ...) as a function; its own `set -e` stays inside the subshell.
    `run_container() (\n${i.runScript}\n)`,
    ...rollbackFn(i),
    // ── precheck ──
    'M "step=precheck"',
    "o=$(hxrun pid)",
    'if ! printf %s "$o" | grep -q "TUGRA_PM2_PID=[1-9][0-9]*$"; then M "result=aborted reason=$(hostreason "$o")"; exit 0; fi',
    // ── pull (before any downtime) ──
    'M "step=pull"',
    'if ! timeout 300 docker pull -q "$NIMG" >/dev/null 2>&1 || ! docker tag "$NIMG" "$TAG" >/dev/null 2>&1; then M "result=aborted reason=pull_failed"; exit 0; fi',
    // ── stop ──
    'M "step=stop"',
    'o=$(hxrun stop)',
    'if ! printf %s "$o" | grep -q "TUGRA_PM2_STOPPED=1"; then',
    "  o2=$(hxrun start)",
    '  docker rmi "$TAG" >/dev/null 2>&1',
    '  if printf %s "$o2" | grep -q "TUGRA_PM2_STARTED=1"; then M "result=aborted reason=stop_failed"; else M "result=rollback_failed reason=stop_failed"; fi',
    "  exit 0",
    "fi",
    // From here the process is down: a kill or hangup still tries to put it back.
    "trap 'rollback interrupted' TERM INT HUP",
    ...(i.healthPort !== null
      ? [
          'n=0; while [ $n -lt 15 ]; do free && break; n=$((n+1)); sleep 1; done',
          'free || rollback port_busy',
        ]
      : []),
    // ── start ──
    'M "step=start"',
    "out=$(run_container 2>&1); rc=$?",
    'if [ $rc -ne 0 ]; then printf %s "$out" | sanitize | tail -n 6 | sed \'s/^/' + MOVE_ERR_PREFIX + "/'; rollback start_failed; fi",
    // ── health ──
    'M "step=health"',
    "ok=0; reason=not_listening; t0=$SECONDS",
    ...(i.healthPort !== null
      ? [
          `while [ $((SECONDS - t0)) -lt ${timeout} ]; do`,
          '  if [ "$(docker inspect -f "{{.State.Running}}" "$NAME" 2>/dev/null)" != true ]; then reason=container_exited; break; fi',
          "  if listening; then",
          ...(httpProbe
            ? [
                `    code=$(timeout 20 docker run --rm --pull never --network host --entrypoint node "$NIMG" -e 'const u=process.argv[1];const r=require("http").get(u,{timeout:5000},s=>{process.stdout.write(String(s.statusCode));s.resume();});r.on("error",()=>process.stdout.write("000"));r.on("timeout",()=>{r.destroy();});' ${shq(url)} 2>/dev/null | tr -cd "0-9")`,
                '    if [ -n "$code" ] && [ "$code" != 000 ] && [ "$code" -lt 500 ]; then ok=1; break; fi',
                "    reason=http_failed",
              ]
            : ["    ok=1; break"]),
          "  fi",
          "  sleep 2",
          "done",
        ]
      : [
          // No known port: the best honest check is "it keeps running, without restarting, for a while".
          "sleep 12",
          'if [ "$(docker inspect -f "{{.State.Running}} {{.RestartCount}}" "$NAME" 2>/dev/null)" = "true 0" ]; then ok=1; else reason=container_exited; fi',
        ]),
    // A process that is up but already restarted once is crash-looping, not healthy.
    'if [ $ok -eq 1 ] && [ "$(docker inspect -f "{{.State.Running}} {{.RestartCount}}" "$NAME" 2>/dev/null)" != "true 0" ]; then ok=0; reason=container_exited; fi',
    'if [ $ok -ne 1 ]; then rollback "$reason"; fi',
    // ── delete from PM2 ──
    'M "step=delete"',
    "trap - TERM INT HUP",
    "o=$(hxrun delete)",
    'if printf %s "$o" | grep -q "TUGRA_PM2_DELETED=1" && printf %s "$o" | grep -q "TUGRA_PM2_SAVED=1"; then M "result=moved reason=ok"; else M "result=moved_pm2_left reason=delete_failed"; fi',
    "exit 0",
  ].join("\n");
}

/**
 * Outcome unknown (the move command timed out, the agent dropped, the hub restarted): put the process back the way it was.
 * Never touches a container that is the live result of a completed move: if PM2 no longer has the process at all, the
 * move had reached its last step, so the container is kept and reported as moved.
 */
export function buildPm2RecoverScript(i: Omit<Pm2ScriptInput, "runScript">): string {
  assertInput(i);
  return [
    ...common(i),
    HOST_REASON,
    ...rollbackFn(i),
    'M "step=recover"',
    "o=$(hxrun pid)",
    'if ! printf %s "$o" | grep -q "TUGRA_PM2_EXISTS="; then M "result=rollback_failed reason=$(hostreason "$o")"; exit 0; fi',
    'if printf %s "$o" | grep -q "TUGRA_PM2_PID=[1-9][0-9]*$"; then',
    '  docker rm -f "$NAME" >/dev/null 2>&1; docker rmi "$TAG" >/dev/null 2>&1; rm -f "$ENVF"',
    '  M "result=rolled_back reason=recovered"; exit 0',
    "fi",
    'if printf %s "$o" | grep -q "TUGRA_PM2_EXISTS=0"; then',
    '  if [ "$(docker inspect -f "{{.State.Running}}" "$NAME" 2>/dev/null)" = true ]; then M "result=moved reason=recovered"; else M "result=rollback_failed reason=gone"; fi',
    "  exit 0",
    "fi",
    'rollback recovered',
  ].join("\n");
}

// ── output ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type MoveResult = "moved" | "moved_pm2_left" | "rolled_back" | "rollback_failed" | "aborted" | "unknown";
export interface MoveOutcome {
  result: MoveResult;
  reason: string | null;
  steps: string[];
  logTail: string[];
  errTail: string[];
}

const RESULTS = new Set<MoveResult>(["moved", "moved_pm2_left", "rolled_back", "rollback_failed", "aborted"]);
const CTRL = /[^\x20-\x7e]/g;

/** The script's stdout -> its outcome. No final marker = "unknown" (the caller runs the recovery). */
export function parsePm2MoveOutput(output: string): MoveOutcome {
  const out: MoveOutcome = { result: "unknown", reason: null, steps: [], logTail: [], errTail: [] };
  for (const raw of output.split(/\r?\n/)) {
    if (raw.startsWith(MOVE_LOG_PREFIX)) {
      if (out.logTail.length < 15) out.logTail.push(raw.slice(MOVE_LOG_PREFIX.length).replace(CTRL, " ").slice(0, 300));
      continue;
    }
    if (raw.startsWith(MOVE_ERR_PREFIX)) {
      if (out.errTail.length < 6) out.errTail.push(raw.slice(MOVE_ERR_PREFIX.length).replace(CTRL, " ").slice(0, 300));
      continue;
    }
    if (!raw.startsWith(MOVE_PREFIX)) continue;
    const body = raw.slice(MOVE_PREFIX.length);
    const step = /^step=([a-z]{1,20})$/.exec(body);
    if (step) {
      if (out.steps.length < 20) out.steps.push(step[1]);
      continue;
    }
    const res = /^result=([a-z_]{1,20}) reason=([a-z_]{1,40})$/.exec(body);
    if (res && RESULTS.has(res[1] as MoveResult)) {
      out.result = res[1] as MoveResult;
      out.reason = res[2];
    }
  }
  return out;
}
