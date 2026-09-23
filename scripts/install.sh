#!/usr/bin/env bash
#
# Tugra hub installer. Generates a repo-root .env with fresh secrets, then brings up the production
# stack (deploy/docker-compose.yml). Idempotent: re-running preserves existing secrets and only
# refreshes URLs, so it doubles as the upgrade path (`git pull && ./scripts/install.sh`).
#
#   ./scripts/install.sh                       # quick start (http, this host's IP)
#   ./scripts/install.sh --domain tugra.example.com   # behind your TLS reverse proxy (https)
#
# Flags:
#   --domain <host>     Serve over https://<host> (behind a reverse proxy that terminates TLS and
#                       path-routes / -> web and /api,/agent,/terminal,/install -> hub). Sets
#                       COOKIE_SECURE=true + HUB_TRUSTED_PROXY=true.
#   --hub-url <url>     Explicit public hub URL (agents dial <url>/agent). Overrides --domain.
#   --web-url <url>     Explicit public web URL (the browser origin).
#   --build             Force build-from-source (skip pulling published images).
#   --pull              Force pulling published images (no source fallback).
#   --env-file <path>   Write the env file here (default: <repo>/.env). Used by tests.
#   --dry-run           Generate the .env and exit — do not touch Docker.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_DIR/deploy/docker-compose.yml"

ENV_FILE="$REPO_DIR/.env"
DOMAIN=""
HUB_URL=""
WEB_URL=""
FORCE_BUILD=0
FORCE_PULL=0
DRY_RUN=0
HUB_PORT="${HUB_PORT:-3000}"
WEB_PORT="${WEB_PORT:-3001}"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)   DOMAIN="${2:-}"; shift 2 ;;
    --hub-url)  HUB_URL="${2:-}"; shift 2 ;;
    --web-url)  WEB_URL="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --build)    FORCE_BUILD=1; shift ;;
    --pull)     FORCE_PULL=1; shift ;;
    --dry-run|--no-start) DRY_RUN=1; shift ;;
    -h|--help)  sed -n '2,19p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown option: $1"; exit 1 ;;
  esac
done

# --- secret generators (openssl, falling back to /dev/urandom) --------------------------------------
rand_b64() { openssl rand -base64 "$1" 2>/dev/null || { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }; }
rand_hex() { openssl rand -hex "$1" 2>/dev/null || { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }; }

# --- idempotent .env helpers (grep-based; never `source` a file with secrets) -----------------------
env_has() { [ -f "$ENV_FILE" ] && grep -q "^$1=" "$ENV_FILE"; }
env_get() { grep "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-; }
# Generate-once: keep an existing value on re-run (regenerating would invalidate sessions / orphan
# encrypted data / change the signing identity / break the already-initialised Postgres volume).
ensure_env() { env_has "$1" || printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; }
# Upsert: refresh derived/URL values every run (so a re-run with a new --domain updates them).
set_env() {
  if env_has "$1"; then
    local tmp; tmp="$(mktemp)"; grep -v "^$1=" "$ENV_FILE" > "$tmp"; cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  fi
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
}

# --- preflight (skipped for --dry-run so tests need no Docker) ---------------------------------------
if [ "$DRY_RUN" -eq 0 ]; then
  command -v docker >/dev/null 2>&1 || { err "Docker is required. Install it: https://get.docker.com"; exit 1; }
  docker compose version >/dev/null 2>&1 || { err "The Docker Compose v2 plugin is required (docker compose)."; exit 1; }
fi

# --- resolve the public URLs + cookie/proxy mode ----------------------------------------------------
COOKIE_SECURE="false"
HUB_TRUSTED_PROXY="false"   # default: no proxy → trust the raw TCP peer IP (agents can't spoof it)
if [ -n "$DOMAIN" ]; then
  # Single public origin behind the user's TLS reverse proxy (see README for the path-routing rules).
  HUB_URL="${HUB_URL:-https://$DOMAIN}"
  WEB_URL="${WEB_URL:-https://$DOMAIN}"
  COOKIE_SECURE="true"
  HUB_TRUSTED_PROXY="true"
elif [ -z "$HUB_URL" ] || [ -z "$WEB_URL" ]; then
  # Quick start: plain http on this host's first IP (agents must be able to reach the hub port).
  # Detect the IP PORTABLY — `hostname -I` is GNU/net-tools-only and ERRORS on macOS/BSD and on
  # busybox/Alpine; guard every step (`{ … || true; }`) so `set -euo pipefail` can't kill the script
  # silently when it's unavailable. Fall back to the default-route source IP, then to localhost.
  HOST_IP="$( { hostname -I 2>/dev/null || true; } | awk '{print $1; exit}' )"
  if [ -z "$HOST_IP" ]; then
    HOST_IP="$( { ip route get 1.1.1.1 2>/dev/null || true; } | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' )"
  fi
  if [ -z "$HOST_IP" ]; then
    HOST_IP="localhost"
    warn "Could not auto-detect this host's IP; using 'localhost'. If agents run on other machines, re-run with --hub-url http://<host-ip>:$HUB_PORT --web-url http://<host-ip>:$WEB_PORT"
  fi
  HUB_URL="${HUB_URL:-http://$HOST_IP:$HUB_PORT}"
  WEB_URL="${WEB_URL:-http://$HOST_IP:$WEB_PORT}"
  COOKIE_SECURE="false"   # http cannot carry Secure cookies; NODE_ENV=production would default it on
fi

# --- write the .env (create with 0600, preserve secrets on re-run) ----------------------------------
[ -f "$ENV_FILE" ] || (umask 077; : > "$ENV_FILE")

ensure_env JWT_ACCESS_SECRET     "$(rand_b64 24)"
ensure_env JWT_REFRESH_SECRET    "$(rand_b64 24)"
ensure_env SECRETS_ENCRYPTION_KEY "$(rand_b64 24)"
ensure_env HUB_SIGNING_KEY       "$(rand_b64 32)"   # decodes to exactly 32 bytes (ed25519 seed)
ensure_env POSTGRES_PASSWORD     "$(rand_hex 24)"   # url-safe (no @ : / ? in a hex string)

PG_PWD="$(env_get POSTGRES_PASSWORD)"
set_env NODE_ENV       "production"
set_env DATABASE_URL   "postgresql://tugra:${PG_PWD}@postgres:5432/tugra?schema=public"
set_env REDIS_URL      "redis://redis:6379"          # unauthenticated: BullMQ workers only use host/port
set_env HUB_PORT       "$HUB_PORT"
set_env WEB_PORT       "$WEB_PORT"
set_env HUB_PUBLIC_URL "$HUB_URL"
set_env WEB_PUBLIC_URL "$WEB_URL"
set_env COOKIE_SECURE  "$COOKIE_SECURE"
# Always upsert (not just in --domain mode): switching back from --domain to the http quick-start must
# CLEAR a stale HUB_TRUSTED_PROXY=true, else the hub would keep trusting spoofable X-Forwarded-For.
set_env HUB_TRUSTED_PROXY "$HUB_TRUSTED_PROXY"

chmod 600 "$ENV_FILE"
log "Wrote configuration to $ENV_FILE"

if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry run — skipping Docker. Review $ENV_FILE and run without --dry-run to start."
  exit 0
fi

# --- bring up the stack (pull published images, else build from this checkout) ----------------------
# Include the `updater` profile so the self-update sidecar is always running (it drains the update queue
# for both "Update now" and auto-update; it's a fixed-command docker.sock sidecar — see SECURITY.md).
compose() { docker compose --profile updater --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }
if [ "$FORCE_BUILD" -eq 1 ]; then
  log "Building images from source…"; compose up -d --build
elif [ "$FORCE_PULL" -eq 1 ]; then
  compose pull; compose up -d --no-build
elif compose pull >/dev/null 2>&1; then
  log "Using published images."; compose up -d --no-build
elif [ -f "$REPO_DIR/deploy/Dockerfile.hub" ]; then
  log "Published images not available yet — building from source (this checkout)…"
  compose up -d --build
else
  err "Could not pull published images, and no source is available to build from."
  err "Clone the repository and run scripts/install.sh from it, or wait for a published release."
  exit 1
fi

# --- wait for health + print next steps -------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  log "Waiting for the hub to become healthy…"
  i=0
  until curl -fsS "http://localhost:${HUB_PORT}/health" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -ge 60 ] && { warn "hub not healthy yet — check: docker compose -f deploy/docker-compose.yml logs hub-api"; break; }
    sleep 5
  done
fi

log "Tugra is up."
printf '  Web UI:  %s\n' "$WEB_URL"
printf '  Hub API: %s\n' "$HUB_URL"
if [ -z "$DOMAIN" ]; then
  printf '  For TLS + a public domain, front the stack with a reverse proxy and re-run with --domain <host>.\n'
fi
printf '  Create the first (owner) account in the web UI, then add your first server.\n'
