#!/usr/bin/env bash
#
# Tugra self-update sidecar. Runs inside the `tugra-updater` container (docker.sock + the repo mounted).
# It drains a Redis job queue that the hub LPUSHes to when the owner clicks "Update now" (or auto-update
# fires), then pulls the target images and recreates ONLY hub-api + web — never itself, postgres, or redis.
# The hub cannot do this: recreating hub-api kills the process running the command. This container survives.
#
#   scripts/update.sh --watch                 # the sidecar loop (BLPOP the queue forever)
#   scripts/update.sh --dry-run --target X    # print what an update to X would run, touching nothing
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_DIR/deploy/docker-compose.yml"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"
REDIS_URL="${REDIS_URL:-redis://redis:6379}"

LOCK_KEY="instance:update:lock"
STATUS_KEY="instance:update:status"
QUEUE_KEY="instance:update:queue"
STATUS_TTL=3600

DRY=0
TARGET=""
WATCH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    *) printf 'update.sh: unknown option %s\n' "$1" >&2; exit 1 ;;
  esac
done

log() { printf '\033[36m[updater]\033[0m %s\n' "$*"; }
# In --dry-run, side-effecting commands are printed instead of run, so the logic is testable without Docker/Redis.
run() { if [ "$DRY" -eq 1 ]; then printf 'RUN: %s\n' "$*"; else "$@"; fi; }
compose() { run docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
redis() { run redis-cli -u "$REDIS_URL" "$@"; }

# `|| true`: a missing key makes grep exit 1, which under `set -o pipefail` would abort the caller's
# assignment before the "latest" fallback can run. A fresh install has no TUGRA_VERSION line yet.
env_get() { grep "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true; }
set_env() {
  if [ "$DRY" -eq 1 ]; then printf 'SET_ENV: %s=%s\n' "$1" "$2"; return 0; fi
  # Atomic: build the new file in a SAME-DIR temp (so `mv` is a same-filesystem atomic rename) and swap it
  # in. A crash between write and rename can never leave a truncated .env — the old file stays until the mv.
  # Every step is CHECKED and a failure returns 1: do_update/recover_previous key off it. (`set -e` is
  # disabled inside `do_update ... || log`, so an unchecked write failure here would be silently swallowed
  # and the update wrongly reported as "done".)
  local tmp; tmp="$(mktemp "${ENV_FILE}.XXXXXX")" || return 1
  if [ -f "$ENV_FILE" ]; then
    { grep -v "^$1=" "$ENV_FILE" 2>/dev/null || true; } > "$tmp" || { rm -f "$tmp"; return 1; }
    # Preserve the original owner + mode so a self-update never locks the installing user out of .env.
    chmod "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 600)" "$tmp" 2>/dev/null || true
    chown "$(stat -c '%u:%g' "$ENV_FILE" 2>/dev/null || echo 0:0)" "$tmp" 2>/dev/null || true
  fi
  printf '%s=%s\n' "$1" "$2" >> "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$ENV_FILE" || { rm -f "$tmp"; return 1; }
}
set_status() { redis SET "$STATUS_KEY" "{\"phase\":\"$1\",\"targetVersion\":\"$2\",\"error\":${3:-null}}" EX "$STATUS_TTL"; }
release_lock() { redis DEL "$LOCK_KEY"; }

# Restore the PREVIOUSLY-running version and VERIFY both hub-api and web are healthy. Used by EVERY post-pull
# failure branch so a partial `compose up` (not atomic across two services) never leaves a broken old+new mix.
# Returns 0 ONLY when the .env write, the recreate, AND the health check of both services all succeed — a
# failed set_env must escalate to recovery, not a false "restored".
# NOTE: on the mutable `latest` tag the rollback uses whatever :latest was last pulled (concrete beta/release
# versions roll back exactly). Either way we only claim "restored" once health passes; exact digest-pinning
# of the rollback is a follow-up.
recover_previous() {
  local prev="$1"
  log "restoring previous version $prev"
  set_env TUGRA_VERSION "$prev" && compose up -d --no-deps hub-api web && wait_healthy hub-api web
}

# Terminal state when the previous version could NOT be restored+verified: the stack may be partly updated.
# Record an explicit phase AND a NO-TTL marker so the recovery state doesn't silently expire back to idle.
set_recovery_required() {
  local target="$1" prev="$2"
  log "RECOVERY REQUIRED — restore manually: set TUGRA_VERSION=$prev in $ENV_FILE then run: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE up -d --no-deps hub-api web"
  # Write the status WITHOUT a TTL (unlike set_status, which EXpires after STATUS_TTL) so the recovery state
  # can't silently lapse back to idle, plus a durable marker the hub gates new updates on until it is cleared.
  redis SET "$STATUS_KEY" "{\"phase\":\"recovery_required\",\"targetVersion\":\"$target\",\"error\":\"update to $target failed and the previous version could not be restored and verified — manual recovery required (set TUGRA_VERSION=$prev and recreate hub-api + web)\"}"
  redis SET "instance:update:recovery_required" "{\"targetVersion\":\"$target\",\"previousVersion\":\"$prev\"}"
}

# Strictly-newer guard (defense-in-depth; the hub already gated never-downgrade). Semver-aware:
# `sort -V` ranks 0.1.0 BELOW 0.1.0-beta.1 (the opposite of semver), which would strand beta instances.
# Rules: strip a leading "v" and any +build; compare the numeric major.minor.patch core first; on an equal
# core a release outranks any prerelease of it; two prereleases of the same core fall back to version sort
# on the prerelease part (beta.2 < beta.10). Usage: is_newer <candidate> <baseline> -> 0 if candidate > baseline.
is_newer() {
  local a="${1#v}" b="${2#v}"
  a="${a%%+*}"; b="${b%%+*}"
  [ "$a" != "$b" ] || return 1
  local acore="${a%%-*}" bcore="${b%%-*}" apre="" bpre=""
  case "$a" in *-*) apre="${a#*-}" ;; esac
  case "$b" in *-*) bpre="${b#*-}" ;; esac
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<EOF_A
$acore
EOF_A
  IFS=. read -r b1 b2 b3 <<EOF_B
$bcore
EOF_B
  # Missing/non-numeric components count as 0.
  a1="${a1:-0}"; a2="${a2:-0}"; a3="${a3:-0}"; b1="${b1:-0}"; b2="${b2:-0}"; b3="${b3:-0}"
  local x y
  for pair in "$a1 $b1" "$a2 $b2" "$a3 $b3"; do
    x="${pair% *}"; y="${pair#* }"
    case "$x$y" in *[!0-9]*) x=0; y=0 ;; esac
    if [ "$x" -gt "$y" ]; then return 0; fi
    if [ "$x" -lt "$y" ]; then return 1; fi
  done
  # Equal core: release > prerelease; no prerelease on either side means identical (already excluded).
  if [ -z "$apre" ] && [ -n "$bpre" ]; then return 0; fi
  if [ -n "$apre" ] && [ -z "$bpre" ]; then return 1; fi
  [ "$(printf '%s\n%s\n' "$bpre" "$apre" | sort -V | tail -1)" = "$apre" ]
}

# Poll the given services (default hub-api) until ALL are healthy, or give up. Returns 0 healthy, 1
# unhealthy/exited/timeout. Uses the compose healthcheck status; a service without one counts as healthy once
# it is "running". In --dry-run nothing is polled (no Docker), so the happy path is assumed.
HEALTH_TIMEOUT="${UPDATE_HEALTH_TIMEOUT:-120}"
wait_healthy() {
  local services="${*:-hub-api}"
  if [ "$DRY" -eq 1 ]; then
    # Test hook (dry-run only): DRY_HEALTH=fail → always unhealthy; fail-once → unhealthy the first call then
    # healthy (so the recovery path can be exercised without Docker). Default: healthy.
    case "${DRY_HEALTH:-ok}" in
      fail) printf 'RUN: wait_healthy -> UNHEALTHY (dry)\n'; return 1 ;;
      fail-once)
        if [ -z "${DRY_HEALTH_FAILED:-}" ]; then DRY_HEALTH_FAILED=1; printf 'RUN: wait_healthy -> UNHEALTHY (dry, first call)\n'; return 1; fi
        printf 'RUN: wait_healthy -> healthy (dry, recovered)\n'; return 0 ;;
      *) printf 'RUN: wait up to %ss for %s healthy\n' "$HEALTH_TIMEOUT" "$services"; return 0 ;;
    esac
  fi
  local waited=0 svc cid state all_ok
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    all_ok=1
    for svc in $services; do
      cid="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q "$svc" 2>/dev/null | head -n1 || true)"
      if [ -z "$cid" ]; then all_ok=0; break; fi
      state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      case "$state" in
        healthy|running) ;;        # this service is up — check the next one
        exited|dead) return 1 ;;   # crashed outright (e.g. failed migration with no restart) — no point waiting
        *) all_ok=0; break ;;      # starting / unhealthy — keep polling
      esac
    done
    [ "$all_ok" -eq 1 ] && return 0
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

do_update() {
  local target="$1"
  local current; current="$(env_get TUGRA_VERSION)"; [ -n "$current" ] || current="latest"
  if [ "$current" != "latest" ] && ! is_newer "$target" "$current"; then
    log "refusing non-newer target $target (current $current)"
    set_status failed "$target" "\"target not newer than current\""
    release_lock
    return 0
  fi

  log "updating $current -> $target"
  set_status pulling "$target"
  if ! set_env TUGRA_VERSION "$target"; then
    log "could not write $ENV_FILE — aborting"
    set_status failed "$target" "\"could not update .env\""
    release_lock
    return 0
  fi

  # Pull + recreate ONLY the app containers (--no-deps: never touch postgres/redis or this updater).
  if ! compose pull hub-api web; then
    log "pull failed — rolling back .env"
    set_env TUGRA_VERSION "$current"
    set_status failed "$target" "\"image pull failed\""
    release_lock
    return 0
  fi
  set_status recreating "$target"
  if ! compose up -d --no-deps hub-api web; then
    log "recreate failed — restoring $current"
    # `compose up` is NOT atomic across hub-api + web: a partial recreate may already have swapped one of
    # them to the new image. Actively bring the previous version back and VERIFY it, rather than only
    # rewriting the .env tag (which left a broken old/new mix running).
    if recover_previous "$current"; then
      set_status failed "$target" "\"recreate failed; restored $current\""
    else
      set_recovery_required "$target" "$current"
    fi
    release_lock
    return 0
  fi

  # `up` returning 0 only means the containers were created — a failing migration or a crash-looping hub
  # still passes it. Only report success once hub-api AND web are actually healthy; otherwise restore the
  # previous version (and escalate to recovery_required if that restore can't be verified).
  if ! wait_healthy hub-api web; then
    log "hub-api did not become healthy within ${HEALTH_TIMEOUT}s — restoring $current"
    # Restore AND verify the previous version. The old code re-ran `up` without re-checking health and still
    # reported "rolled back" even when that recreate failed — a false reassurance to the operator.
    if recover_previous "$current"; then
      set_status failed "$target" "\"update to $target failed health check; restored $current and verified healthy\""
    else
      set_recovery_required "$target" "$current"
    fi
    release_lock
    return 0
  fi

  set_status done "$target"
  redis DEL "instance:update:recovery_required" # a verified update clears any stale recovery marker
  release_lock
  log "update to $target complete"
}

if [ "$DRY" -eq 1 ]; then
  [ -n "$TARGET" ] || { printf 'error: --dry-run requires --target <version>\n' >&2; exit 1; }
  do_update "$TARGET"
  exit 0
fi

if [ "$WATCH" -ne 1 ]; then
  printf 'usage: update.sh --watch  (or --dry-run --target <version>)\n' >&2
  exit 1
fi

log "watching $QUEUE_KEY on $REDIS_URL"
while true; do
  # BLPOP returns two lines: the key name, then the popped value.
  job="$(redis-cli -u "$REDIS_URL" BLPOP "$QUEUE_KEY" 0 | sed -n '2p')"
  [ -n "$job" ] || continue
  target="$(printf '%s' "$job" | grep -o '"targetVersion":"[^"]*"' | head -n1 | cut -d'"' -f4)"
  if [ -z "$target" ]; then
    log "ignoring malformed job: $job"
    release_lock
    continue
  fi
  do_update "$target" || log "update run errored (continuing to watch)"
done
