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
# Trust-wedge: a fresh install makes ZERO outbound calls of its own — update checks and public-IP
# detection are explicit opt-in (default off). env-var forms let the one-line curl|sh installer opt in too.
ENABLE_UPDATE_CHECKS="${TUGRA_ENABLE_UPDATE_CHECKS:-0}"
DETECT_PUBLIC_IP="${TUGRA_DETECT_PUBLIC_IP:-0}"
MANUAL_PUBLIC_IP="${TUGRA_PUBLIC_IP:-}"
HUB_PORT="${HUB_PORT:-3000}"
WEB_PORT="${WEB_PORT:-3001}"

log()  { printf '\033[38;5;179m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
note() { printf '  \033[33m!\033[0m %s\n' "$*"; }

# Step progress (best-level installer UX).
TOTAL_STEPS=4; STEP=0
step() { STEP=$((STEP + 1)); printf '\n\033[38;5;179m==> [%d/%d]\033[0m \033[1m%s\033[0m\n' "$STEP" "$TOTAL_STEPS" "$*"; }

# Install a package via the host package manager when a command is missing (best-effort, turnkey).
PKG_UPDATED=0
ensure_pkg() {
  _cmd="$1"; _pkg="${2:-$1}"
  command -v "$_cmd" >/dev/null 2>&1 && return 0
  if   command -v apt-get >/dev/null 2>&1; then [ "$PKG_UPDATED" = 1 ] || { apt-get update -y >/dev/null 2>&1 || true; PKG_UPDATED=1; }; apt-get install -y "$_pkg" >/dev/null 2>&1 || true
  elif command -v dnf     >/dev/null 2>&1; then dnf install -y "$_pkg" >/dev/null 2>&1 || true
  elif command -v yum     >/dev/null 2>&1; then yum install -y "$_pkg" >/dev/null 2>&1 || true
  elif command -v apk     >/dev/null 2>&1; then apk add --no-cache "$_pkg" >/dev/null 2>&1 || true
  elif command -v pacman  >/dev/null 2>&1; then pacman -Sy --noconfirm "$_pkg" >/dev/null 2>&1 || true
  elif command -v zypper  >/dev/null 2>&1; then zypper -n install "$_pkg" >/dev/null 2>&1 || true
  fi
  command -v "$_cmd" >/dev/null 2>&1
}

banner() {
  printf '\033[38;5;179m'
  cat <<'EOF'

$$$$$$$$\                                         $$\
\__$$  __|                                        \__|
   $$ |$$\   $$\  $$$$$$\   $$$$$$\  $$$$$$\      $$\  $$$$$$\
   $$ |$$ |  $$ |$$  __$$\ $$  __$$\ \____$$\     $$ |$$  __$$\
   $$ |$$ |  $$ |$$ /  $$ |$$ |  \__|$$$$$$$ |    $$ |$$ /  $$ |
   $$ |$$ |  $$ |$$ |  $$ |$$ |     $$  __$$ |    $$ |$$ |  $$ |
   $$ |\$$$$$$  |\$$$$$$$ |$$ |     \$$$$$$$ |$$\ $$ |\$$$$$$  |
   \__| \______/  \____$$ |\__|      \_______|\__|\__| \______/
                 $$\   $$ |
                 \$$$$$$  |
                  \______/
EOF
  printf '\033[0m  \033[2mOpen-core PaaS for fleets and AI agents · tugra.io\033[0m\n\n'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)   DOMAIN="${2:-}"; shift 2 ;;
    --hub-url)  HUB_URL="${2:-}"; shift 2 ;;
    --web-url)  WEB_URL="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --build)    FORCE_BUILD=1; shift ;;
    --pull)     FORCE_PULL=1; shift ;;
    --enable-update-checks) ENABLE_UPDATE_CHECKS=1; shift ;;
    --detect-public-ip)     DETECT_PUBLIC_IP=1; shift ;;
    --public-ip) MANUAL_PUBLIC_IP="${2:-}"; shift 2 ;;
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

# --- preflight (skipped for --dry-run so tests stay quiet + need no Docker) --------------------------
preflight() {
  step "Checking requirements & installing prerequisites…"
  fail=0
  ensure_pkg curl curl >/dev/null 2>&1 || true   # needed for the Docker install + the health check below
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo present) (daemon running)"
    else
      bad "Docker is installed but its daemon isn't reachable (is it running? are you root or in the docker group?)"; fail=1
    fi
  elif [ "${TUGRA_SKIP_DOCKER_INSTALL:-0}" = "1" ]; then
    bad "Docker not found — install it: https://get.docker.com (auto-install skipped via TUGRA_SKIP_DOCKER_INSTALL)"; fail=1
  else
    note "Docker not found — installing it now via get.docker.com (set TUGRA_SKIP_DOCKER_INSTALL=1 to skip)…"
    if command -v curl >/dev/null 2>&1 && curl -fsSL https://get.docker.com | sh >/tmp/tugra-docker-install.log 2>&1 && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      ok "Docker installed ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo present))"
    else
      bad "Automatic Docker install failed — install it manually: https://get.docker.com (log: /tmp/tugra-docker-install.log)"; fail=1
    fi
  fi
  if docker compose version >/dev/null 2>&1; then ok "Docker Compose v2 plugin"; else bad "Docker Compose v2 plugin is required (docker compose)"; fail=1; fi
  ensure_pkg git git && ok "git" || note "git not found and could not be installed (needed only for Git-source deploys)"
  command -v curl >/dev/null 2>&1 && ok "curl" || note "curl not found (used for the post-install health check)"
  arch="$(uname -m 2>/dev/null || echo '?')"
  case "$arch" in x86_64|amd64|aarch64|arm64) ok "Architecture: $arch" ;; *) note "Unusual architecture: $arch (published images target amd64/arm64)" ;; esac
  if [ -r /proc/meminfo ]; then
    memkb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || true)"
    if [ -n "${memkb:-}" ]; then
      # Round to the NEAREST GiB (not truncate): a "4GB" box reports ~3.8 GiB in MemTotal because
      # the kernel/firmware reserve some, and truncating would print a misleading "~3GB".
      memgb=$(( (memkb + 524288) / 1048576 ))
      if [ "$memkb" -lt 1800000 ]; then note "RAM: ~${memgb}GB — 4GB+ recommended (hub + web + db + redis + agent)"; else ok "RAM: ~${memgb}GB"; fi
    fi
  fi
  # MiB -> nearest GiB (df -Pm reports MiB; round, do not truncate)
  freeg="$( { df -Pm . 2>/dev/null || true; } | awk 'NR==2{print int(($4+512)/1024)}' )"
  if [ -n "${freeg:-}" ]; then
    if [ "$freeg" -lt 5 ]; then note "Free disk: ~${freeg}GB — 10GB+ recommended (images + volumes)"; else ok "Free disk: ~${freeg}GB"; fi
  fi
  if command -v ss >/dev/null 2>&1; then
    for p in "${HUB_PORT:-3000}" "${WEB_PORT:-3001}"; do
      ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$" && note "Port ${p} looks busy — the stack may fail to bind it (set HUB_PORT/WEB_PORT or free it)"
    done
  fi
  [ "$fail" -eq 0 ] || { err "Preflight failed — fix the ✗ item(s) above and re-run."; exit 1; }
  printf '\n'
}
if [ "$DRY_RUN" -eq 0 ]; then
  banner
  preflight
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
[ "$DRY_RUN" -eq 1 ] || step "Writing configuration (.env with fresh secrets)…"
[ -f "$ENV_FILE" ] || (umask 077; : > "$ENV_FILE")

ensure_env JWT_ACCESS_SECRET     "$(rand_b64 24)"
ensure_env JWT_REFRESH_SECRET    "$(rand_b64 24)"
ensure_env SECRETS_ENCRYPTION_KEY "$(rand_b64 24)"
ensure_env HUB_SIGNING_KEY       "$(rand_b64 32)"   # decodes to exactly 32 bytes (ed25519 seed)
ensure_env POSTGRES_PASSWORD     "$(rand_hex 24)"   # url-safe (no @ : / ? in a hex string)
# Only a FRESH install (no SETUP_CODE yet) advertises the owner-claim code. A re-run of an already-set-up
# install must not print a misleading "enter this to claim owner" line (the gate is a no-op once claimed).
FRESH_SETUP_CODE=0; env_has SETUP_CODE || FRESH_SETUP_CODE=1
ensure_env SETUP_CODE            "$(rand_hex 4)"    # first-run owner-claim code (8 hex chars); printed below if fresh

# Single-box quick start: the hub auto-creates a "This machine" server when LOCAL_AGENT_ENROLL_TOKEN is set,
# and the bundled `agent` compose service connects with the same token. Generate-once so re-runs are stable.
ensure_env LOCAL_AGENT_ENROLL_TOKEN "$(rand_hex 24)"   # 48 hex chars
# Best-effort-detect the host's real public IP so the hub pins it on "This machine". Without it, the first
# agent report records the agent's in-container docker-bridge source IP (172.18.x) and every deployed app URL
# dead-links. Left unset if detection fails or isn't a bare IPv4; the hub then falls back to its IP hygiene.
# Public IP: OPT-IN only — no outbound by default (trust-wedge). `--public-ip <ipv4>` pins a given one;
# `--detect-public-ip` (or TUGRA_DETECT_PUBLIC_IP=1) re-enables the best-effort probe below. Otherwise we
# leave it unset: the hub falls back to its IP hygiene and the closing hint tells the operator how to set it.
if ! env_has LOCAL_SERVER_PUBLIC_IP; then
  case "$MANUAL_PUBLIC_IP" in
    "") : ;;
    *[!0-9.]*) err "invalid --public-ip (expected a bare IPv4): $MANUAL_PUBLIC_IP"; exit 1 ;;
    *) ensure_env LOCAL_SERVER_PUBLIC_IP "$MANUAL_PUBLIC_IP" ;; # hub re-validates with isPublicIp before pinning
  esac
  if ! env_has LOCAL_SERVER_PUBLIC_IP && [ "$DETECT_PUBLIC_IP" = "1" ]; then
    # `|| PUB_IP=""` is REQUIRED: under `set -euo pipefail` a fully-offline probe (all curls fail) makes the
    # substitution exit non-zero and would otherwise abort the whole installer. Best-effort means unset-on-failure.
    PUB_IP="$( { curl -fsS -m 5 https://api.ipify.org || curl -fsS -m 5 https://ifconfig.me || curl -fsS -m 5 https://icanhazip.com; } 2>/dev/null | tr -d '[:space:]' )" || PUB_IP=""
    case "$PUB_IP" in
      "" | *[!0-9.]*) : ;;                              # empty / not a bare IPv4 (IPv6 or an HTML error page) → skip
      *) ensure_env LOCAL_SERVER_PUBLIC_IP "$PUB_IP" ;;
    esac
  fi
fi
# Agent image ref (the agent re-invokes itself as the sandboxed file helper; hub uses AGENT_IMAGE for installs).
ensure_env TUGRA_AGENT_IMAGE "ghcr.io/simeraycom/tugra-agent:${TUGRA_VERSION:-latest}"
ensure_env AGENT_IMAGE       "ghcr.io/simeraycom/tugra-agent:${TUGRA_VERSION:-latest}"
# Signed self-update channel — OPT-IN (no phone-home by default). Enable with --enable-update-checks
# (or TUGRA_ENABLE_UPDATE_CHECKS=1): the hub then fetches ONE ed25519-signed manifest (no identifiers, no
# version, no payload). Left unset, the update scheduler + agent digest-pin stay inert (env.ts fail-closed)
# and you update by pulling images on your own schedule. only-if-unset so an operator override survives re-runs.
if [ "$ENABLE_UPDATE_CHECKS" = "1" ]; then
  ensure_env UPDATE_MANIFEST_URL  "https://simeraycom.github.io/tugra/versions.json"
  ensure_env UPDATE_PUBLISHER_KEY "MCowBQYDK2VwAyEA4+vvlIQS9SWHEKc0Fo1UD2ZW+DSl0AJA9hOK5NeiXBE="
fi

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
step "Fetching images & starting the stack (first run can take a few minutes)…"
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
  step "Waiting for the hub to become healthy…"
  i=0
  until curl -fsS "http://localhost:${HUB_PORT}/health" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -ge 120 ] && { printf '\r\033[K'; warn "hub not healthy yet — check: docker compose -f deploy/docker-compose.yml logs hub-api"; break; }
    case $((i % 4)) in 0) c='|' ;; 1) c='/' ;; 2) c='-' ;; 3) c='\' ;; esac
    printf '\r  \033[38;5;179m%s\033[0m still starting… (%ss)' "$c" "$((i * 2))"
    sleep 2
  done
  printf '\r\033[K'
fi

printf '\n'
log "Tugra is up."
printf '  Web UI:  %s\n' "$WEB_URL"
printf '  Hub API: %s\n' "$HUB_URL"
if [ -z "$DOMAIN" ]; then
  printf '  For TLS + a public domain, front the stack with a reverse proxy and re-run with --domain <host>.\n'
fi
printf '  Open the Web UI and create the owner account (enter the setup code if one is shown below). This machine connects itself as your first server; add more from Settings -> Servers.\n'
# Trust-wedge hints: both are opt-in, so say plainly what is OFF and how to turn it on.
if ! env_has LOCAL_SERVER_PUBLIC_IP; then
  printf '  \033[2mPublic IP not set (no outbound probe by default). Deployed app URLs on a bare IP may not resolve until you set it: re-run with --public-ip <ip>, or set LOCAL_SERVER_PUBLIC_IP in %s.\033[0m\n' "$ENV_FILE"
fi
if [ "$ENABLE_UPDATE_CHECKS" != "1" ] && ! env_has UPDATE_MANIFEST_URL; then
  printf '  \033[2mUpdate checks are OFF (nothing phones home). Enable signed update checks: re-run with --enable-update-checks (see docs/upgrade.md). Watch GitHub releases for security advisories.\033[0m\n'
fi
if [ "$FRESH_SETUP_CODE" -eq 1 ]; then
  _code="$(env_get SETUP_CODE)"
  printf '\n  \033[1;33m══════════════════════════════════════════════════\033[0m\n'
  printf '  \033[1;33m⚠  SAVE THIS — owner account setup code:\033[0m\n'
  printf '         \033[1;36m%s\033[0m\n' "$_code"
  printf '  \033[1;33m══════════════════════════════════════════════════\033[0m\n'
  printf '  You must enter it to create the owner account (step 1 in the Web UI).\n'
  printf '  Closed the terminal? Recover it anytime with:  grep SETUP_CODE %s\n\n' "$ENV_FILE"
fi
