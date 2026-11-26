#!/usr/bin/env bash
#
# Tugra self-update sidecar. Runs inside the `tugra-updater` container (docker.sock + the repo mounted).
# It drains a Redis job queue that the hub LPUSHes to when the owner clicks "Update now" (or auto-update
# fires). Nothing is written or pulled before a DISK PREFLIGHT passes (free space of the Docker data root and the install
# dir; a safe image cleanup runs first when short; lib/images.sh disk_preflight). Then it takes a mandatory restore point
# (pg_dump + .env copy, see lib/snapshot.sh), PULLS the target images and verifies their version labels, and only then
# writes .env (atomically) and recreates hub-api + web (--no-deps) — never postgres, redis or itself. A failure before the
# .env write has nothing to roll back; a half-finished update an older updater left (.env ahead of what runs) is resumed, or
# .env is put back to the running release when the target cannot be pulled (detect_half_state). Once those are healthy it also refreshes the local `agent` (non-fatal; pulled by its signed
# per-arch image digest, never `compose pull`, see lib/images.sh) and pre-pulls the updater image, then removes
# Tugra's own release images older than the previous release (lib/images.sh; TUGRA_PRUNE_IMAGES=0 turns that off).
# The updater cannot recreate itself mid-run, so when its running image is not the one the
# release's compose now resolves (the common case: TUGRA_VERSION moved) it starts a detached one-shot helper
# AFTER the update is final that recreates only the `tugra-updater` service.
# The hub cannot do this: recreating hub-api kills the process running the command. This container survives.
#
#   scripts/update.sh --watch                 # the sidecar loop (BLPOP the queue forever)
#   scripts/update.sh --dry-run --target X    # print what an update to X would run, touching nothing
#   scripts/update.sh --dry-run --job '{"targetVersion":"X","hubDigest":"<64hex>","webDigest":"<64hex>"}'
#   scripts/update.sh --apply-host-files <version> <hostFilesDigest>
#                                             # one-shot: verify + apply the release's signed compose/scripts to the
#                                             # checkout of a stack ALREADY running <version> (the hub's bootstrap for an
#                                             # install whose updater predates host-files); no pull, no recreate
#   scripts/update.sh --prune-images <version>
#                                             # one-shot: remove Tugra's own release images older than the rollback
#                                             # anchor of a stack running <version> (the hub's bootstrap runs it after
#                                             # the recreate; the anchor is the newest older release still on disk)
#
# Queue job (flat JSON strings; no jq in this image): {"targetVersion":"X"} (legacy, tag-only) or
# {"targetVersion":"X","hubDigest":"<64hex>","webDigest":"<64hex>"}. With BOTH digests the images are pulled by
# digest (`repo:tag@sha256:…` via compose TUGRA_HUB_DIGEST / TUGRA_WEB_DIGEST); anything else is the legacy path.
# An optional "hostFilesDigest":"<64hex>" (sha256 of the release's signed host files manifest, read by the hub from
# the signature-verified versions.json) makes the update also apply the release's compose file + installer scripts:
# this sidecar re-verifies and applies them itself (scripts/lib/hostfiles.sh) — before the pull, with a backup and an
# automatic rollback; the .env is never edited by that step. Without it the update is images-only, as before.
# Optional "agentAmd64Digest" / "agentArm64Digest" (64-hex, the signed per-platform agent image manifests) let the
# local agent be pulled by digest; without them it is pulled by tag with a plain `docker pull`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# TUGRA_REPO_DIR points the script at a checkout other than its own location: the one-shot host-files bootstrap runs
# the updater image's baked copy of this script against the operator's checkout mounted at its HOST path.
REPO_DIR="${TUGRA_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_FILE="$REPO_DIR/deploy/docker-compose.yml"
UPDATER_REFRESH_KEY="instance:update:updater-refreshed"
UPDATER_REFRESH_WAIT="${UPDATER_REFRESH_WAIT:-30}"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env}"
REDIS_URL="${REDIS_URL:-redis://redis:6379}"

LOCK_KEY="instance:update:lock"
STATUS_KEY="instance:update:status"
QUEUE_KEY="instance:update:queue"
STATUS_TTL=3600

DRY=0
TARGET=""
JOB=""
WATCH=0
APPLY_HF=0
APPLY_HF_VERSION=""
APPLY_HF_DIGEST=""
PRUNE_ONLY=0
PRUNE_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --watch) WATCH=1; shift ;;
    --apply-host-files)
      [ $# -ge 3 ] || { printf 'update.sh: --apply-host-files needs <version> <hostFilesDigest>\n' >&2; exit 1; }
      APPLY_HF=1; APPLY_HF_VERSION="$2"; APPLY_HF_DIGEST="$3"; shift 3 ;;
    --prune-images)
      [ $# -ge 2 ] || { printf 'update.sh: --prune-images needs <version>\n' >&2; exit 1; }
      PRUNE_ONLY=1; PRUNE_VERSION="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    --job) JOB="${2:-}"; shift 2 ;;
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
# Atomically set KEY=VALUE in <file> (default: the .env). Every step is CHECKED and a failure returns 1 with the original
# file untouched: do_update / recover_previous key off it. (`set -e` is disabled inside `do_update ... || log`, so an
# unchecked write failure would be silently swallowed and the update wrongly reported as "done".)
#   1. the new content is built in a SAME-DIR temp, so the final `mv` is a same-filesystem atomic rename: a crash or a
#      full disk between write and rename can never leave a truncated .env, the old file stays until the mv;
#   2. it is VERIFIED before it replaces anything (line count = the kept lines of the original + the new one; last line
#      is the new assignment): a write that ran out of space part-way (grep's own exit code is not trusted) is caught here;
#   3. it is fsync'ed (`sync FILE`, see _fsync_file) so a deferred ENOSPC surfaces now;
#   4. only then mode/owner are copied over from the original (so a self-update never locks the installing user out of
#      .env) and the temp is renamed in.
# fsync one file. coreutils and busybox `sync FILE` flush just that file and FAIL when the write-back failed; macOS/BSD
# `sync` ignores the argument and flushes the whole machine (slow, and no signal), so there it is skipped.
_fsync_file() {
  case "$(uname -s 2>/dev/null)" in Darwin|*BSD) return 0 ;; esac
  command -v sync >/dev/null 2>&1 || return 0 # a minimal userland without sync: the verified temp + rename still holds
  sync "$1" >/dev/null 2>&1
}
env_put() {
  local file="$1" key="$2" val="$3" tmp kept have
  if [ "$DRY" -eq 1 ]; then printf 'SET_ENV: %s=%s\n' "$key" "$val"; return 0; fi
  tmp="$(mktemp "${file}.XXXXXX")" || { log "cannot create a temporary file next to $file (disk full?) — $file was not changed"; return 1; }
  kept=0
  if [ -f "$file" ]; then
    kept="$(grep -vc "^${key}=" "$file" 2>/dev/null || true)"
    case "$kept" in ''|*[!0-9]*) kept=0 ;; esac
    { grep -v "^${key}=" "$file" 2>/dev/null || true; } > "$tmp" || { rm -f "$tmp"; log "cannot write $tmp (disk full?) — $file was not changed"; return 1; }
  fi
  printf '%s=%s\n' "$key" "$val" >> "$tmp" || { rm -f "$tmp"; log "cannot write $tmp (disk full?) — $file was not changed"; return 1; }
  have="$(wc -l < "$tmp" 2>/dev/null | tr -d '[:space:]')"
  if [ "$have" != "$((kept + 1))" ] || [ "$(tail -n1 "$tmp" 2>/dev/null)" != "${key}=${val}" ]; then
    rm -f "$tmp"; log "the new $file did not verify after writing it (disk full?) — $file was not changed"; return 1
  fi
  _fsync_file "$tmp" || { rm -f "$tmp"; log "could not flush the new $file to disk (disk full?) — $file was not changed"; return 1; }
  if [ -f "$file" ]; then
    chmod "$(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file" 2>/dev/null || echo 600)" "$tmp" 2>/dev/null || chmod 600 "$tmp" 2>/dev/null || true
    chown "$(stat -c '%u:%g' "$file" 2>/dev/null || echo 0:0)" "$tmp" 2>/dev/null || true
  else
    chmod 600 "$tmp" 2>/dev/null || true
  fi
  mv "$tmp" "$file" || { rm -f "$tmp"; log "could not replace $file — it was not changed"; return 1; }
}
set_env() { env_put "$ENV_FILE" "$1" "$2"; }
# set_status <phase> <target> [<error as a JSON string literal>] [<extra JSON members, each starting with a comma>]
set_status() { redis SET "$STATUS_KEY" "{\"phase\":\"$1\",\"targetVersion\":\"$2\",\"error\":${3:-null}${4:-}}" EX "$STATUS_TTL"; }
release_lock() { redis DEL "$LOCK_KEY"; }

# Dry-run switch for the snapshot library: a dedicated variable owned by THIS script (plain assignment, from our
# own flag), so an inherited generic DRY in some other environment can never change snapshot behaviour.
TUGRA_SNAPSHOT_DRY="$DRY"
# shellcheck source=lib/snapshot.sh
. "$SCRIPT_DIR/lib/snapshot.sh"
# shellcheck source=lib/hostfiles.sh
. "$SCRIPT_DIR/lib/hostfiles.sh"
# shellcheck source=lib/images.sh
. "$SCRIPT_DIR/lib/images.sh"
# shellcheck source=lib/paneldomain.sh
# (guarded: a checkout mid-way through a host-files apply may briefly carry the new update.sh without the new lib)
if [ -f "$SCRIPT_DIR/lib/paneldomain.sh" ]; then . "$SCRIPT_DIR/lib/paneldomain.sh"; fi

# The sidecar only has the checkout (/repo) mounted. A TUGRA_BACKUP_DIR outside it would be written into the
# container's ephemeral filesystem and vanish while the log claims success — so refuse it up front.
# Returns 0 when unset or an absolute path inside $REPO_DIR (symlinks resolved on the existing part).
backup_dir_ok() {
  local bk root p rest
  bk="$(_snap_cfg TUGRA_BACKUP_DIR "")"
  [ -n "$bk" ] || return 0
  case "$bk" in /*) ;; *) return 1 ;; esac
  case "/$bk/" in */../*) return 1 ;; esac
  root="$(cd "$REPO_DIR" && pwd -P)" || return 1
  p="$bk"; rest=""
  while [ ! -d "$p" ] && [ "$p" != "/" ]; do rest="/$(basename "$p")$rest"; p="$(dirname "$p")"; done
  p="$(cd "$p" && pwd -P)${rest}" || return 1
  case "$p/" in "$root"/*) return 0 ;; *) return 1 ;; esac
}
# " (DB restore point: <path>)" when a snapshot exists — appended to operator-facing failure text.
snap_note() {
  if [ -n "$SNAPSHOT_PATH" ]; then printf '; pre-update backup: %s' "$SNAPSHOT_PATH"; fi
  if [ -n "$HF_BACKUP_DIR" ]; then printf '; replaced compose/scripts saved in: %s' "$HF_BACKUP_DIR"; fi
}
# Put the release's compose/scripts back after a failure that happened BEFORE any container was recreated (the
# branches that only roll .env back). `hf_note` is the status-text suffix when that restore itself failed.
hf_undo() { hf_rollback || log "host files: ROLLBACK FAILED — copy the files saved in $HF_BACKUP_DIR back into $REPO_DIR by hand"; }
hf_note() { if [ "$HF_APPLIED" -eq 1 ] && [ -n "$HF_BACKUP_DIR" ]; then printf '; compose/scripts could NOT be restored: copy the files saved in %s back by hand' "$HF_BACKUP_DIR"; fi; }
# A value safe to embed in the JSON status string (no quotes, backslashes or control characters).
# Every control character (ESC from a colourised `compose pull`, backspace, DEL ...) goes: one of them makes the status invalid
# JSON, which the hub reads as "idle" and the panel then never shows the failure. \n \t \r become spaces first.
json_str() { printf '%s' "$1" | tr '\n\t\r' '   ' | tr -d '"\\' | tr -d '\000-\037\177'; }

# A bare lowercase 64-hex sha256 (the only digest form the manifest, the queue job and .env carry).
is_hex64() { [[ "${1:-}" =~ ^[0-9a-f]{64}$ ]]; }

# Image repos used to look a pulled digest up locally (override for a mirror).
HUB_IMAGE_REPO="${HUB_IMAGE_REPO:-ghcr.io/simeraycom/tugra-hub}"
WEB_IMAGE_REPO="${WEB_IMAGE_REPO:-ghcr.io/simeraycom/tugra-web}"
AGENT_IMAGE_REPO="${AGENT_IMAGE_REPO:-ghcr.io/simeraycom/tugra-agent}"
UPDATER_IMAGE_REPO="${UPDATER_IMAGE_REPO:-ghcr.io/simeraycom/tugra-updater}"
VERSION_LABEL="org.opencontainers.image.version"

# Write the version (+ the hub/web digest pins when `touched` is 1) into <file>. Digest values are bare hex, or
# EMPTY to unpin (compose then falls back to the plain tag). Returns 1 on the first failed write.
write_pins_to() {
  local file="$1" version="$2" hub="$3" web="$4" touched="$5"
  env_put "$file" TUGRA_VERSION "$version" || return 1
  if [ "$touched" = 1 ]; then
    env_put "$file" TUGRA_HUB_DIGEST "$hub" || return 1
    env_put "$file" TUGRA_WEB_DIGEST "$web" || return 1
  fi
}
write_pins() { write_pins_to "$ENV_FILE" "$@"; }

# Put .env back to the previous version AND previous digest pins (no recreate). Digest keys are only touched
# when either side had a pin — `touched` — so a tag-only -> tag-only update never writes them (legacy bytes).
# Usage: restore_env <prev> <prevHub> <prevWeb> <newHub> <newWeb>
restore_env() {
  local prev="$1" prevHub="$2" prevWeb="$3" newHub="${4:-}" newWeb="${5:-}" touched=0
  if [ -n "$prevHub$prevWeb$newHub$newWeb" ] || [ "$PINS_TOUCH_FORCE" = 1 ]; then touched=1; fi
  write_pins "$prev" "$prevHub" "$prevWeb" "$touched"
}

# Restore the PREVIOUSLY-running version (and its digest pins) and VERIFY both hub-api and web are healthy.
# Used by EVERY post-pull failure branch so a partial `compose up` (not atomic across two services) never
# leaves a broken old+new mix. Returns 0 ONLY when the .env write, the recreate, AND the health check of both
# services all succeed — a failed set_env must escalate to recovery, not a false "restored".
# Digest-aware: a previously pinned stack comes back on its exact previous digests; a previously tag-only stack
# gets any NEW pin cleared (otherwise the new digest would keep overriding the restored tag). On the mutable
# `latest` tag the rollback uses whatever :latest was last pulled (concrete versions roll back exactly).
# Usage: recover_previous <prev> <prevHub> <prevWeb> <newHub> <newWeb>
recover_previous() {
  local prev="$1"
  log "restoring previous version $prev"
  restore_env "$@" && compose up -d --no-deps hub-api web && wait_healthy hub-api web
}

# recover_previous + the release's compose/scripts put back FIRST (the previous version must come up from the
# previous compose file). A no-op for the host files when this update applied none. Returns 0 only when BOTH the
# files and the running stack are verified restored.
recover_all() {
  local ok=0
  hf_rollback || ok=1
  recover_previous "$@" || ok=1
  return "$ok"
}

# Terminal state when the previous version could NOT be restored+verified: the stack may be partly updated.
# Record an explicit phase AND a NO-TTL marker so the recovery state doesn't silently expire back to idle.
set_recovery_required() {
  local target="$1" prev="$2" prevHub="${3:-}" prevWeb="${4:-}" newHub="${5:-}" newWeb="${6:-}" pins=""
  # Digest pins must be restored too: to the previous digests when the stack was pinned, or CLEARED (empty) when it
  # was tag-only but the failed update wrote new pins (a restore_env that died half-way may have left them).
  if [ -n "$prevHub$prevWeb$newHub$newWeb" ] || [ "$PINS_TOUCH_FORCE" = 1 ]; then pins=" and TUGRA_HUB_DIGEST=${prevHub} TUGRA_WEB_DIGEST=${prevWeb}"; fi
  local files=""
  if [ "$HF_APPLIED" -eq 1 ] && [ -n "$HF_BACKUP_DIR" ]; then files=" AND restore the compose/scripts saved in $HF_BACKUP_DIR (copy each file back to the same path in $REPO_DIR)"; fi
  log "RECOVERY REQUIRED — restore manually: set TUGRA_VERSION=$prev${pins} in $ENV_FILE${files} then run: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE up -d --no-deps hub-api web"
  # Write the status WITHOUT a TTL (unlike set_status, which EXpires after STATUS_TTL) so the recovery state
  # can't silently lapse back to idle, plus a durable marker the hub gates new updates on until it is cleared.
  redis SET "$STATUS_KEY" "{\"phase\":\"recovery_required\",\"targetVersion\":\"$target\",\"error\":\"update to $target failed and the previous version could not be restored and verified — manual recovery required (set TUGRA_VERSION=$prev${pins}${files} and recreate hub-api + web)$(snap_note)\"}"
  redis SET "instance:update:recovery_required" "{\"targetVersion\":\"$target\",\"previousVersion\":\"$prev\"}"
}

# 1 when .env already carried digest pins that belong to a release that never ran (a half-finished update, see
# detect_half_state): every rollback/write then touches the pin keys too, so a stale pin can not override the tag.
PINS_TOUCH_FORCE=0
# Half-finished update state (detect_half_state): HALF_STATE=1 when .env names a release NEWER than the one the running
# hub-api/web containers are on; HALF_RUNNING = the running release, HALF_ENV = what .env says.
HALF_STATE=0
HALF_RUNNING=""
HALF_ENV=""
HALF_KNOWN=0   # 1 when the running release could be read (so "no half state" is a real answer, not a blind spot)
HALF_KEY="instance:update:half_state"

# Compare what .env names with what actually runs. An update used to write .env BEFORE it pulled; when the pull (or the
# rollback write) then failed — a full disk, a crash, a killed updater — .env named a release that was never installed
# and the next "Update now" refused with "target not newer than current". detect_half_state <env version>.
# Dry-run hook: DRY_RUNNING=<version> plays the running release (default: unknown = no half state).
detect_half_state() {
  local envv="${1:-}" running=""
  HALF_STATE=0; HALF_RUNNING=""; HALF_ENV=""; HALF_KNOWN=0
  [ -n "$envv" ] && [ "$envv" != "latest" ] || { HALF_KNOWN=1; return 0; }
  if [ "$DRY" -eq 1 ]; then running="${DRY_RUNNING:-}"; else running="$(running_stack_version)" || running=""; fi
  _img_is_version "$running" || return 0
  HALF_KNOWN=1
  if is_newer "$envv" "$running"; then HALF_STATE=1; HALF_RUNNING="${running#v}"; HALF_ENV="$envv"; fi
  return 0
}
# Tell the hub (and so the panel's "Finish update") about a detected half state, or that there is none. No TTL on
# purpose: it describes the checkout, not a job. The hub ignores it once it runs the release .env names.
mark_half_state() { redis SET "$HALF_KEY" "{\"envVersion\":\"$(json_str "$1")\",\"runningVersion\":\"$(json_str "$2")\"}" >/dev/null 2>&1 || true; }
clear_half_state() { redis DEL "$HALF_KEY" >/dev/null 2>&1 || true; }

# The env file a pull runs against: a copy of .env that carries the pins this update WILL write, so compose resolves
# exactly the image references the recreate will use (digest-pinned when the job carries digests, else the tag) while
# .env itself keeps naming what runs. Removed right after the pull. Usage: stage_env <version> <hub> <web> <touched>
STAGED_ENV=""
stage_env() {
  local version="$1" hub="$2" web="$3" touched="$4"
  STAGED_ENV="${ENV_FILE}.stage.$$"
  rm -f "$STAGED_ENV"
  if [ -f "$ENV_FILE" ]; then
    (umask 077; cp "$ENV_FILE" "$STAGED_ENV") || { rm -f "$STAGED_ENV"; return 1; }
  else
    (umask 077; : > "$STAGED_ENV") || return 1
  fi
  write_pins_to "$STAGED_ENV" "$version" "$hub" "$web" "$touched" || { rm -f "$STAGED_ENV"; return 1; }
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

# Compare a pulled image's OCI version label with the requested target. FAIL-CLOSED for a digest-pinned update:
# returns 0 only when the label is present and matches; 1 when it differs (a validly-pulled digest of a DIFFERENT
# release), is MISSING (every release that ships digests in its manifest also carries the label, so a digest that
# resolves to an unlabelled image is an older image someone pointed us at), or when `docker image inspect` itself
# fails (the ref could not be resolved locally — nothing was verified). The label is self-asserted by the image, so
# this is defence in depth behind the digest; the signature gate comes later. The (sanitised) label is left in
# LABEL_SEEN, the failure kind in LABEL_FAIL (mismatch | missing | inspect_failed) for the caller's message.
# Dry-run hook: DRY_LABEL=<value> (default = the target, i.e. match; `missing` = no label; `inspect-fail`).
LABEL_SEEN=""
LABEL_FAIL=""
check_version_label() {
  local ref="$1" target="$2" label rc=0
  LABEL_SEEN=""; LABEL_FAIL=""
  if [ "$DRY" -eq 1 ]; then
    printf 'RUN: docker image inspect %s (label %s)\n' "$ref" "$VERSION_LABEL"
    label="${DRY_LABEL-$target}"
    if [ "$label" = "missing" ]; then label=""; fi
    if [ "$label" = "inspect-fail" ]; then label=""; rc=1; fi
  else
    label="$(docker image inspect -f "{{index .Config.Labels \"$VERSION_LABEL\"}}" "$ref" 2>/dev/null)" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then LABEL_FAIL="inspect_failed"; return 1; fi
  [ "$label" != "<no value>" ] || label=""
  # Keep only version-ish characters: the value ends up in a JSON status string.
  LABEL_SEEN="$(printf '%s' "$label" | tr -cd 'A-Za-z0-9._+-')"
  if [ -z "$LABEL_SEEN" ]; then LABEL_FAIL="missing"; return 1; fi
  if [ "${LABEL_SEEN#v}" = "${2#v}" ]; then return 0; fi
  LABEL_FAIL="mismatch"
  return 1
}

# Do a digest-pinned update only when BOTH digests are well-formed AND the compose file in this checkout knows
# the digest vars (a mixed new-script/old-compose state would silently ignore them and pull by tag).
# Sets PIN_HUB/PIN_WEB to the digests to use, or empty for the legacy tag-only path.
PIN_HUB=""
PIN_WEB=""
resolve_pins() {
  local hub="${1:-}" web="${2:-}"
  PIN_HUB=""; PIN_WEB=""
  [ -n "$hub$web" ] || return 0
  if ! is_hex64 "$hub" || ! is_hex64 "$web"; then
    log "ignoring malformed/partial image digests in the job (need both hubDigest and webDigest as 64-hex) — using the tag"
    return 0
  fi
  if ! grep -q 'TUGRA_HUB_DIGEST' "$COMPOSE_FILE" 2>/dev/null || ! grep -q 'TUGRA_WEB_DIGEST' "$COMPOSE_FILE" 2>/dev/null; then
    log "this checkout's compose file has no digest pin support (git pull + re-run install.sh) — using the tag"
    return 0
  fi
  PIN_HUB="$hub"; PIN_WEB="$web"
}

# PULL FIRST, WRITE .env LAST. Pull the exact target images, then verify they are THIS release, all before .env is
# touched; so a failure here (no disk, no network, a wrong digest) leaves nothing to roll back.
#   pull: `compose pull hub-api web` against a staged copy of .env (stage_env) = the exact refs the recreate will use.
#   verify (digest-pinned): the pulled `repo@sha256:…` must carry an OCI version label equal to the target — FAIL-CLOSED
#     (a valid digest of a different release, an unlabelled image, an uninspectable ref all refuse). Tag-only: the pulled
#     `repo:tag` must not report a DIFFERENT version (a missing label there is tolerated: releases that predate it, a
#     mirror that renames).
# On failure PULL_ERROR (human text, JSON-safe), PULL_CODE (pull_failed | disk_full | label | stage_failed) are set and
# 1 is returned. Usage: pull_target_images <target> <hubDigest> <webDigest> <touched>
PULL_ERROR=""
PULL_CODE=""
pull_target_images() {
  local target="$1" hub="$2" web="$3" touched="$4" out rc=0 cause svc ref why
  PULL_ERROR=""; PULL_CODE=""
  if [ "$DRY" -eq 1 ]; then
    printf 'RUN: stage a copy of .env with TUGRA_VERSION=%s for the pull (.env itself is not written yet)\n' "$target"
    printf 'RUN: docker compose --env-file <staged .env> -f %s pull hub-api web\n' "$COMPOSE_FILE"
  else
    if ! stage_env "$target" "$hub" "$web" "$touched"; then
      PULL_CODE="stage_failed"
      PULL_ERROR="could not prepare the pull (no space left next to $ENV_FILE?); nothing was changed"
      return 1
    fi
    out="$(docker compose --env-file "$STAGED_ENV" -f "$COMPOSE_FILE" pull hub-api web 2>&1)" || rc=$?
    rm -f "$STAGED_ENV"; STAGED_ENV=""
    [ -z "$out" ] || printf '%s\n' "$out"
    if [ "$rc" -ne 0 ]; then
      # here-string, not a pipe: under pipefail `printf | grep -q` fails on SIGPIPE when grep exits at the first match (see _line_in)
      if grep -qi 'no space left on device' <<<"$out"; then
        PULL_CODE="disk_full"
        PULL_ERROR="the disk filled up while pulling the images; free some space (remove unused Docker images or volumes) and retry"
      else
        PULL_CODE="pull_failed"
        cause="$(printf '%s\n' "$out" | sed "s/$(printf '\033')\[[0-9;]*[A-Za-z]//g" | sed '/^[[:space:]]*$/d' | tail -n1 | cut -c1-200)"
        PULL_ERROR="image pull failed${cause:+: $(json_str "$cause")}"
      fi
      return 1
    fi
  fi
  for svc in hub web; do
    if [ "$svc" = hub ]; then ref="$HUB_IMAGE_REPO"; else ref="$WEB_IMAGE_REPO"; fi
    if [ -n "$hub" ]; then
      if [ "$svc" = hub ]; then ref="$ref@sha256:$hub"; else ref="$ref@sha256:$web"; fi
    else
      ref="$ref:$target"
    fi
    if check_version_label "$ref" "$target"; then continue; fi
    # Tag-only: only a DIFFERENT version is fatal.
    if [ -z "$hub" ] && [ "$LABEL_FAIL" != "mismatch" ]; then continue; fi
    case "$LABEL_FAIL" in
      missing) why="image version label missing: $svc image carries no $VERSION_LABEL label (expected $target)" ;;
      inspect_failed) why="image version check failed: could not inspect the pulled $svc image $ref" ;;
      *) why="image version label mismatch: $svc reports $LABEL_SEEN, expected $target" ;;
    esac
    PULL_CODE="label"; PULL_ERROR="$why"
    return 1
  done
  return 0
}

# Start the updater's OWN replacement when the release changed the compose file (its service definition and image
# may have changed, and a container cannot recreate itself: `compose up` would kill the very process running it).
# A one-shot helper container does it from outside: same image (docker CLI + compose), the docker socket, and the
# checkout mounted at its HOST path — compose resolves the service's `..:/repo` bind relative to the compose file's
# directory, so that path must be the real host path, which is read from this container's own /repo mount.
# Detached + delayed so the status/lock are already final when this container goes away. Best-effort: on any
# failure the old updater simply keeps running (the next update or installer run retries), the update itself is done.
UPDATER_REFRESH_SCHEDULED=0
refresh_updater_self() {
  local cid src image want
  if [ "$DRY" -eq 1 ]; then printf 'RUN: refresh tugra-updater via a one-shot helper container\n'; return 0; fi
  cid="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q tugra-updater 2>/dev/null | head -n1 || true)"
  [ -n "$cid" ] || { log "warning: could not find the updater container; it will be refreshed on the next installer run"; return 0; }
  src="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/repo"}}{{.Source}}{{end}}{{end}}' "$cid" 2>/dev/null || true)"
  image="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
  case "$src" in /*) ;; *) src="" ;; esac
  if [ -z "$src" ] || [ -z "$image" ]; then
    log "warning: could not resolve the checkout's host path; the updater will be refreshed on the next installer run"
    return 0
  fi
  # The helper's `compose up` must be quick: if the new image is not in the local cache it would have to pull
  # first, and the old updater could resume the queue and start a job that the recreate then cuts off. So never
  # schedule the recreate without the image present (a pre-pull that failed is retried by the next update/start).
  want="$(updater_expected_image)"
  if [ -n "$want" ] && ! docker image inspect "$want" >/dev/null 2>&1; then
    log "warning: the updater image $want is not pulled yet; leaving the updater as it is (the next update or start retries)"
    return 0
  fi
  docker rm -f tugra-updater-refresh >/dev/null 2>&1 || true
  if docker run -d --rm --name tugra-updater-refresh \
      -v /var/run/docker.sock:/var/run/docker.sock -v "$src:$src" -w "$src" --entrypoint sh "$image" \
      -c 'sleep 5 && exec docker compose --profile updater --project-directory "$1/deploy" --env-file "$1/.env" -f "$1/deploy/docker-compose.yml" up -d --no-deps tugra-updater' \
      sh "$src" >/dev/null 2>&1; then
    UPDATER_REFRESH_SCHEDULED=1
    # Record the attempt now, whichever path scheduled it: a script-reload exec right after an update re-runs the
    # start-up catch-up while this helper is still pending, and it must see this refresh as already under way.
    if [ -n "$want" ]; then redis SET "$UPDATER_REFRESH_KEY" "$want" >/dev/null 2>&1 || true; fi
    log "updater refresh scheduled (the sidecar restarts in a few seconds)"
  else
    log "warning: could not start the updater refresh helper; the updater will be refreshed on the next installer run"
  fi
}

# The image reference compose now resolves for the updater service (TUGRA_VERSION already moved in .env). Empty
# when it cannot be determined.
updater_expected_image() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile updater config 2>/dev/null \
    | awk '/^  tugra-updater:[[:space:]]*$/{s=1;next} s&&/^  [^ ]/{s=0} s&&/^    image:/{sub(/^    image:[[:space:]]*/,""); gsub(/"/,""); print; exit}' || true
}

# A local image the free-space probe can run `df` in: the image the running updater container was created from.
updater_image_ref() {
  local cid
  cid="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q tugra-updater 2>/dev/null | head -n1 || true)"
  [ -n "$cid" ] || return 0
  docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true
}

# True (0) when the RUNNING updater container is not on the image the compose file now names: a different tag
# (an image-only release moved TUGRA_VERSION, so the compose text did not change but the tag did) or the same
# tag whose local image id moved (a re-pulled `latest`). Anything undeterminable counts as "not stale" so a
# docker hiccup can never make every update restart the sidecar.
updater_image_stale() {
  local cid want have running_id want_id
  [ "$DRY" -eq 1 ] && return 1
  cid="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q tugra-updater 2>/dev/null | head -n1 || true)"
  [ -n "$cid" ] || return 1
  want="$(updater_expected_image)"
  [ -n "$want" ] || return 1
  have="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
  [ -n "$have" ] || return 1
  if [ "$have" != "$want" ]; then return 0; fi
  running_id="$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)"
  want_id="$(docker image inspect -f '{{.Id}}' "$want" 2>/dev/null || true)"
  if [ -n "$running_id" ] && [ -n "$want_id" ] && [ "$running_id" != "$want_id" ]; then return 0; fi
  return 1
}

# The local agent's platform architecture as the release pipeline names it (amd64 | arm64), from the engine itself.
# Dry-run hook: DRY_ARCH (default amd64).
local_arch() {
  local a
  if [ "$DRY" -eq 1 ]; then printf '%s' "${DRY_ARCH:-amd64}"; return 0; fi
  a="$(docker version --format '{{.Server.Arch}}' 2>/dev/null | tr -d '[:space:]' || true)"
  case "$a" in x86_64) a=amd64 ;; aarch64) a=arm64 ;; esac
  printf '%s' "$a"
}

# Bring the bundled agent onto <version>: pull its image (pull_agent_image, lib/images.sh: by signed per-arch digest
# when the job carries one, else a plain `docker pull`), then recreate ONLY the agent service from the local image.
# `compose pull agent` is deliberately not used — it fails on the containerd image store (see lib/images.sh), and its
# "must be built from source: docker compose build agent" follow-up warning is just that failure surfacing.
# Usage: refresh_local_agent <version> <amd64 digest> <arm64 digest>
refresh_local_agent() {
  local version="$1" amd="${2:-}" arm="${3:-}" arch digest=""
  arch="$(local_arch)"
  case "$arch" in amd64) digest="$amd" ;; arm64) digest="$arm" ;; esac
  is_hex64 "$digest" || digest=""
  if [ "$DRY" -eq 1 ]; then
    if [ -n "$digest" ]; then
      printf 'RUN: docker pull %s@sha256:%s\n' "$AGENT_IMAGE_REPO" "$digest"
      printf 'RUN: docker tag <that image> %s:%s\n' "$AGENT_IMAGE_REPO" "$version"
    else
      printf 'RUN: docker pull %s:%s\n' "$AGENT_IMAGE_REPO" "$version"
    fi
    compose up -d --no-deps agent
    return 0
  fi
  if ! pull_agent_image "$version" "$digest"; then
    log "could not pull the agent image $AGENT_IMAGE_REPO:$version${digest:+ (platform digest ${digest:0:12}…)}"
    return 1
  fi
  compose up -d --no-deps agent
}

# Pre-pull the updater image the compose file names for <version> with a plain `docker pull` (never `compose pull`:
# the updater's release tag is built with the same BuildKit attestations as the agent's, see lib/images.sh).
# Usage: pull_updater_image_for <version>
pull_updater_image_for() {
  local ref=""
  if [ "$DRY" -eq 1 ]; then printf 'RUN: docker pull %s:%s\n' "$UPDATER_IMAGE_REPO" "$1"; return 0; fi
  ref="$(updater_expected_image)"
  pull_updater_image "$1" "$ref"
}

# Remove Tugra's own release images older than the previous release. Opt-out: TUGRA_PRUNE_IMAGES=0 (env or .env).
# Usage: prune_old_release_images <current (new) version> <previous version>
prune_old_release_images() {
  if [ "$(_snap_cfg TUGRA_PRUNE_IMAGES 1)" = "0" ]; then
    log "image cleanup disabled (TUGRA_PRUNE_IMAGES=0)"
    return 0
  fi
  if [ "$DRY" -eq 1 ]; then
    printf 'RUN: remove Tugra release images older than %s (keeping %s and %s)\n' "$2" "$1" "$2"
    return 0
  fi
  prune_release_images "$1" "$2" || log "warning: image cleanup did not finish"
}

# One-shot: verify + apply the release's signed compose/scripts to THIS checkout for a stack that already runs that
# release. Used by the hub's bootstrap of an install whose update.sh predates host-files support (such a script
# ignores the job's hostFilesDigest, so the checkout never received a newer compose file or script). Same trust model
# and the same backup + validation as an in-app update (lib/hostfiles.sh); nothing is pulled or recreated.
# Exit: 0 applied or already current, 1 refused/failed (HF_ERROR printed), 2 bad arguments.
apply_host_files_only() {
  local version="$1" digest="$2" cur
  if ! hf_version_ok "$version" || ! is_hex64 "$digest"; then log "host files: need a release version and a 64-hex digest"; return 2; fi
  cur="$(env_get TUGRA_VERSION)"
  if [ "$cur" != "$version" ]; then
    log "host files: this stack runs ${cur:-an unpinned version}, not $version — refusing (the bootstrap only syncs files to the running release)"
    return 1
  fi
  HF_APPLIED=0; HF_BACKUP_DIR=""; HF_CHANGED=(); HF_SCRIPTS_CHANGED=0; HF_COMPOSE_CHANGED=0; HF_VERIFIED=0; HF_LOCAL_EDITS=()
  if ! hf_prepare "$version" "$digest"; then
    log "host files: $HF_ERROR — nothing was changed"
    hf_cleanup
    return 1
  fi
  if [ "${#HF_CHANGED[@]}" -eq 0 ]; then
    log "host files: compose and scripts already match release $version"
    hf_sync_checkout "$version"
    hf_cleanup
    return 0
  fi
  if backup_dir_ok; then HF_BACKUP_ROOT="$(_snap_cfg TUGRA_BACKUP_DIR "$REPO_DIR/backups")"; else HF_BACKUP_ROOT="$REPO_DIR/backups"; fi
  if ! hf_apply "$version" "$version"; then
    log "host files: $HF_ERROR"
    hf_cleanup
    return 1
  fi
  log "host files: ${#HF_CHANGED[@]} file(s) brought to release $version"
  hf_sync_checkout "$version"
  hf_cleanup
  return 0
}

# Set when a successful update replaced scripts: the watch loop then re-execs the (new) update.sh.
RELOAD_SELF=0

do_update() {
  # The target names a docker tag and is written into .env: only a plain version string gets that far (a queue job is
  # data, never trusted to be one). Nothing is changed, snapshotted or pulled for anything else.
  if ! hf_version_ok "${1:-}"; then
    log "refusing a malformed target version"
    set_status failed "unknown" "\"malformed target version\""
    release_lock
    return 0
  fi
  HF_APPLIED=0; HF_BACKUP_DIR=""; HF_CHANGED=(); HF_SCRIPTS_CHANGED=0; HF_COMPOSE_CHANGED=0; HF_VERIFIED=0; HF_LOCAL_EDITS=()
  PINS_TOUCH_FORCE=0; HALF_STATE=0; HALF_RUNNING=""; HALF_ENV=""
  _do_update "$@"
  local rc=$?
  hf_cleanup   # the private staging dir never outlives a job, whatever branch it ended on
  return "$rc"
}

# A failed update: status failed + a cause (never a bare "failed"), lock released.
# fail_update <target> <message (plain text)> [<code> [<extra JSON members>]]
fail_update() {
  local target="$1" msg="$2" code="${3:-}" extra="${4:-}"
  if [ -n "$code" ]; then extra=",\"code\":\"$code\"${extra}"; fi
  set_status failed "$target" "\"$(json_str "$msg")\"" "$extra"
  release_lock
}

_do_update() {
  local target="$1" hubDigest="${2:-}" webDigest="${3:-}" hostDigest="${4:-}" agentAmd64="${5:-}" agentArm64="${6:-}"
  local current envCurrent; envCurrent="$(env_get TUGRA_VERSION)"; current="${envCurrent:-latest}"

  # What .env says is only what the NEXT `up` would use. If the containers run an OLDER release, an earlier update
  # stopped half-way (it wrote .env, then the pull or the rollback failed: full disk, crash, an updater older than this
  # check). That is not "nothing to do": the running release is the real baseline (rollback target, the never-downgrade
  # guard, which images to prune) and this run finishes the job.
  local envHub envWeb
  envHub="$(env_get TUGRA_HUB_DIGEST)"; is_hex64 "$envHub" || envHub=""
  envWeb="$(env_get TUGRA_WEB_DIGEST)"; is_hex64 "$envWeb" || envWeb=""
  detect_half_state "$envCurrent"
  if [ "$HALF_STATE" -eq 1 ]; then
    log "half-finished update found: $ENV_FILE names $HALF_ENV but the running stack is on $HALF_RUNNING — finishing it (target $target)"
    mark_half_state "$HALF_ENV" "$HALF_RUNNING"
    current="$HALF_RUNNING"
    if [ -n "$envHub$envWeb" ]; then PINS_TOUCH_FORCE=1; fi
  fi
  if [ "$current" != "latest" ] && ! is_newer "$target" "$current"; then
    log "refusing non-newer target $target (current $current)"
    fail_update "$target" "target $target is not newer than the running version $current"
    return 0
  fi

  # Previous digest pins (empty = the stack is tag-only). A malformed value is treated as unpinned so a hand-edited
  # .env can never be written back as garbage by a rollback. In a half state the pins in .env belong to a release that
  # never ran, so the previous pins are none.
  # In a half state the pins to go back to are the ones the RUNNING containers were created from (a digest pull leaves no
  # local tag, so a rollback by tag alone would need the registry): read from them, empty for a container on a plain tag.
  local prevHub prevWeb
  if [ "$HALF_STATE" -eq 1 ]; then
    prevHub=""; prevWeb=""
    if [ "$DRY" -eq 0 ]; then
      prevHub="$(running_pin hub-api)"; is_hex64 "$prevHub" || prevHub=""
      prevWeb="$(running_pin web)"; is_hex64 "$prevWeb" || prevWeb=""
    fi
  else
    prevHub="$envHub"; prevWeb="$envWeb"
  fi
  log "updating $current -> $target"
  set_status pulling "$target"   # the hub knows no separate "snapshotting" phase; the snapshot runs under "pulling"

  # DISK PREFLIGHT, before anything is written or pulled: room for the target images in the Docker data root and for
  # the bookkeeping in the install dir. When short, the safe image cleanup runs once and it is measured again; still
  # short = refuse here with the numbers, nothing touched (lib/images.sh disk_preflight).
  if [ "$DRY" -eq 1 ]; then
    printf 'RUN: disk preflight (free space of the Docker data root and %s; safe image cleanup first when short)\n' "$REPO_DIR"
  else
    DISK_TARGET="$target"; DISK_BACKUP_BYTES="$(snap_dump_estimate)"
    if ! disk_preflight "$current" "$REPO_DIR" "$(updater_image_ref)"; then
      log "$(disk_short_text) — nothing was changed"
      fail_update "$target" "$(disk_short_text)" disk_space ",\"needBytes\":$DISK_NEED,\"haveBytes\":$DISK_HAVE,\"path\":\"$(json_str "$DISK_PATH")\""
      return 0
    fi
  fi

  # Release host files (compose + installer scripts), PREFLIGHT: download, verify (ed25519 + hashes) and validate them
  # in a private staging dir. Nothing in the checkout changes here, so a failure aborts with nothing changed. When the
  # checkout already matches the release (the common case: only the images changed) this is the fast path — the
  # signed manifest is fetched and compared, no file is downloaded and nothing is applied.
  if [ -n "$hostDigest" ]; then
    if ! hf_prepare "$target" "$hostDigest"; then
      log "host files: $HF_ERROR — aborting, nothing was changed"
      fail_update "$target" "update refused: $HF_ERROR; nothing was changed"
      return 0
    fi
    if [ "${#HF_CHANGED[@]}" -eq 0 ]; then
      log "host files: compose and scripts already match release $target"
    else
      log "host files: release $target changes ${HF_CHANGED[*]}"
    fi
  else
    log "this release publishes no signed compose/scripts (images-only update; changes to them still need git pull + install.sh)"
  fi

  # MANDATORY restore point BEFORE anything changes: the new hub runs `prisma migrate deploy` on boot and
  # migrations are not reversible, so a failed update needs a dump to go back to. If it cannot be taken we
  # abort with NOTHING changed (no .env edit, no pull). PRE_UPDATE_BACKUP=0 is the only (unsafe) opt-out.
  SNAPSHOT_PATH=""
  if snapshot_disabled; then
    log "WARNING: PRE_UPDATE_BACKUP=0 — updating WITHOUT a pre-update restore point"
  elif ! backup_dir_ok; then
    log "TUGRA_BACKUP_DIR must be an absolute path inside the checkout ($REPO_DIR) for the in-app updater — aborting, nothing was changed"
    fail_update "$target" "pre-update backup failed: TUGRA_BACKUP_DIR must be inside the checkout for the in-app updater"
    return 0
  elif ! tugra_snapshot "$current" "$target"; then
    log "pre-update backup failed — aborting, nothing was changed"
    fail_update "$target" "pre-update backup failed; nothing was changed"
    return 0
  fi
  # Apply the release's compose/scripts (backup first, atomic renames, restored by recover_all / the branches below on
  # any later failure). Before resolve_pins so the digest-support check reads the NEW compose file. .env is untouched.
  if [ "${#HF_CHANGED[@]}" -gt 0 ]; then
    if backup_dir_ok; then HF_BACKUP_ROOT="$(_snap_cfg TUGRA_BACKUP_DIR "$REPO_DIR/backups")"; else HF_BACKUP_ROOT="$REPO_DIR/backups"; fi
    if ! hf_apply "$current" "$target"; then
      log "host files: $HF_ERROR — aborting"
      snapshot_discard   # nothing changed: the dump would only sit on a possibly tight disk
      fail_update "$target" "update refused: $HF_ERROR$(snap_note)"
      return 0
    fi
  fi
  resolve_pins "$hubDigest" "$webDigest"
  hubDigest="$PIN_HUB"; webDigest="$PIN_WEB"
  local touched=0
  if [ -n "$prevHub$prevWeb$hubDigest$webDigest" ] || [ "$PINS_TOUCH_FORCE" -eq 1 ]; then touched=1; fi
  if [ -n "$hubDigest" ]; then
    log "digest-pinned: hub ${hubDigest:0:12}… web ${webDigest:0:12}…"
  fi

  # PULL FIRST: the exact target images (digest-pinned when the job carries digests, else the tag), then their version
  # labels — all while .env still names what runs. A failure here has nothing to roll back; only the release's
  # compose/scripts (applied above) are put back. A half-finished update (.env ahead of what runs) whose target cannot
  # be pulled is repaired instead: .env goes back to the running release, so it never names images that are not there.
  if ! pull_target_images "$target" "$hubDigest" "$webDigest" "$touched"; then
    log "$PULL_ERROR — .env was not changed"
    local repaired=""
    if [ "$HALF_STATE" -eq 1 ]; then
      if restore_env "$current" "$prevHub" "$prevWeb" "$envHub" "$envWeb"; then
        repaired="; $ENV_FILE was set back to the running version $current"
        clear_half_state
      else
        log "could not roll back $ENV_FILE to $current"
        repaired="; $ENV_FILE still names $HALF_ENV (set TUGRA_VERSION=$current by hand)"
      fi
    fi
    hf_undo
    snapshot_discard   # nothing but the host files changed (and those are back): drop this run's dump, a retry takes a new one
    local code=""
    case "$PULL_CODE" in disk_full) code="disk_space" ;; esac
    fail_update "$target" "$PULL_ERROR$repaired$(hf_note)" "$code"
    return 0
  fi

  # WRITE .env LAST (atomic + verified, see env_put): everything that can fail without touching a container has passed.
  # Tag-only -> tag-only keeps today's exact behaviour (only TUGRA_VERSION is written). Otherwise the digests are
  # written too: pinned target = the new digests; legacy target on a pinned stack = cleared (an old pin would
  # otherwise override the new tag and pull the OLD image).
  local envBefore; envBefore="$(cat "$ENV_FILE" 2>/dev/null || true)"
  if ! write_pins "$target" "$hubDigest" "$webDigest" "$touched"; then
    log "could not write $ENV_FILE — aborting"
    local envNote="; $ENV_FILE was not changed and the previous version keeps running"
    if [ "$(cat "$ENV_FILE" 2>/dev/null || true)" != "$envBefore" ]; then
      # A key was written before the failing one (every single write is atomic, a sequence of them is not): put it back.
      envNote="; the previous version keeps running"
      if ! restore_env "$current" "$prevHub" "$prevWeb" "$hubDigest" "$webDigest"; then
        log "could not roll back $ENV_FILE"
        # The next update (or "Finish update") sees .env ahead of what runs and repairs it; say so rather than hide it.
        mark_half_state "$target" "$current"
        envNote="; the previous version keeps running, but $ENV_FILE may still name $target (set TUGRA_VERSION=$current by hand, or free disk space and click Update now again)"
      fi
    fi
    hf_undo
    fail_update "$target" "could not update .env (disk full or not writable?)$envNote$(hf_note)$(snap_note)"
    return 0
  fi

  set_status recreating "$target"
  if ! compose up -d --no-deps hub-api web; then
    log "recreate failed — restoring $current"
    # `compose up` is NOT atomic across hub-api + web: a partial recreate may already have swapped one of
    # them to the new image. Actively bring the previous version back and VERIFY it, rather than only
    # rewriting the .env tag (which left a broken old/new mix running).
    if recover_all "$current" "$prevHub" "$prevWeb" "$hubDigest" "$webDigest"; then
      set_status failed "$target" "\"recreate failed; restored $current$(snap_note)\""
    else
      set_recovery_required "$target" "$current" "$prevHub" "$prevWeb" "$hubDigest" "$webDigest"
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
    if recover_all "$current" "$prevHub" "$prevWeb" "$hubDigest" "$webDigest"; then
      set_status failed "$target" "\"update to $target failed health check; restored $current and verified healthy$(snap_note)\""
    else
      set_recovery_required "$target" "$current" "$prevHub" "$prevWeb" "$hubDigest" "$webDigest"
    fi
    release_lock
    return 0
  fi

  # hub-api + web are verified healthy: now bring the bundled local agent along (the hub's protocol gate keeps
  # an old agent working meanwhile) and pre-pull the updater image. Both are best-effort — a failure here must
  # never fail an otherwise good update. `--no-deps` + an explicit service name: postgres/redis/updater are
  # never recreated here (the updater can't recreate itself mid-run; refresh_updater_self does it detached, last).
  if [ "$DRY" -eq 1 ] || [ -n "$(compose ps -q agent 2>/dev/null | head -n1)" ]; then
    if refresh_local_agent "$target" "$agentAmd64" "$agentArm64"; then
      log "local agent refreshed to $target"
    else
      log "warning: could not refresh the local agent (the update itself is fine; the hub retries it on its own, or re-run scripts/install.sh)"
    fi
  fi
  pull_updater_image_for "$target" || log "warning: could not pre-pull the updater image"

  set_status done "$target"
  redis DEL "instance:update:recovery_required" # a verified update clears any stale recovery marker
  clear_half_state
  release_lock
  log "update to $target complete"
  # The release's compose/scripts were written into the checkout: bring its git state in line (never fatal).
  hf_sync_checkout "$target"
  # Disk housekeeping, after the status is final (a slow `rmi` never delays the UI): drop Tugra's own release images
  # older than the previous release. Never fatal, never touches anything that is not a Tugra release image.
  prune_old_release_images "$target" "$current"
  # Replaced scripts take effect for the NEXT job (this process keeps running the old file); a replaced compose
  # file also redefines the updater service itself. The updater is also refreshed when it still runs an older
  # image than the release's compose names (an image-only release changes no compose text but moves the tag).
  # All of it happens after the status is final.
  if [ "$HF_SCRIPTS_CHANGED" -eq 1 ]; then RELOAD_SELF=1; fi
  if [ "$HF_COMPOSE_CHANGED" -eq 1 ] || updater_image_stale; then refresh_updater_self; fi
}

# Extract one flat string field ("key":"value") from a queue job without jq; empty when absent. `|| true`: a
# missing key makes grep exit 1, which under `set -o pipefail` would abort the caller's assignment.
job_field() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -n1 | cut -d'"' -f4 || true; }

# One queue job: {"targetVersion":"X"} (legacy) or {"targetVersion":"X","hubDigest":"<64hex>","webDigest":"<64hex>"}.
handle_job() {
  local job="$1" target hub web host agentAmd64 agentArm64
  # A panel-domain change (Settings -> Instance): same queue, its own handler (lib/paneldomain.sh). It never takes
  # or releases the update lock — it is not an update.
  if [ "$(job_field "$job" action)" = "panel-domain" ]; then
    if declare -F panel_domain_job >/dev/null 2>&1; then panel_domain_job "$job"; else log "panel-domain: this updater has no panel-domain support yet — ignoring the job"; fi
    return 0
  fi
  target="$(job_field "$job" targetVersion)"
  if [ -z "$target" ]; then
    log "ignoring malformed job: $job"
    release_lock
    return 0
  fi
  hub="$(job_field "$job" hubDigest)"
  web="$(job_field "$job" webDigest)"
  host="$(job_field "$job" hostFilesDigest)"
  agentAmd64="$(job_field "$job" agentAmd64Digest)"
  agentArm64="$(job_field "$job" agentArm64Digest)"
  do_update "$target" "$hub" "$web" "$host" "$agentAmd64" "$agentArm64"
}

# One-shot prune for a stack that already runs <version>. prune_select treats "previous == current" as "keep the newest
# release below current that is on disk", so no previous version has to be known. A stack on another version is left alone.
prune_images_only() {
  local version="$1" cur
  if ! hf_version_ok "$version"; then log "image cleanup: need a release version"; return 2; fi
  cur="$(env_get TUGRA_VERSION)"
  if [ "${cur#v}" != "${version#v}" ]; then
    log "image cleanup: this stack runs ${cur:-an unpinned version}, not $version — nothing removed"
    return 1
  fi
  prune_old_release_images "$version" "$version"
}

if [ "$PRUNE_ONLY" -eq 1 ]; then
  prune_images_only "$PRUNE_VERSION"
  exit $?
fi

if [ "$APPLY_HF" -eq 1 ]; then
  apply_host_files_only "$APPLY_HF_VERSION" "$APPLY_HF_DIGEST"
  exit $?
fi

if [ "$DRY" -eq 1 ]; then
  if [ -n "$JOB" ]; then handle_job "$JOB"; exit 0; fi
  [ -n "$TARGET" ] || { printf 'error: --dry-run requires --target <version> (or --job <json>)\n' >&2; exit 1; }
  do_update "$TARGET"
  exit 0
fi

if [ "$WATCH" -ne 1 ]; then
  printf 'usage: update.sh --watch  (or --dry-run --target <version>)\n' >&2
  exit 1
fi

# Catch-up at start (and after a script-reload exec): an updater whose image is older than the one compose now
# names (the previous release ran an update.sh that predates the post-update refresh, or its helper failed) is
# refreshed before it takes any job, so it converges without an installer run. Race-free: the loop is not
# draining the queue while the helper is pending, and the image is pulled first, so the recreate is a quick local
# swap. Attempted once per expected image (a marker in Redis, written when a refresh is scheduled by any path), so an
# image string that never compares equal cannot cause a restart loop and a refresh already pending is not redone.
catch_up_updater() {
  local want last
  updater_image_stale || return 0
  want="$(updater_expected_image)"
  last="$(redis GET "$UPDATER_REFRESH_KEY" 2>/dev/null || true)"
  if [ "$last" = "$want" ]; then return 0; fi
  log "the running updater image is not $want — refreshing it before taking jobs"
  pull_updater_image_for "${want##*:}" || log "warning: could not pull the updater image"
  refresh_updater_self
  # The helper recreates this container in a few seconds; keep out of the queue until then. If it could not
  # be started (or never fires) carry on with the old updater.
  if [ "$UPDATER_REFRESH_SCHEDULED" -eq 1 ]; then sleep "$UPDATER_REFRESH_WAIT"; fi
}
catch_up_updater

# Start-up check for a half-finished update (.env names a release newer than the one the containers run): left by a crash,
# a full disk, or an updater older than this fix. Reported to the hub, which shows "Finish update" in Settings > Updates;
# the next "Update now" repairs it by itself either way (see _do_update). No half state clears an earlier report.
# At host boot or right after a stack `up` this can run before hub-api and web are up: then the running release is UNKNOWN,
# which is no evidence of a consistent install, so an earlier report is kept (only a positive "consistent" reading clears it)
# and the check is repeated from the queue loop below. The log line is printed once per distinct half state.
HALF_LOGGED=""
report_half_state() {
  detect_half_state "$(env_get TUGRA_VERSION)"
  if [ "$HALF_STATE" -eq 1 ]; then
    if [ "$HALF_LOGGED" != "$HALF_ENV>$HALF_RUNNING" ]; then
      log "half-finished update: $ENV_FILE names $HALF_ENV but the running stack is on $HALF_RUNNING — Settings > Updates offers 'Finish update'"
      HALF_LOGGED="$HALF_ENV>$HALF_RUNNING"
    fi
    mark_half_state "$HALF_ENV" "$HALF_RUNNING"
  elif [ "$HALF_KNOWN" -eq 1 ]; then
    HALF_LOGGED=""
    clear_half_state
  fi
}
report_half_state

log "watching $QUEUE_KEY on $REDIS_URL"
while true; do
  # BLPOP returns two lines: the key name, then the popped value. It times out every HALF_RECHECK seconds (empty answer) so the
  # half-state report is refreshed while the queue is idle: the stack may only have come up after this updater started.
  job="$(redis-cli -u "$REDIS_URL" BLPOP "$QUEUE_KEY" "${HALF_RECHECK:-60}" | sed -n '2p')"
  if [ -z "$job" ]; then report_half_state; continue; fi
  handle_job "$job" || log "update run errored (continuing to watch)"
  if [ "$RELOAD_SELF" -eq 1 ]; then
    # The release replaced update.sh/lib/*.sh: restart the loop on the new code (its syntax was checked before it
    # was applied). Hand the loop a fresh process rather than running old code for the next job.
    log "scripts were updated — reloading the updater"
    exec bash "$SCRIPT_DIR/update.sh" --watch
  fi
done
