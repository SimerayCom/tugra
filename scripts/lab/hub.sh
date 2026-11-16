#!/usr/bin/env bash
# The lab hub as its own restartable process (L2 kills and restarts it mid-part and mid-apply).
#   hub.sh start|stop|kill|restart|status [KEY=VALUE ...]
# KEY=VALUE pairs are persisted in $LAB_DIR/hub.extra.env and apply to every later start (e.g. MIGRATION_RELAY_CONCURRENCY=1);
# `hub.sh reset-extra` clears them. The base environment is $LAB_DIR/hub.env (written by up.sh).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PIDFILE="$LAB_DIR/hub.pid"
LOGFILE="$LAB_DIR/hub.log"
EXTRA="$LAB_DIR/hub.extra.env"

cmd="${1:-status}"; shift || true

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

save_extra() {
  local kv k
  [ "$#" -gt 0 ] || return 0
  touch "$EXTRA"
  for kv in "$@"; do
    case "$kv" in [A-Z_][A-Z0-9_]*=*) ;; *) lab_die "hub.sh: expected KEY=VALUE, got $kv" ;; esac
    k="${kv%%=*}"
    grep -v "^${k}=" "$EXTRA" >"$EXTRA.tmp" || true
    printf '%s\n' "$kv" >>"$EXTRA.tmp"
    mv "$EXTRA.tmp" "$EXTRA"
  done
}

start() {
  running && { lab_log "hub already running (pid $(cat "$PIDFILE"))"; return 0; }
  [ -f "$LAB_DIR/hub.env" ] || lab_die "no $LAB_DIR/hub.env: run up.sh first"
  [ -f "$LAB_ROOT/apps/hub-api/dist/main.js" ] || lab_die "hub is not built: pnpm --filter @tugra/hub-api build"
  (
    set -a
    # shellcheck disable=SC1091
    . "$LAB_DIR/hub.env"
    [ -f "$EXTRA" ] && . "$EXTRA"
    set +a
    cd "$LAB_ROOT/apps/hub-api"
    echo "--- hub start $(date -u +%FT%TZ)" >>"$LOGFILE"
    nohup node dist/main.js >>"$LOGFILE" 2>&1 &
    echo $! >"$PIDFILE"
  )
  lab_wait 90 "hub /health on :${LAB_HUB_PORT}" curl -fsS "http://127.0.0.1:${LAB_HUB_PORT}/health"
  lab_log "hub up (pid $(cat "$PIDFILE"))"
}

stop() {
  running || { rm -f "$PIDFILE"; return 0; }
  local pid; pid="$(cat "$PIDFILE")"
  kill "$pid" 2>/dev/null || true
  local i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PIDFILE"
  lab_log "hub stopped"
}

case "$cmd" in
  start) save_extra "$@"; start ;;
  stop) stop ;;
  kill) # a crash: no graceful shutdown, no in-flight drain
    if running; then kill -9 "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; lab_log "hub killed (SIGKILL)"; fi ;;
  restart) stop; save_extra "$@"; start ;;
  reset-extra) rm -f "$EXTRA" ;;
  status) if running; then echo "running pid $(cat "$PIDFILE")"; else echo "stopped"; exit 3; fi ;;
  *) lab_die "usage: hub.sh start|stop|kill|restart|status|reset-extra [KEY=VALUE ...]" ;;
esac
