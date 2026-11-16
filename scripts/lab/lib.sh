#!/usr/bin/env bash
# Shared helpers for the migration lab (scripts/lab/*). Sourced, never executed. See docs/runbooks/migration-lab.md.
# shellcheck shell=bash

LAB_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAB_ROOT="$(cd "$LAB_SELF_DIR/../.." && pwd)"
: "${LAB_DIR:=${TMPDIR:-/tmp}/tugra-lab}"
: "${LAB_REGISTRY_PORT:=5000}"
: "${LAB_IMAGE:=localhost:${LAB_REGISTRY_PORT}/tugra-agent:lab}"
: "${LAB_HUB_PORT:=3000}"
: "${LAB_PG_PORT:=5433}"
: "${LAB_HELPER_IMAGE:=}" # the alpine busybox pin, resolved lazily from the hub source
: "${SRC_CONTAINER:=labsrc}" # the migrator source: a stopped container named after the sourceRef
: "${SRC_VOLUME:=lab-src}"
export LAB_DIR LAB_IMAGE LAB_HUB_PORT SRC_CONTAINER SRC_VOLUME

mkdir -p "$LAB_DIR"

lab_log() { printf '[lab %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
lab_die() { printf '[lab] FAIL: %s\n' "$*" >&2; exit 1; }
lab_pass() { printf '[lab] PASS: %s\n' "$*" >&2; }

# lab_check <description> <command...>: runs the command and fails the scenario (exit 1) when it is false.
lab_check() {
  local what="$1"; shift
  if "$@"; then lab_log "ok: $what"; else lab_die "$what"; fi
}

# lab_guard_destructive: the lab removes containers, volumes and /etc/tugra/app-moves staging on the docker host it runs on and
# starts an agent against the host's docker.sock and /etc/tugra. On a host that already runs Tugra that is data loss, so it only
# runs where the host is disposable: a CI runner (CI=true, which GitHub Actions sets) or when explicitly acknowledged.
lab_guard_destructive() {
  [ "${CI:-}" = true ] || [ "${LAB_I_UNDERSTAND_DESTRUCTIVE:-}" = 1 ] ||
    lab_die "refusing to run: the migration lab removes containers, volumes and /etc/tugra/app-moves staging on THIS docker host. Run it on a disposable host (CI=true) or export LAB_I_UNDERSTAND_DESTRUCTIVE=1"
}

lab_need() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || lab_die "missing tool: $c"; done
}

# The address a container uses to reach a process on the HOST. Linux: the docker0 gateway (the hub listens on all
# interfaces). Docker Desktop: host.docker.internal.
lab_host_addr() {
  if [ -n "${LAB_HOST:-}" ]; then printf '%s' "$LAB_HOST"; return; fi
  local gw
  gw="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"
  if [ "$(uname -s)" = "Linux" ] && [ -n "$gw" ]; then printf '%s' "$gw"; else printf 'host.docker.internal'; fi
}

lab_load() {
  [ -f "$LAB_DIR/lab.env" ] || lab_die "no $LAB_DIR/lab.env: run scripts/lab/up.sh first"
  set -a
  # shellcheck disable=SC1091
  . "$LAB_DIR/lab.env"
  set +a
}

# lab_op_load [name]: load the op written by lab_scenario_begin (OP_ID, MIG_TOKEN, ITEMREF, DEST_VOLUME, ...).
lab_op_load() {
  local f="$LAB_DIR/op.${1:-main}.env"
  [ -f "$f" ] || lab_die "no op env $f"
  set -a
  # shellcheck disable=SC1090
  . "$f"
  set +a
}

lab_seed() { node "$LAB_SELF_DIR/seed.mjs" "$@"; }

# lab_refresh_token: a fresh user access token in lab.env's sidecar (the JWT lives ~15 min; long scenarios re-login).
lab_refresh_token() {
  local f="$LAB_DIR/user.token"
  if [ -s "$f" ] && [ -z "$(find "$f" -mmin +8 2>/dev/null)" ]; then return 0; fi
  lab_seed token >"$f.tmp" && mv "$f.tmp" "$f"
}

# lab_api METHOD PATH [JSON]: call the hub REST API as the lab user (loopback). Prints the body, fails on HTTP >= 400.
lab_api() {
  lab_refresh_token
  local m="$1" p="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$m" -H "Authorization: Bearer $(cat "$LAB_DIR/user.token")" -H 'Content-Type: application/json' --data "$body" "http://127.0.0.1:${LAB_HUB_PORT}/api/v1${p}"
  else
    curl -fsS -X "$m" -H "Authorization: Bearer $(cat "$LAB_DIR/user.token")" "http://127.0.0.1:${LAB_HUB_PORT}/api/v1${p}"
  fi
}

# lab_wait <seconds> <description> <command...>: poll once a second until the command succeeds.
lab_wait() {
  local t="$1" what="$2"; shift 2
  local i=0
  while [ "$i" -lt "$t" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  lab_die "timed out after ${t}s waiting for: $what"
}

# lab_transfer [op]: the op's volume transfer as one line "STATE PARTS_DONE ERROR ATTEMPT" (from the hub database).
lab_transfer() { lab_seed transfer "${1:-$OP_ID}"; }
lab_transfer_state() { lab_transfer "${1:-$OP_ID}" | awk '{print $1}'; }

# lab_agent_exec <cmd...>: run a command inside the target agent container.
lab_agent_exec() { docker exec "${LAB_AGENT:-lab-agent}" "$@"; }

# The staging root of the target agent (host /etc/tugra is bind-mounted into the agent container).
lab_staging_dirs() { lab_agent_exec sh -c 'ls -1 /etc/tugra/app-moves 2>/dev/null || true'; }

lab_helper_image() {
  if [ -z "$LAB_HELPER_IMAGE" ]; then
    LAB_HELPER_IMAGE="$(grep -A1 '^export const BACKUP_HELPER_IMAGE' "$LAB_ROOT/apps/hub-api/src/volume-backups/volume-backup-script.ts" | grep -o '"[^"]*"' | head -1 | tr -d '"')"
    [ -n "$LAB_HELPER_IMAGE" ] || lab_die "could not read BACKUP_HELPER_IMAGE from the hub source"
  fi
  printf '%s' "$LAB_HELPER_IMAGE"
}

# Containers and volumes a scenario may leave behind (labsrc is the migrator source, tugra-vx-* the tar helpers).
lab_reset_source() {
  docker rm -f "${SRC_CONTAINER:-labsrc}" >/dev/null 2>&1 || true
  docker volume rm -f "${SRC_VOLUME:-lab-src}" >/dev/null 2>&1 || true
  docker volume create "${SRC_VOLUME:-lab-src}" >/dev/null
  docker create --name "${SRC_CONTAINER:-labsrc}" -v "${SRC_VOLUME:-lab-src}:/var/www/data" alpine:3.21 sleep 86400 >/dev/null
}

# lab_scenario_begin <name> [seed args...]: a fresh source volume/container and a fresh import op + app (or database)
# on the lab target; writes $LAB_DIR/op.main.env and loads it. Idempotent per scenario name.
lab_scenario_begin() {
  local name="$1"; shift
  lab_guard_destructive
  lab_load
  lab_log "=== scenario $name ==="
  lab_clean_leftovers
  if [ "${LAB_SKIP_SOURCE:-0}" = 1 ]; then docker rm -f "${SRC_CONTAINER:-labsrc}" >/dev/null 2>&1 || true; else lab_reset_source; fi
  lab_seed op --name "lab-$name-$(date +%s)" --source "${SRC_CONTAINER:-labsrc}" "$@" >"$LAB_DIR/op.main.env"
  lab_op_load main
}

lab_clean_leftovers() {
  local c d
  for c in $(docker ps -aq --filter 'label=tugra.vx=1' 2>/dev/null); do docker rm -f "$c" >/dev/null 2>&1 || true; done
  for c in $(docker ps -aq --filter 'name=tugra-migrator-' 2>/dev/null); do docker rm -f "$c" >/dev/null 2>&1 || true; done
  # staging directories of the lab's own transfers and moves only (named by the ids in the lab hub's database)
  for d in $(lab_owned dirs); do lab_agent_exec sh -c 'rm -rf "/etc/tugra/app-moves/$1" 2>/dev/null || true' _ "$d" >/dev/null 2>&1 || true; done
}

# lab_owned volumes|dirs: the docker volumes / app-moves staging dirs that belong to the lab (see scope.mjs). Empty when the
# hub database is gone: nothing is then provably the lab's, so nothing is removed.
lab_owned() {
  local mode="$1"
  {
    node "$LAB_SELF_DIR/seed.mjs" ids 2>/dev/null || true
    case "$mode" in
      volumes) docker volume ls -q 2>/dev/null | sed 's/^/volume /' ;;
      dirs) { ls -1 /etc/tugra/app-moves 2>/dev/null || docker exec "${LAB_AGENT:-lab-agent}" sh -c 'ls -1 /etc/tugra/app-moves 2>/dev/null || true' 2>/dev/null; } | sed 's/^/dir /' ;;
    esac
  } | node "$LAB_SELF_DIR/scope.mjs" "$mode"
}

# lab_docker_snapshot: every container EXCEPT the migrator's own, as "name id state". Only fields that cannot change by
# themselves: docker's Status column is relative text ("Up 47 seconds") that differs between two reads of an untouched host.
lab_docker_snapshot() {
  docker ps -a --no-trunc --format '{{.Names}} {{.ID}} {{.State}}' | grep -v -E '^tugra-migrator-' | sort
}

# ---- migrator runs in the background, interruption, progress ---------------------------------------------------------------

# lab_run_bg <tag> [migrate.sh args...]: start a migration in the background; its log is $LAB_DIR/run.<tag>.log.
lab_run_bg() {
  local tag="$1"; shift
  rm -f "$LAB_DIR/run.$tag.json" "$LAB_DIR/run.$tag.log" "$LAB_DIR/run.$tag.rc"
  (LAB_RUN_TAG="$tag" "$LAB_SELF_DIR/migrate.sh" "$@" >/dev/null 2>&1; echo $? >"$LAB_DIR/run.$tag.rc") &
  echo $! >"$LAB_DIR/run.$tag.pid"
}

# lab_run_wait <tag> [timeout-seconds]: wait for a background run; prints its exit code.
lab_run_wait() {
  local tag="$1" t="${2:-1800}" i=0
  while [ ! -f "$LAB_DIR/run.$tag.rc" ]; do
    sleep 1; i=$((i + 1))
    if [ "$i" -ge "$t" ]; then
      # what is still alive: the migrator container, the installer, its docker client and the log tee (the evidence a hang needs)
      { echo "--- run $tag: processes"; ps -eo pid,ppid,stat,etime,args 2>/dev/null | grep -E 'migrate\.sh|install/migrator|docker (run|kill|rm)|tee .*run\.' | grep -v grep || true
        echo "--- run $tag: containers"; docker ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null || true; } >&2
      lab_die "run $tag did not finish within ${t}s"
    fi
  done
  cat "$LAB_DIR/run.$tag.rc"
}

# lab_run <tag> [migrate.sh args...]: foreground run, never aborts the scenario; the exit code is left in LAB_RC.
lab_run() {
  local tag="$1"; shift
  LAB_RC=0
  LAB_RUN_TAG="$tag" "$LAB_SELF_DIR/migrate.sh" "$@" >/dev/null 2>&1 || LAB_RC=$?
}

# Highest part index the run's log has reported committed (-1 when none yet).
lab_last_part() {
  awk 'BEGIN{m=-1} /^ *part [0-9]+ /{ if ($2+0 > m) m=$2+0 } END{print m}' "$LAB_DIR/run.$1.log" 2>/dev/null || echo -1
}
lab_first_part() {
  awk 'BEGIN{m=-1} /^ *part [0-9]+ /{ if (m<0) m=$2+0 } END{print m}' "$LAB_DIR/run.$1.log" 2>/dev/null || echo -1
}
lab_wait_part() { # <tag> <n>: until the run committed part index >= n
  local tag="$1" n="$2" i=0
  while [ "$(lab_last_part "$tag")" -lt "$n" ]; do
    sleep 0.5; i=$((i + 1))
    [ "$i" -lt 3600 ] || lab_die "run $tag never reached part $n"
  done
}

lab_migrator_containers() { docker ps -q --filter 'name=tugra-migrator-'; }
# lab_kill9_migrator: SIGKILL every running migrator container (the unclean stop), then make sure the run that owns it can end. The installer's
# `docker run` client normally exits on its own the moment its container dies (137). A client that does not (lab run 3, L1b: the run never
# wrote its exit code within 120 s) is killed after a bound and the container is removed by name, so a stuck client can never be what a
# scenario waits on. That is NOT a harness detail: a client that outlives its SIGKILLed container is what an operator's installer would
# do on a real OOM kill, so the forced path is recorded (L1B_KILL_FORCED=<name> in l1b.summary, a FINDING line) and, under CI, fails
# the scenario unless LAB_ALLOW_FORCED_KILL=1 says the integrator has seen it. A job can never go green because the lab covered for it.
lab_kill9_migrator() {
  local names n i forced=""
  names="$(docker ps --filter 'name=tugra-migrator-' --format '{{.Names}}')"
  [ -n "$names" ] || lab_die "no migrator container is running"
  for n in $names; do docker kill --signal KILL "$n" >/dev/null; done
  for n in $names; do
    i=0
    while pgrep -f -- "--name $n" >/dev/null 2>&1; do
      i=$((i + 1))
      if [ "$i" -gt "${LAB_KILL_REAP_TICKS:-40}" ]; then
        lab_log "FINDING: the docker client of the SIGKILLed migrator $n did not exit within the bound (the docker run --rm client of install/migrator-install-script.ts): killing it by hand"
        echo "L1B_KILL_FORCED=$n" >>"$LAB_DIR/l1b.summary"
        forced="$forced $n"
        pkill -KILL -f -- "--name $n" >/dev/null 2>&1 || true
        break
      fi
      sleep 0.5
    done
    docker rm -f "$n" >/dev/null 2>&1 || true
  done
  if [ -n "$forced" ] && [ "${CI:-}" = true ] && [ "${LAB_ALLOW_FORCED_KILL:-}" != 1 ]; then
    lab_die "the installer's docker client did not exit after its migrator container was SIGKILLed (${forced# }): the product hangs on an OOM-style kill, the lab only covered for it (LAB_ALLOW_FORCED_KILL=1 accepts it knowingly)"
  fi
}

# lab_item <tag> <field>: a field of THIS op's volume item in the run's JSON result (state, reason, parts, disk, ...).
lab_item() { node "$LAB_SELF_DIR/jget.mjs" "items.@itemRef=${ITEMREF}.$2" "$LAB_DIR/run.$1.json" 2>/dev/null || true; }
lab_exit_of() { node "$LAB_SELF_DIR/jget.mjs" exit "$LAB_DIR/run.$1.json" 2>/dev/null || echo "?"; }

# lab_expect_item <tag> <state> [reason-substring]
lab_expect_item() {
  local tag="$1" want="$2" why="${3:-}" got reason
  got="$(lab_item "$tag" state)"; reason="$(lab_item "$tag" reason)"
  [ "$got" = "$want" ] || lab_die "run $tag: item state is '$got' (reason '$reason'), want '$want'"
  if [ -n "$why" ]; then case "$reason" in *"$why"*) ;; *) lab_die "run $tag: reason '$reason' does not mention '$why'" ;; esac; fi
  lab_log "ok: run $tag -> $got ${reason:+($reason)}"
}

# ---- the throttle proxy (L2, L3) -----------------------------------------------------------------------------------------
lab_proxy_start() { # <rate MB/s> [port]
  local rate="$1" port="${2:-4001}"
  lab_proxy_stop
  node "$LAB_SELF_DIR/throttle-proxy.mjs" --listen "$port" --target "127.0.0.1:${LAB_HUB_PORT}" --rate "$rate" 2>>"$LAB_DIR/proxy.log" &
  echo $! >"$LAB_DIR/proxy.pid"
  LAB_PROXY_URL="http://${LAB_HOST}:${port}"
  lab_wait 10 "throttle proxy on :$port" curl -s -o /dev/null "http://127.0.0.1:${port}/health"
}
lab_proxy_stop() {
  [ -f "$LAB_DIR/proxy.pid" ] || return 0
  kill "$(cat "$LAB_DIR/proxy.pid")" 2>/dev/null || true
  rm -f "$LAB_DIR/proxy.pid"
}

# ---- the HTTP tap (L8): a pass-through to the hub that counts the relay's `busy` answers to part registrations -------------------
# LAB_TAP_BARRIER=<n> makes the tap hold every migrator's `GET targets` until n migrators asked (see http-tap.mjs); the outcome line
# ("released all n" / "released timeout k/n") lands in $LAB_DIR/tap.barrier.
lab_tap_start() { # [port]
  local port="${1:-4002}" extra=()
  lab_tap_stop
  : >"$LAB_DIR/tap.busy"
  : >"$LAB_DIR/tap.barrier"
  [ -z "${LAB_TAP_BARRIER:-}" ] || extra=(--barrier "$LAB_TAP_BARRIER" --barrier-file "$LAB_DIR/tap.barrier")
  node "$LAB_SELF_DIR/http-tap.mjs" --listen "$port" --target "127.0.0.1:${LAB_HUB_PORT}" --busy-file "$LAB_DIR/tap.busy" ${extra[@]+"${extra[@]}"} 2>>"$LAB_DIR/tap.log" &
  echo $! >"$LAB_DIR/tap.pid"
  LAB_TAP_URL="http://${LAB_HOST}:${port}"
  lab_wait 10 "http tap on :$port" curl -s -o /dev/null "http://127.0.0.1:${port}/health"
}
lab_tap_stop() {
  [ -f "$LAB_DIR/tap.pid" ] || return 0
  kill "$(cat "$LAB_DIR/tap.pid")" 2>/dev/null || true
  rm -f "$LAB_DIR/tap.pid"
}
lab_tap_busy() { wc -l <"$LAB_DIR/tap.busy" 2>/dev/null | tr -d ' ' || echo 0; }

# ---- volume-level checks -----------------------------------------------------------------------------------------------------
lab_no_leftovers() { # no tar helper, no migrator, no rollback snapshot volume, no staged parts
  [ -z "$(docker ps -aq --filter 'label=tugra.vx=1')" ] || lab_die "a tugra-vx-* helper container is left behind"
  [ -z "$(lab_migrator_containers)" ] || lab_die "a migrator container is still running"
  [ -z "$(docker volume ls -q --filter 'name=tugra_restore_rb_')" ] || lab_die "a rollback snapshot volume is left behind"
  [ "$(lab_agent_exec sh -c 'find /etc/tugra/app-moves -name "p.*" 2>/dev/null | wc -l' | tr -d ' ')" = 0 ] || lab_die "staged parts are left on the target"
}
lab_source_untouched() { # the source container was never started by the lab run (stopped, StartedAt zero)
  [ "$(docker inspect -f '{{.State.Running}}' "${SRC_CONTAINER:-labsrc}")" = false ] || lab_die "the source container is running"
}
lab_compare() { "$LAB_SELF_DIR/compare.sh" "${SRC_VOLUME:-lab-src}" "$DEST_VOLUME"; }
