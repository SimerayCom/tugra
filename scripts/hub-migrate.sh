#!/usr/bin/env bash
# Tugra hub migration — move the whole control plane to a new host with NO manual pg_dump.
#
# The hub's entire state lives in one Docker volume (Postgres) plus the repo-root .env (which holds the
# encryption key, the DB password and the agent-signing key). This tool packs that state into one bundle and
# restores it on a fresh host, so everything — servers, apps, env, GitHub App connections, deploy history —
# comes across intact and the hub continues exactly where it left off. No pg_dump/pg_restore by hand.
#
# SCOPE: this moves the CONTROL PLANE only. App containers, their named volumes, the TLS proxy and host
# firewall are NOT carried — apps on remote servers keep running untouched; apps on the hub's own "This
# machine" server must be moved with Tugra's per-app/volume backups or redeployed (pack warns if any exist).
#
# Usage:
#   scripts/hub-migrate.sh pack   [--out <file>] [--include-redis] [--encrypt] [--no-restart] [--yes]
#   scripts/hub-migrate.sh unpack <bundle>        [--yes]
#
# Options:
#   --out <file>      pack: bundle path (default ./tugra-hub-<date>.tar[.enc]).
#   --include-redis   pack: also carry the Redis volume (job queues/cache; rebuildable — off by default).
#   --encrypt         pack: encrypt the bundle with a passphrase (openssl aes-256-cbc). unpack auto-detects .enc.
#   --no-restart      pack: leave the source stack stopped (for a real move — avoids a split-brain with the new hub).
#   --yes             skip confirmation prompts (also: ASSUME_YES=1 in the environment).
#
# WARNING: a bundle contains ALL your secrets (encryption key, DB password, signing key). It is written 0600;
# store it offsite and encrypted (--encrypt), and delete it when the move is done.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_DIR/deploy/docker-compose.yml"
ENV_FILE="$REPO_DIR/.env"
ETC_TUGRA="/etc/tugra"
ASSUME_YES="${ASSUME_YES:-0}"   # may be set by the environment (install.sh --restore-from forwards it)

# Compose project name → the prefix Docker gives the volumes (name: tugra in the compose file). An operator
# COMPOSE_PROJECT_NAME override wins; otherwise read `name:` from the compose file, defaulting to "tugra".
PROJECT="${COMPOSE_PROJECT_NAME:-}"
if [ -z "$PROJECT" ] && [ -f "$COMPOSE_FILE" ]; then
  PROJECT="$(grep -E '^name:' "$COMPOSE_FILE" 2>/dev/null | head -n1 | sed 's/^name:[[:space:]]*//' | tr -d '"'"'"'[:space:]' || true)"
fi
PROJECT="${PROJECT:-tugra}"
case "$PROJECT" in
  [a-zA-Z0-9]*) : ;;
  *) echo "error: refusing an unsafe compose project name: $PROJECT" >&2; exit 1 ;;
esac
case "$PROJECT" in *[!a-zA-Z0-9_-]*) echo "error: unsafe compose project name: $PROJECT" >&2; exit 1 ;; esac

# The compose volume KEYS (not the prefixed docker names). These never change in our compose file.
VOL_PG_KEY="tugra_pg"
VOL_REDIS_KEY="tugra_redis"
VOL_AGENT_KEY="tugra-agent-data"

log()  { printf '\033[38;5;179m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
note() { printf '  \033[33m!\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  if [ ! -r /dev/tty ]; then err "no TTY to confirm on — re-run with --yes to proceed non-interactively"; return 1; fi
  printf '%s [y/N] ' "$1" >&2
  read -r _ans </dev/tty || _ans=""
  case "$_ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

compose() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
env_get() { grep "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true; }

# The tar/gzip helper runs inside a throwaway container so it works regardless of the volume driver or where
# Docker stores volume data. Derived from the compose postgres pin (already present — it is the hub DB), so
# no extra image is pulled and the version always matches. busybox tar lacks inline -z, so gzip is explicit.
HELPER_IMAGE="${TUGRA_HELPER_IMAGE:-}"
if [ -z "$HELPER_IMAGE" ] && [ -f "$COMPOSE_FILE" ]; then
  HELPER_IMAGE="$(grep -E 'image:[[:space:]]*postgres:' "$COMPOSE_FILE" 2>/dev/null | head -n1 | sed -E 's/.*image:[[:space:]]*//' | tr -d '"'"'"'[:space:]' || true)"
fi
HELPER_IMAGE="${HELPER_IMAGE:-postgres:16-alpine}"

# Resolve a compose volume KEY to its real docker volume name. Prefer the compose label (exact, survives a
# custom project name); fall back to the conventional <project>_<key>.
resolve_vol() {
  _key="$1"; _name=""
  _name="$(docker volume ls --filter "label=com.docker.compose.project=$PROJECT" \
           --filter "label=com.docker.compose.volume=$_key" --format '{{.Name}}' 2>/dev/null | head -n1 || true)"
  [ -n "$_name" ] || _name="${PROJECT}_${_key}"
  printf '%s' "$_name"
}
vol_exists() { docker volume inspect "$1" >/dev/null 2>&1; }
# running-only: for pack after `compose stop` (containers still EXIST but must not be writing).
vol_in_use_running() { [ -n "$(docker ps -q --filter "volume=$1" 2>/dev/null || true)" ]; }
# any (incl. stopped): for unpack after `compose down` (containers should be gone before a wipe).
vol_in_use() { [ -n "$(docker ps -aq --filter "volume=$1" 2>/dev/null || true)" ]; }

# Tar a volume OUT to <out-dir>/<base>.tar.gz. `set -e` inside the container so a tar error aborts (busybox
# `tar | gzip` would otherwise mask tar's exit); tar to a file, then gzip the file.
tar_volume_out() { # <docker-volume> <out-dir> <base>
  docker run --rm -v "$1":/v:ro -v "$2":/out "$HELPER_IMAGE" \
    sh -c 'set -e; cd /v; tar cf /out/'"$3"'.tar .; gzip -f /out/'"$3"'.tar'
}
# Wipe the volume, assert empty, then extract. <sentinel> (optional) is a relative path that MUST exist after
# extraction (e.g. ./PG_VERSION for Postgres) — a torn extract is caught here, after a host-side gzip -t.
tar_volume_in() { # <docker-volume> <in-dir> <base> [sentinel]
  docker run --rm -v "$1":/v -v "$2":/in "$HELPER_IMAGE" \
    sh -c 'set -e; cd /v; rm -rf ./* ./.[!.]* ./..?* 2>/dev/null || true;
           [ -z "$(ls -A /v)" ] || { echo "volume not empty after wipe" >&2; exit 1; }
           gunzip -c /in/'"$3"'.tar.gz | tar xf -;
           [ -z "'"${4:-}"'" ] || [ -e "'"${4:-}"'" ] || { echo "restored volume is missing '"${4:-}"'" >&2; exit 1; }'
}

# True if the Postgres archive contains PG_VERSION (a real PGDATA). Captures the listing first so that, with
# `set -o pipefail` on, a `grep -q` early-exit SIGPIPE cannot be misread as a failed check.
pg_archive_ok() {
  _l="$(gunzip -c "$1" 2>/dev/null | tar tf - 2>/dev/null || true)"
  case "$_l" in *PG_VERSION*) return 0 ;; *) return 1 ;; esac
}
sha256_of() { # <file> → hex or empty
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else printf ''; fi
}
arch() { uname -m 2>/dev/null || echo unknown; }
# Postgres major from the helper image tag (both ends share the compose pin, so this is stable).
pg_major() { printf '%s' "$HELPER_IMAGE" | sed -nE 's#.*postgres:([0-9]+).*#\1#p' | head -n1; }

# ----------------------------------------------------------------------------------------------------- pack
cmd_pack() {
  OUT=""; INCLUDE_REDIS=0; ENCRYPT=0; NO_RESTART=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --out) [ $# -ge 2 ] || die "--out needs a value"; OUT="$2"; shift 2 ;;
      --include-redis) INCLUDE_REDIS=1; shift ;;
      --encrypt) ENCRYPT=1; shift ;;
      --no-restart) NO_RESTART=1; shift ;;
      --yes|-y) ASSUME_YES=1; shift ;;
      *) die "pack: unknown option: $1" ;;
    esac
  done
  need_cmd docker
  [ -f "$COMPOSE_FILE" ] || die "compose file not found at $COMPOSE_FILE (run this from a Tugra checkout)"
  [ -f "$ENV_FILE" ] || die ".env not found at $ENV_FILE — nothing to pack"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
  [ "$ENCRYPT" = "1" ] && need_cmd openssl
  docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1 || die "helper image $HELPER_IMAGE not present — start Tugra once (so the image is pulled) before packing"

  VOL_PG="$(resolve_vol "$VOL_PG_KEY")"
  vol_exists "$VOL_PG" || die "the hub Postgres volume ($VOL_PG) does not exist — is Tugra installed here?"
  VOL_AGENT="$(resolve_vol "$VOL_AGENT_KEY")"
  VOL_REDIS="$(resolve_vol "$VOL_REDIS_KEY")"

  DATE="$(date +%Y-%m-%d-%H%M%S)"
  [ -n "$OUT" ] || OUT="$PWD/tugra-hub-$DATE.tar"
  [ "$ENCRYPT" = "1" ] && case "$OUT" in *.enc) : ;; *) OUT="$OUT.enc" ;; esac
  [ -d "$OUT" ] && die "--out is a directory: $OUT"
  [ -e "$OUT" ] && die "refusing to overwrite existing file: $OUT"
  OUT_DIR="$(cd "$(dirname "$OUT")" && pwd)" || die "output directory does not exist"
  OUT="$OUT_DIR/$(basename "$OUT")"

  # Warn when the hub's own "This machine" server hosts apps — those containers/volumes are NOT in this bundle.
  LOCAL_APPS=0
  LOCAL_APPS="$(compose exec -T postgres psql -U tugra -d tugra -tAc \
    'select count(*) from "Application" a join "Server" s on s.id = a."serverId" where s."isLocal" = true' 2>/dev/null | tr -d '[:space:]' || true)"
  case "$LOCAL_APPS" in ''|*[!0-9]*) LOCAL_APPS=0 ;; esac

  warn "This bundle will contain ALL hub secrets (encryption key, DB password, signing key). Keep it safe."
  note "Packing briefly stops the hub for a consistent copy (workloads on your servers keep running; agents reconnect)."
  if [ "$LOCAL_APPS" -gt 0 ]; then
    warn "$LOCAL_APPS app(s) run on this hub's own 'This machine' server. Their CONTAINERS and VOLUME DATA are NOT in this bundle —"
    warn "move them separately (Tugra's per-app/volume backups) or redeploy them on the new host after cutover."
  fi
  if [ "$NO_RESTART" = "1" ]; then _after="leave it stopped (for a move)"; else _after="restart it"; fi
  confirm "Stop the stack, pack the hub state, then $_after?" || die "aborted"

  STAGE="$(TMPDIR="${TUGRA_TMPDIR:-$OUT_DIR}" mktemp -d 2>/dev/null || mktemp -d)"; chmod 700 "$STAGE"
  BDIR="$STAGE/bundle"; mkdir -p "$BDIR"
  STOPPED=0
  cleanup_pack() {
    _rc=$?
    if [ "$STOPPED" = "1" ] && [ "$NO_RESTART" != "1" ]; then
      compose --profile updater up -d >/dev/null 2>&1 || compose up -d >/dev/null 2>&1 \
        || err "COULD NOT RESTART the source hub — run: docker compose --env-file .env -f deploy/docker-compose.yml --profile updater up -d"
    fi
    rm -rf "$STAGE" 2>/dev/null || true
    [ "$_rc" = 0 ] || err "pack did not complete (exit $_rc)."
    exit $_rc
  }
  trap cleanup_pack EXIT

  # Config first (no stop needed): the .env (secrets) and any host-side app configs under /etc/tugra.
  (umask 077; cp "$ENV_FILE" "$BDIR/env")
  if [ -d "$ETC_TUGRA" ]; then (umask 077; docker run --rm -v "$ETC_TUGRA":/s:ro -v "$BDIR":/out "$HELPER_IMAGE" \
      sh -c 'set -e; cd /s; tar cf /out/etc-tugra.tar .; gzip -f /out/etc-tugra.tar') || warn "could not pack /etc/tugra"; fi

  log "Stopping the stack for a consistent copy…"
  compose --profile updater stop -t 120 >/dev/null 2>&1 || true
  STOPPED=1
  vol_in_use_running "$VOL_PG" && die "Postgres is still running on $VOL_PG after stop — refusing to pack a live data dir"

  log "Packing the Postgres volume ($VOL_PG)…"; (umask 077; tar_volume_out "$VOL_PG" "$BDIR" "pg"); ok "Postgres packed."
  if vol_exists "$VOL_AGENT"; then
    log "Packing the local-agent identity ($VOL_AGENT)…"; (umask 077; tar_volume_out "$VOL_AGENT" "$BDIR" "agent-data"); ok "Agent identity packed."
  elif [ "$LOCAL_APPS" -gt 0 ]; then
    warn "no local-agent identity volume ($VOL_AGENT) found — 'This machine' may not reconnect on the new host without re-enrollment."
  fi
  if [ "$INCLUDE_REDIS" = "1" ] && vol_exists "$VOL_REDIS"; then
    log "Packing Redis ($VOL_REDIS)…"; (umask 077; tar_volume_out "$VOL_REDIS" "$BDIR" "redis"); ok "Redis packed."
  fi

  if [ "$NO_RESTART" != "1" ]; then
    log "Restarting the source stack…"
    if compose --profile updater up -d >/dev/null 2>&1 || compose up -d >/dev/null 2>&1; then STOPPED=0; ok "Source hub restarted."
    else warn "could not restart the source hub automatically — it will be retried on exit."; fi
  fi

  # Integrity: gzip -t each part + the Postgres part must contain PG_VERSION; record per-part sha256.
  for f in "$BDIR"/*.tar.gz; do gzip -t "$f" 2>/dev/null || die "a packed archive is corrupt: $(basename "$f")"; done
  pg_archive_ok "$BDIR/pg.tar.gz" || die "the Postgres archive has no PG_VERSION — the copy is incomplete"

  {
    printf 'bundle_version=1\n'; printf 'created=%s\n' "$DATE"
    printf 'from_host=%s\n' "$(hostname 2>/dev/null || echo unknown)"
    printf 'project=%s\n' "$PROJECT"; printf 'arch=%s\n' "$(arch)"
    printf 'pg_major=%s\n' "$(pg_major)"; printf 'helper_image=%s\n' "$HELPER_IMAGE"
    printf 'hub_public_url=%s\n' "$(env_get HUB_PUBLIC_URL)"
    printf 'include_redis=%s\n' "$INCLUDE_REDIS"; printf 'local_apps=%s\n' "$LOCAL_APPS"
    for f in "$BDIR"/*.tar.gz; do printf 'sha256_%s=%s\n' "$(basename "$f")" "$(sha256_of "$f")"; done
  } > "$BDIR/manifest"

  log "Writing the bundle…"
  if [ "$ENCRYPT" = "1" ]; then
    (umask 077; set -C; : > "$OUT"); tar cf - -C "$BDIR" . | openssl enc -aes-256-cbc -salt -pbkdf2 -out "$OUT" || die "write/encrypt failed"
  else
    (umask 077; set -C; : > "$OUT"); tar cf - -C "$BDIR" . > "$OUT" || die "write failed"
  fi
  chmod 600 "$OUT" 2>/dev/null || true

  printf '\n'; ok "Hub bundle written: $OUT"
  note "sha256: $(sha256_of "$OUT")"; note "Size:   $(du -h "$OUT" 2>/dev/null | cut -f1 || echo '?')"
  [ "$NO_RESTART" = "1" ] && warn "The source hub is STOPPED (--no-restart). Bring it back with: docker compose --env-file .env -f deploy/docker-compose.yml --profile updater up -d"
  printf '\n'; log "Next: copy this bundle to the NEW host, then on an installed Tugra checkout run:"
  printf '      scripts/hub-migrate.sh unpack %s\n\n' "$(basename "$OUT")"
  warn "This file holds every hub secret — transfer it over a secure channel and delete it afterwards."
}

# --------------------------------------------------------------------------------------------------- unpack
cmd_unpack() {
  BUNDLE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes|-y) ASSUME_YES=1; shift ;;
      -*) die "unpack: unknown option: $1" ;;
      *) [ -z "$BUNDLE" ] && BUNDLE="$1" || die "unpack: unexpected argument: $1"; shift ;;
    esac
  done
  [ -n "$BUNDLE" ] || die "usage: hub-migrate.sh unpack <bundle>"
  [ -f "$BUNDLE" ] || die "bundle not found: $BUNDLE"
  BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd)/$(basename "$BUNDLE")"
  need_cmd docker
  [ -f "$COMPOSE_FILE" ] || die "compose file not found at $COMPOSE_FILE — install Tugra on this host first (scripts/install.sh), then unpack"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"

  STAGE="$(TMPDIR="${TUGRA_TMPDIR:-$(dirname "$BUNDLE")}" mktemp -d 2>/dev/null || mktemp -d)"; chmod 700 "$STAGE"
  trap 'rm -rf "$STAGE" 2>/dev/null || true' EXIT
  BDIR="$STAGE/bundle"; mkdir -p "$BDIR"

  # ---- PREFLIGHT: validate EVERYTHING before any destructive action (no down/overwrite/wipe yet) ----
  case "$BUNDLE" in *.enc) need_cmd openssl; log "Decrypting bundle…"; openssl enc -d -aes-256-cbc -pbkdf2 -in "$BUNDLE" | tar xf - -C "$BDIR" || die "decryption failed (wrong passphrase?) or bundle corrupt" ;;
                     *) log "Extracting bundle…"; tar xf "$BUNDLE" -C "$BDIR" 2>/dev/null || die "could not extract the bundle (corrupt, or encrypted without .enc)" ;;
  esac
  [ -f "$BDIR/manifest" ] || die "not a Tugra hub bundle (no manifest)"
  [ -f "$BDIR/env" ] || die "bundle has no .env — cannot restore"
  [ -f "$BDIR/pg.tar.gz" ] || die "bundle has no Postgres data — cannot restore"

  B_ARCH="$(grep '^arch=' "$BDIR/manifest" | cut -d= -f2- || true)"
  B_PGMAJOR="$(grep '^pg_major=' "$BDIR/manifest" | cut -d= -f2- || true)"
  B_URL="$(grep '^hub_public_url=' "$BDIR/manifest" | cut -d= -f2- || true)"
  B_LOCAL_APPS="$(grep '^local_apps=' "$BDIR/manifest" | cut -d= -f2- || true)"

  # HARD portability gates: a raw Postgres data dir is NOT portable across CPU arch or PG major version.
  [ -n "$B_ARCH" ] || die "manifest incomplete (no arch) — refusing to restore"
  [ "$B_ARCH" = "$(arch)" ] || { err "architecture mismatch: bundle '$B_ARCH' vs this host '$(arch)'."; die "A raw Postgres data dir cannot move between architectures — use the pg_dump path (docs/disaster-recovery.md)."; }
  THIS_PGMAJOR="$(pg_major)"
  if [ -n "$B_PGMAJOR" ] && [ -n "$THIS_PGMAJOR" ] && [ "$B_PGMAJOR" != "$THIS_PGMAJOR" ]; then
    die "Postgres major mismatch: bundle is PG $B_PGMAJOR, this checkout runs PG $THIS_PGMAJOR. Match versions or use the pg_dump path."
  fi
  # Integrity: gzip -t every part + per-part sha256 vs the manifest.
  for f in "$BDIR"/*.tar.gz; do
    gzip -t "$f" 2>/dev/null || die "a bundle archive is corrupt: $(basename "$f")"
    _want="$(grep "^sha256_$(basename "$f")=" "$BDIR/manifest" | cut -d= -f2- || true)"
    if [ -n "$_want" ]; then [ "$_want" = "$(sha256_of "$f")" ] || die "checksum mismatch for $(basename "$f") — bundle is damaged"; fi
  done
  pg_archive_ok "$BDIR/pg.tar.gz" || die "the Postgres archive has no PG_VERSION — bundle incomplete"
  # Helper image must be available BEFORE we touch anything (pull if the compose images aren't here yet).
  docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1 || compose pull postgres >/dev/null 2>&1 || true
  docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1 || die "helper image $HELPER_IMAGE unavailable (pull failed) — run 'docker compose ... pull' first"

  printf '\n'
  warn "This will OVERWRITE this host's .env and the hub Postgres volume with the bundle's state."
  [ -n "$B_URL" ] && note "Bundle hub URL: $B_URL  (keep the same DNS and agents reconnect on their own)"
  case "${B_LOCAL_APPS:-0}" in ''|0) : ;; *) note "The source had $B_LOCAL_APPS app(s) on its own 'This machine' server — those containers/volumes are NOT in this bundle; move or redeploy them separately." ;; esac
  confirm "Restore the hub onto this host now?" || die "aborted"

  VOL_PG="$(resolve_vol "$VOL_PG_KEY")"; VOL_AGENT="$(resolve_vol "$VOL_AGENT_KEY")"; VOL_REDIS="$(resolve_vol "$VOL_REDIS_KEY")"

  # ---- DESTRUCTIVE from here: everything above has passed. ----
  log "Stopping any running stack…"
  compose --profile updater down >/dev/null 2>&1 || compose down >/dev/null 2>&1 || true
  for v in "$VOL_PG" "$VOL_AGENT" "$VOL_REDIS"; do vol_in_use "$v" && die "a container still uses $v — stop it first"; done

  # Back up the existing .env (if any) BEFORE overwriting, so a wrong bundle is recoverable.
  if [ -f "$ENV_FILE" ]; then _bak="$ENV_FILE.pre-restore.$(date +%s)"; (umask 077; cp -p "$ENV_FILE" "$_bak"); note "Saved the previous .env to $_bak"; fi
  log "Restoring configuration (.env)…"; (umask 077; cp "$BDIR/env" "$ENV_FILE"); chmod 600 "$ENV_FILE"
  if [ -f "$BDIR/etc-tugra.tar.gz" ]; then
    mkdir -p "$ETC_TUGRA" 2>/dev/null && docker run --rm -v "$ETC_TUGRA":/d -v "$BDIR":/in "$HELPER_IMAGE" \
      sh -c 'set -e; cd /d; gunzip -c /in/etc-tugra.tar.gz | tar xf -' || warn "could not restore /etc/tugra (not fatal)"
  fi

  _mklabels="--label com.docker.compose.project=$PROJECT"
  docker volume create $_mklabels --label "com.docker.compose.volume=$VOL_PG_KEY" "$VOL_PG" >/dev/null
  log "Restoring the Postgres volume ($VOL_PG)…"; tar_volume_in "$VOL_PG" "$BDIR" "pg" "./PG_VERSION"; ok "Postgres restored."
  if [ -f "$BDIR/agent-data.tar.gz" ]; then
    docker volume create $_mklabels --label "com.docker.compose.volume=$VOL_AGENT_KEY" "$VOL_AGENT" >/dev/null
    log "Restoring the local-agent identity…"; tar_volume_in "$VOL_AGENT" "$BDIR" "agent-data"; ok "Agent identity restored."
  else
    case "${B_LOCAL_APPS:-0}" in ''|0) : ;; *) warn "bundle has no local-agent identity — 'This machine' will not reconnect until you re-enroll it (Settings → Servers)." ;; esac
  fi
  if [ -f "$BDIR/redis.tar.gz" ]; then
    docker volume create $_mklabels --label "com.docker.compose.volume=$VOL_REDIS_KEY" "$VOL_REDIS" >/dev/null
    log "Restoring Redis…"; tar_volume_in "$VOL_REDIS" "$BDIR" "redis"; ok "Redis restored."
  fi

  # Boot Postgres alone and PROVE the .env<->data pairing over TCP (the unix socket is trust-auth, so it would
  # pass for any password): a password-authenticated query + a row in _prisma_migrations (empty DB has none).
  log "Starting Postgres and verifying the restore…"
  compose up -d postgres >/dev/null 2>&1 || die "could not start Postgres"
  i=0; until compose exec -T postgres pg_isready -U tugra >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -ge 60 ] && die "Postgres did not become ready — check: docker compose ... logs postgres"; sleep 2
  done
  _pw="$(env_get POSTGRES_PASSWORD)"
  _mig="$(compose exec -T -e PGPASSWORD="$_pw" postgres psql -h postgres -U tugra -d tugra -tAc 'select count(*) from _prisma_migrations' 2>/dev/null | tr -d '[:space:]' || true)"
  case "$_mig" in
    ''|*[!0-9]*) die "restore verification failed — the restored .env credentials do not match the data, or the DB is empty (the bundle's .env must be intact)" ;;
    0) die "restore verification failed — the Postgres volume is empty (no migrations). The bundle's data did not restore." ;;
    *) ok "Restore verified ($_mig migrations present, credentials match)." ;;
  esac

  log "Starting the full stack…"
  compose --profile updater up -d >/dev/null 2>&1 || compose up -d >/dev/null 2>&1 || die "could not start the stack"

  HUB_PORT="$(env_get HUB_PORT)"; HUB_PORT="${HUB_PORT:-3000}"; HEALTHY=2
  if command -v curl >/dev/null 2>&1; then
    log "Waiting for the hub to become healthy…"; HEALTHY=1; i=0
    until curl -fsS "http://localhost:${HUB_PORT}/health" >/dev/null 2>&1; do
      i=$((i + 1)); [ "$i" -ge 120 ] && { HEALTHY=0; warn "hub not healthy after ~4 min — check: docker compose ... logs hub-api"; break; }; sleep 2
    done
  fi

  printf '\n'
  if [ "$HEALTHY" = "0" ]; then warn "Stack is up but the hub did not pass its health check yet."
  elif [ "$HEALTHY" = "2" ]; then ok "Stack started (health not checked — curl missing)."
  else ok "Hub is up and running with the restored state."; fi
  printf '\n'; log "Cutover checklist:"
  note "Point your hub's DNS / HUB_PUBLIC_URL at THIS host. Same hostname → agents reconnect automatically within ~30s."
  note "Different hostname/IP: re-run 'scripts/install.sh --domain <new-host>' here (idempotent; keeps secrets, rewrites URLs), then re-run the agent install one-liner on each server and update your GitHub App webhook/callback URL."
  [ "$(env_get PANEL_TLS)" = "1" ] && note "Panel HTTPS (PANEL_TLS=1) is NOT re-provisioned automatically — re-run 'scripts/install.sh' with no args here to bring up the TLS proxy."
  note "Apps + data on OTHER servers are untouched. Apps on the source's 'This machine' server are NOT carried — redeploy them or restore their volumes here."
  [ "$HEALTHY" = "0" ] && exit 1 || exit 0
}

# --------------------------------------------------------------------------------------------------- dispatch
usage() { sed -n '2,25p' "$SCRIPT_PATH" | sed 's/^#\{0,1\} \{0,1\}//'; }
case "${1:-}" in
  pack)   shift; cmd_pack "$@" ;;
  unpack) shift; cmd_unpack "$@" ;;
  -h|--help|help|"") usage ;;
  *) err "unknown command: $1"; usage; exit 1 ;;
esac
