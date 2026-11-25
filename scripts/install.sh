#!/usr/bin/env bash
#
# Tugra hub installer. Generates a repo-root .env with fresh secrets, then brings up the production
# stack (deploy/docker-compose.yml). Idempotent: re-running preserves existing secrets and only
# refreshes URLs, so it doubles as the upgrade path (`git pull && ./scripts/install.sh`).
#
#   ./scripts/install.sh                       # quick start: the panel on http://<this host's IP>/ (port 80, Tugra's own proxy)
#   ./scripts/install.sh --domain tugra.example.com   # the panel on https://tugra.example.com (Let's Encrypt, automatic)
#   TUGRA_VERSION=0.1.0-beta.1 ./scripts/install.sh    # pin a specific release (e.g. a beta); persisted to .env
#
# Flags:
#   --domain <host>     Serve over https://<host>. Tugra provisions the panel's HTTPS itself (bundled Traefik +
#                       Let's Encrypt HTTP-01: no token, no email needed; it also works behind Cloudflare's orange
#                       cloud). Point <host>'s DNS at this server first. Sets COOKIE_SECURE=true + HUB_TRUSTED_PROXY=true.
#                       When :80/:443 are already taken by another web server it falls back to bring-your-own
#                       proxy (path-routes / -> web and /agent,/terminal,/install,/webhooks,/auth/* -> hub).
#                       Without --domain the panel is served on http://<this host's IP>/ (port 80) the same way;
#                       set the domain later in Settings -> Instance -> Panel domain.
#   --auto-tls          With --domain: provision the panel's HTTPS (the default; kept for scripts).
#   --no-auto-tls       With --domain: keep bring-your-own-proxy (no bundled TLS).
#   --acme-email <addr> OPTIONAL contact email for Let's Encrypt expiry notices (never required).
#   --raw-ports         Without --domain: the classic quick start. No proxy; the panel is published on the raw
#                       HUB_PORT/WEB_PORT (http://<ip>:3001) instead of port 80 (also: TUGRA_RAW_PORTS=1). Chosen
#                       automatically when port 80 is already taken. An existing install keeps its own setup.
#   --acme-dns-cloudflare <token>  OPTIONAL DNS-01 with a Cloudflare API token: a cert that never depends on :80
#                       reaching this server, with the record Cloudflare-proxied (IP hidden). Implies --domain's
#                       TLS. Not needed for a normal HTTP-01 setup. The token on the command line is visible in
#                       `ps` and shell history — prefer --acme-dns-cloudflare-file or TUGRA_ACME_DNS_TOKEN.
#   --acme-dns-cloudflare-file <path>  Same as above, reading the token from a file (first line).
#   --cloudflare-proxy  The panel's DNS record is Cloudflare-proxied (orange cloud): trust CF-Connecting-IP as the
#                       client IP, but ONLY when the hop the proxy observed is a published Cloudflare edge range
#                       (sets HUB_TRUSTED_PROXY_CLOUDFLARE=true; needs an https --domain). Opt-in, never implied by
#                       --acme-dns-cloudflare. Without it, behind Cloudflare every client shows as a Cloudflare edge
#                       address, so IP allowlists are meaningless. (also: TUGRA_CLOUDFLARE_PROXY=1)
#   --no-cloudflare-proxy  Turn that off again (a flag-less re-run keeps whatever is configured).
#   --keep-raw-ports    Do NOT move the published hub/web ports to 127.0.0.1 when the install turns https /
#                       bundled-TLS (also: TUGRA_KEEP_RAW_PORTS=1). Default: a 0.0.0.0 bind is rebound to
#                       loopback on that transition, since only the proxy needs to reach the raw ports.
#   --hub-url <url>     Explicit public hub URL (agents dial <url>/agent). Overrides --domain.
#   --web-url <url>     Explicit public web URL (the browser origin).
#   --build             Force build-from-source (skip pulling published images).
#   --pull              Force pulling published images (no source fallback).
#   --env-file <path>   Write the env file here (default: <repo>/.env). Used by tests.
#   --home              Start the owner account in the simple Home launcher (CasaOS-style) instead of the
#                       full Fleet control plane. Owner can still choose/switch in onboarding or Settings.
#   --no-telemetry      Opt OUT of the on-by-default anonymous usage stats (also: TUGRA_TELEMETRY=0).
#   --no-update-checks  Opt OUT of the signed self-update checks, on by default (also: TUGRA_UPDATE_CHECKS=0).
#   --enable-update-checks  Re-enable update checks after --no-update-checks (they are on by default; also: TUGRA_ENABLE_UPDATE_CHECKS=1).
#   --detect-public-ip  Best-effort auto-detect this host's public IP (off by default, for privacy).
#   --public-ip <ip>    Pin the host's public IP (so deployed-app magic URLs are reachable from outside).
#   --prune-images      After a healthy install/upgrade, remove Tugra's OWN release images older than the previous
#                       release (the running one and the one before it, for rollback, are kept; nothing that is not
#                       a Tugra release image is touched). Every release adds ~8 GB of images and nothing removed the
#                       old ones. Without the flag the installer only says how much could be freed. The in-app
#                       updater does this by itself after each update (turn off: TUGRA_PRUNE_IMAGES=0 in .env).
#   --no-swap           Do not add a swapfile. By default a host with 4GB RAM or less and no swap gets a 2GB /swapfile
#                       (fstab entry, vm.swappiness=10) so a load spike slows the hub instead of the kernel's OOM killer
#                       taking it down. The opt-out is remembered (TUGRA_NO_SWAP=1 in .env); --enable-swap undoes it.
#   --dry-run           Generate the .env and exit — do not touch Docker.
#   --sync-checkout     Only bring this git checkout in line with the compose file/scripts the in-app updater wrote
#                       (it leaves them "modified" and makes `git pull` refuse), then exit. The target is the release in
#                       TUGRA_VERSION (env or .env). A normal run with TUGRA_VERSION set does this step first by itself;
#                       TUGRA_CHECKOUT_SYNC=0 turns it off. Real local edits are never discarded.
#   --doctor            Check this host and the Tugra stack, read-only (it never changes anything): who holds ports
#                       80/443, the host firewall (ufw / firewalld / nftables / iptables), the hosting provider's cloud
#                       firewall, IPv6 / AAAA, DNS, the Tugra containers, the proxy routes, the panel's certificate and
#                       the local agent, each problem with its fix. Exit 0 = no problems, 1 = problems. Works on a fresh
#                       host and on an installed one:  curl -fsSL https://tugra.io/install | sh -s -- --doctor
#   --restore-from <f>  Restore a hub bundle made by `scripts/hub-migrate.sh pack` onto THIS host (moves an
#                       existing hub here, no pg_dump). Overwrites this host's .env + hub volume. See
#                       docs/disaster-recovery.md.
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
PRUNE_IMAGES="${TUGRA_PRUNE_IMAGES_NOW:-0}"
DRY_RUN=0
RESTORE_FROM=""
RESTORE_SET=0
SYNC_CHECKOUT_ONLY=0
ASSUME_YES=0
DOCTOR=0   # --doctor: read-only network + stack health check (lib/netcheck.sh), then exit
# Outbound policy: update checks and anonymous usage stats are ON by default (opt-out); public-IP detection is
# opt-in. env-var forms let the one-line curl|sh installer choose too.
ENABLE_UPDATE_CHECKS="${TUGRA_ENABLE_UPDATE_CHECKS:-0}" # re-enable after an earlier opt-out (checks are on by default)
NO_UPDATE_CHECKS="${TUGRA_NO_UPDATE_CHECKS:-0}"         # explicit opt-out of the default-on signed update checks
[ "${TUGRA_UPDATE_CHECKS:-}" = "0" ] && NO_UPDATE_CHECKS=1 # the same variable the hub reads
DETECT_PUBLIC_IP="${TUGRA_DETECT_PUBLIC_IP:-0}"
MANUAL_PUBLIC_IP="${TUGRA_PUBLIC_IP:-}"
ENABLE_TELEMETRY="${TUGRA_ENABLE_TELEMETRY:-0}" # explicit opt-in (skips the confirm prompt)
NO_TELEMETRY="${TUGRA_NO_TELEMETRY:-0}"         # explicit opt-out of the default-on anonymous usage stats
NO_SWAP="${TUGRA_NO_SWAP:-0}"                   # --no-swap: never add the safety-net swapfile on a small host (lib/swap.sh)
ENABLE_SWAP=0                                   # --enable-swap: forget an earlier --no-swap
RAW_PORTS="${TUGRA_RAW_PORTS:-0}"               # --raw-ports: classic quick start on 3000/3001, no proxy
HOME_MODE="${TUGRA_HOME_MODE:-0}"               # --home: start the owner in the simple Home launcher (CasaOS-style)
# Panel-TLS (DİLİM 1): opt-in auto-HTTPS for the control panel. AUTO_TLS "" = undecided, "1"/"0" explicit.
AUTO_TLS="${TUGRA_AUTO_TLS:-}"
ACME_EMAIL_ARG="${TUGRA_ACME_EMAIL:-}"
ACME_DNS_PROVIDER_ARG="${TUGRA_ACME_DNS_PROVIDER:-}"
ACME_DNS_TOKEN_ARG="${TUGRA_ACME_DNS_TOKEN:-}"
ACME_DNS_TOKEN_ARGV=0
TUGRA_SNAPSHOT_DRY=0   # lib/snapshot.sh dry switch: install.sh never dry-runs it (an inherited DRY must not skip the snapshot)
KEEP_RAW_PORTS="${TUGRA_KEEP_RAW_PORTS:-0}"
# Cloudflare orange-cloud client-IP mode: "" = undecided (keep what .env has), "1"/"0" explicit.
CF_PROXY="${TUGRA_CLOUDFLARE_PROXY:-}"
# HUB_PORT/WEB_PORT: env wins, else the value stored in .env (resolved after flag parsing), else 3000/3001.
HUB_PORT="${HUB_PORT:-}"
WEB_PORT="${WEB_PORT:-}"
LOGDIR=""   # private (0700) scratch dir for installer logs; created for a real (non-dry-run) install

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
  # Package-manager output goes to the private log dir (not /dev/null) so a failed install is diagnosable.
  _plog=/dev/null; [ -n "${LOGDIR:-}" ] && _plog="$LOGDIR/pkg.log"
  if   command -v apt-get >/dev/null 2>&1; then [ "$PKG_UPDATED" = 1 ] || { apt-get update -y >>"$_plog" 2>&1 || true; PKG_UPDATED=1; }; apt-get install -y "$_pkg" >>"$_plog" 2>&1 || true
  elif command -v dnf     >/dev/null 2>&1; then dnf install -y "$_pkg" >>"$_plog" 2>&1 || true
  elif command -v yum     >/dev/null 2>&1; then yum install -y "$_pkg" >>"$_plog" 2>&1 || true
  elif command -v apk     >/dev/null 2>&1; then apk add --no-cache "$_pkg" >>"$_plog" 2>&1 || true
  elif command -v pacman  >/dev/null 2>&1; then pacman -Sy --noconfirm "$_pkg" >>"$_plog" 2>&1 || true
  elif command -v zypper  >/dev/null 2>&1; then zypper -n install "$_pkg" >>"$_plog" 2>&1 || true
  fi
  if command -v "$_cmd" >/dev/null 2>&1; then return 0; fi
  if [ "$_plog" != /dev/null ] && [ -s "$_plog" ]; then note "could not install $_pkg; last package-manager output ($_plog): $(tail -n 2 "$_plog" | tr '\n' ' ')"; fi
  return 1
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
    --prune-images) PRUNE_IMAGES=1; shift ;;
    --no-update-checks)     NO_UPDATE_CHECKS=1; shift ;;
    --enable-update-checks) ENABLE_UPDATE_CHECKS=1; shift ;;
    --enable-telemetry)     ENABLE_TELEMETRY=1; shift ;;
    --no-telemetry)         NO_TELEMETRY=1; shift ;;
    --no-swap)              NO_SWAP=1; shift ;;
    --enable-swap)          ENABLE_SWAP=1; shift ;;
    --detect-public-ip)     DETECT_PUBLIC_IP=1; shift ;;
    --home)                 HOME_MODE=1; shift ;;
    --auto-tls)             AUTO_TLS=1; shift ;;
    --no-auto-tls)          AUTO_TLS=0; shift ;;
    --acme-email)           ACME_EMAIL_ARG="${2:-}"; shift 2 ;;
    --acme-dns-cloudflare)  ACME_DNS_PROVIDER_ARG="cloudflare"; ACME_DNS_TOKEN_ARG="${2:-}"; ACME_DNS_TOKEN_ARGV=1; shift 2 ;;
    --acme-dns-cloudflare-file)
      [ -n "${2:-}" ] && [ -r "$2" ] || { err "--acme-dns-cloudflare-file needs a readable file path"; exit 1; }
      ACME_DNS_PROVIDER_ARG="cloudflare"; ACME_DNS_TOKEN_ARG="$(head -n1 "$2" | tr -d '[:space:]')"
      [ -n "$ACME_DNS_TOKEN_ARG" ] || { err "--acme-dns-cloudflare-file: $2 is empty"; exit 1; }
      shift 2 ;;
    --cloudflare-proxy)     CF_PROXY=1; shift ;;
    --no-cloudflare-proxy)  CF_PROXY=0; shift ;;
    --keep-raw-ports)       KEEP_RAW_PORTS=1; shift ;;
    --raw-ports)            RAW_PORTS=1; shift ;;
    --public-ip) MANUAL_PUBLIC_IP="${2:-}"; shift 2 ;;
    --dry-run|--no-start) DRY_RUN=1; shift ;;
    --restore-from) RESTORE_FROM="${2:-}"; RESTORE_SET=1; shift 2 ;;
    --sync-checkout) SYNC_CHECKOUT_ONLY=1; shift ;;
    --doctor) DOCTOR=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help)  sed -n '2,/^set -euo/p' "$SCRIPT_PATH" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "unknown option: $1"; exit 1 ;;
  esac
done
if [ "$NO_SWAP" = "1" ] && [ "$ENABLE_SWAP" = "1" ]; then
  err "--no-swap and --enable-swap are mutually exclusive"; exit 1
fi
if [ "$NO_UPDATE_CHECKS" = "1" ] && [ "$ENABLE_UPDATE_CHECKS" = "1" ]; then
  err "--no-update-checks and --enable-update-checks are mutually exclusive"; exit 1
fi

if [ "$ACME_DNS_TOKEN_ARGV" = "1" ]; then
  warn "the Cloudflare token was passed on the command line (visible in ps / shell history); prefer --acme-dns-cloudflare-file <path> or TUGRA_ACME_DNS_TOKEN."
fi
# Private (0700) scratch dir for logs + the generated panel-setup script (no fixed, predictable /tmp names).
# Skipped for --dry-run, which must stay free of side effects.
if [ "$DRY_RUN" -eq 0 ] && [ "$RESTORE_SET" -eq 0 ] && [ "$DOCTOR" -eq 0 ]; then
  LOGDIR="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/tugra-install.XXXXXX")" || { err "could not create a private log directory"; exit 1; }
fi
_setup=""; ENV_BEFORE=""
trap '[ -n "$_setup" ] && rm -f "$_setup"; [ -n "${ENV_BEFORE:-}" ] && rm -f "$ENV_BEFORE"; true' EXIT

# --restore-from: this install is a hub MOVE, not a fresh setup. Hand the whole job to hub-migrate.sh, which
# validates the bundle (arch/PG-major/checksums) BEFORE anything destructive, backs up the old .env, restores
# the .env + Postgres volume, verifies the credentials over TCP, and brings the stack up. Nothing else in this
# installer runs — no fresh secrets, no owner-claim code. (Requires Docker already present on this host.)
if [ "$RESTORE_SET" = "1" ]; then
  [ -n "$RESTORE_FROM" ] || { err "--restore-from needs a bundle path"; exit 1; }
  [ "$DRY_RUN" = "1" ] && { err "--restore-from cannot be combined with --dry-run (restore is a real, destructive operation)"; exit 1; }
  [ -f "$SCRIPT_DIR/hub-migrate.sh" ] || { err "scripts/hub-migrate.sh not found next to this installer"; exit 1; }
  log "Restoring a hub bundle onto this host (via hub-migrate.sh)…"
  exec env ASSUME_YES="$ASSUME_YES" "$SCRIPT_DIR/hub-migrate.sh" unpack "$RESTORE_FROM"
fi

# --- secret generators (openssl, falling back to /dev/urandom) --------------------------------------
rand_b64() { openssl rand -base64 "$1" 2>/dev/null || { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }; }
rand_hex() { openssl rand -hex "$1" 2>/dev/null || { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }; }

# --- idempotent .env helpers (grep-based; never `source` a file with secrets) -----------------------
env_has() { [ -f "$ENV_FILE" ] && grep -q "^$1=" "$ENV_FILE"; }
# Never fails (a missing file / missing key prints nothing) so `$(env_get X)` is safe under `set -euo pipefail`.
env_get() { { grep "^$1=" "$ENV_FILE" 2>/dev/null || true; } | head -n1 | cut -d= -f2-; }
# fsync one file (coreutils/busybox `sync FILE` flush just that file and FAIL when the write-back failed; macOS/BSD
# `sync` flushes the whole machine and gives no signal, so it is skipped there).
_fsync_file() {
  case "$(uname -s 2>/dev/null)" in Darwin|*BSD) return 0 ;; esac
  command -v sync >/dev/null 2>&1 || return 0 # a minimal userland without sync: the verified temp + rename still holds
  sync "$1" >/dev/null 2>&1
}
# Atomically rewrite .env without the lines matching `$1` (plus, optionally, one appended `$1=$2`): build the new file in
# a SAME-DIR temp, VERIFY it (a write that ran out of disk part-way must never replace a good file: the line count is the
# kept lines + the new one, and the last line is the new assignment), fsync it, copy mode/owner over, then rename it over
# the old one. A crash or a full disk can never leave a truncated .env (= every secret lost); any failure leaves the old
# file untouched and returns 1. Appending a key goes through here too (an append-in-place could leave a partial line).
_env_rewrite() {
  local key="$1" val="$2" add="$3" tmp kept=0 want have
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")" || { err "cannot create a temporary file next to $ENV_FILE (disk full?) — $ENV_FILE was not changed"; return 1; }
  if [ -f "$ENV_FILE" ]; then
    kept="$(grep -vc "^${key}=" "$ENV_FILE" 2>/dev/null || true)"
    case "$kept" in ''|*[!0-9]*) kept=0 ;; esac
    { grep -v "^${key}=" "$ENV_FILE" 2>/dev/null || true; } > "$tmp" || { rm -f "$tmp"; err "cannot write $tmp (disk full?) — $ENV_FILE was not changed"; return 1; }
  fi
  want="$kept"
  if [ "$add" = "1" ]; then
    printf '%s=%s\n' "$key" "$val" >> "$tmp" || { rm -f "$tmp"; err "cannot write $tmp (disk full?) — $ENV_FILE was not changed"; return 1; }
    want=$((kept + 1))
  fi
  have="$(wc -l < "$tmp" 2>/dev/null | tr -d '[:space:]')"
  if [ "$have" != "$want" ] || { [ "$add" = "1" ] && [ "$(tail -n1 "$tmp" 2>/dev/null)" != "${key}=${val}" ]; }; then
    rm -f "$tmp"; err "the new $ENV_FILE did not verify after writing it (disk full?) — $ENV_FILE was not changed"; return 1
  fi
  _fsync_file "$tmp" || { rm -f "$tmp"; err "could not flush the new $ENV_FILE to disk (disk full?) — $ENV_FILE was not changed"; return 1; }
  chmod "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 600)" "$tmp" 2>/dev/null || chmod 600 "$tmp" 2>/dev/null || true
  chown "$(stat -c '%u:%g' "$ENV_FILE" 2>/dev/null || echo 0:0)" "$tmp" 2>/dev/null || true
  mv "$tmp" "$ENV_FILE" || { rm -f "$tmp"; err "could not replace $ENV_FILE — it was not changed"; return 1; }
}
# Generate-once: keep an existing value on re-run (regenerating would invalidate sessions / orphan
# encrypted data / change the signing identity / break the already-initialised Postgres volume).
ensure_env() {
  if env_has "$1"; then return 0; fi
  _env_rewrite "$1" "$2" 1
}
# Upsert: refresh derived/URL values every run (so a re-run with a new --domain updates them).
set_env() { _env_rewrite "$1" "$2" 1; }
unset_env() { if env_has "$1"; then _env_rewrite "$1" "" 0; fi; }

# Resolve the ports: env var > stored .env value > default. A flag-less re-run (the upgrade path) must keep a
# custom HUB_PORT/WEB_PORT instead of resetting it to 3000/3001 while HUB_PUBLIC_URL still points at the old one.
# (stored values are stripped of quotes/whitespace/CR: a hand-edited HUB_PORT="3000" must not trip the guard below)
[ -n "$HUB_PORT" ] || HUB_PORT="$(env_get HUB_PORT | tr -d "\"' \r")"
[ -n "$WEB_PORT" ] || WEB_PORT="$(env_get WEB_PORT | tr -d "\"' \r")"
HUB_PORT="${HUB_PORT:-3000}"; WEB_PORT="${WEB_PORT:-3001}"
case "$HUB_PORT$WEB_PORT" in *[!0-9]*) err "HUB_PORT/WEB_PORT must be numeric (got HUB_PORT=$HUB_PORT WEB_PORT=$WEB_PORT)"; exit 1 ;; esac
# Remember the trust mode this .env had BEFORE this run rewrites it (drives the http->https bind transition).
PREV_TRUSTED="$(env_get HUB_TRUSTED_PROXY)"
PREV_VERSION="$(env_get TUGRA_VERSION)"; PREV_VERSION="${PREV_VERSION:-latest}"

# A checkout the in-app updater wrote compose/scripts into shows those files as modified (byte-identical to the release,
# but git refuses `git pull` / `git checkout <tag>`). Before anything else: when every dirty compose/script file equals
# the release tag's content (TUGRA_VERSION from the env or .env), move the checkout to that tag so git is clean again.
# Never fatal and never discards a real edit (lib/checkout.sh): offline or an edited file just means "left as is".
SYNC_VERSION="${TUGRA_VERSION:-$(env_get TUGRA_VERSION | tr -d "\"' \r")}"
if [ "$SYNC_CHECKOUT_ONLY" = 1 ] && { [ -z "$SYNC_VERSION" ] || [ "$SYNC_VERSION" = latest ]; }; then
  err "--sync-checkout needs the release to match: run  TUGRA_VERSION=<version> ./scripts/install.sh --sync-checkout"; exit 1
fi
SYNC_ON="${TUGRA_CHECKOUT_SYNC:-$(env_get TUGRA_CHECKOUT_SYNC | tr -d "\"' \r")}"
if [ "$DRY_RUN" -eq 0 ] && [ "$DOCTOR" -eq 0 ] && [ "${SYNC_ON:-1}" != 0 ] && [ -f "$SCRIPT_DIR/lib/checkout.sh" ] \
   && [ -n "$SYNC_VERSION" ] && [ "$SYNC_VERSION" != latest ]; then
  # shellcheck source=lib/checkout.sh
  . "$SCRIPT_DIR/lib/checkout.sh"
  if co_sync "$SYNC_VERSION" "" 1; then
    [ "$CO_RESULT" != synced ] || log "git checkout moved to release tag v${SYNC_VERSION#v} (${CO_COMMIT:0:8}): the compose file and scripts are clean in git again"
  else
    warn "git checkout: $CO_NOTE"
    [ "$SYNC_CHECKOUT_ONLY" = 0 ] || exit 1
  fi
fi
[ "$SYNC_CHECKOUT_ONLY" = 0 ] || exit 0
# Pre-run copy of an existing .env (kept in the private log dir, removed on exit) — the restore point's .env.
ENV_BEFORE=""
# That copy is what a later abort restores from, so a copy that did not land (a full disk is exactly when this runs) must stop the
# run HERE, before anything is rewritten: continuing would let the abort path keep a half-configured .env and call it a fresh install.
if [ -n "$LOGDIR" ] && [ -s "$ENV_FILE" ]; then
  ENV_BEFORE="$LOGDIR/env.before"
  if ! { cp -p "$ENV_FILE" "$ENV_BEFORE" && chmod 600 "$ENV_BEFORE" && [ "$(wc -c < "$ENV_FILE" | tr -d '[:space:]')" = "$(wc -c < "$ENV_BEFORE" | tr -d '[:space:]')" ]; }; then
    rm -f "$ENV_BEFORE"; ENV_BEFORE=""
    err "could not save a copy of $ENV_FILE in $LOGDIR (disk full?) — nothing was changed. Free some disk space (or point TMPDIR at a roomier directory) and re-run."
    exit 1
  fi
fi

# A real ACME contact email: format check + reject the placeholder domains Let's Encrypt won't accept
# (mirrors panel-router.validateAcmeEmail so the installer fails fast before touching anything).
valid_acme_email() {
  [ -n "$1" ] || return 1
  [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || return 1
  _d="$(printf '%s' "$1" | sed 's/.*@//' | tr 'A-Z' 'a-z')"
  case "$_d" in example.com|example.org|example.net|localhost|*.test|*.invalid|*.example) return 1 ;; esac
  return 0
}

# 0 when something OTHER than Tugra's own proxy is listening on host port $1 (so the bundled proxy could not bind it).
# Tugra's own tugra-proxy holding the port (started by an earlier install or deploy) is not a conflict. Without `ss`
# nothing can be said: "free". (A here-string, not a pipe: under pipefail `grep -q` exiting early would SIGPIPE `ss`.)
foreign_port_busy() {
  command -v ss >/dev/null 2>&1 || return 1
  _ssout="$(ss -ltn 2>/dev/null || true)"
  grep -qE "[:.]${1}[[:space:]]*$" < <(printf '%s\n' "$_ssout" | awk '{print $4}') || return 1
  if command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -q --filter 'name=^/tugra-proxy$' 2>/dev/null || true)" ]; then return 1; fi
  return 0
}

# True (0) when IPv4 $1 lies inside one of Cloudflare's published edge ranges (https://www.cloudflare.com/ips-v4).
# A static list, so this needs no outbound call; it only steers advice (never a decision), and a stale range at worst
# prints the generic "resolves elsewhere" hint instead of the Cloudflare one.
_ip_to_int() { local IFS=.; set -- $1; echo $(( ($1 << 24) + ($2 << 16) + ($3 << 8) + $4 )); }
is_cloudflare_ip() {
  local ip="$1" c net bits n m
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  n="$(_ip_to_int "$ip")"
  for c in 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 \
           188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22; do
    net="${c%/*}"; bits="${c#*/}"
    m=$(( (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF ))
    if [ $(( n & m )) -eq $(( $(_ip_to_int "$net") & m )) ]; then return 0; fi
  done
  return 1
}

# True (0) when IPv4 $1 is private / loopback / link-local / CGNAT: not an address anyone outside can reach (a cloud VM
# behind NAT reports its interface address, never its public one).
is_private_ipv4() {
  local ip="$1" a b
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  a="${ip%%.*}"; b="${ip#*.}"; b="${b%%.*}"
  case "$a" in 10|127) return 0 ;; esac
  [ "$a" = "192" ] && [ "$b" = "168" ] && return 0
  [ "$a" = "169" ] && [ "$b" = "254" ] && return 0
  [ "$a" = "172" ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  [ "$a" = "100" ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 0
  return 1
}

# Resolve a host's IPv4 A records to a newline-separated list, PORTABLY and best-effort. Every lookup is
# wrapped in `$( … || true )` so a failed resolver/pipeline can't trip `set -euo pipefail`; the function
# always exits 0 and prints "" when nothing resolves or no resolver tool exists.
_resolve_a() {
  _h="$1"; _out=""; _to=""
  # A broken resolver must not stall the installer / --doctor for the libc retry time (minutes): bound each lookup.
  command -v timeout >/dev/null 2>&1 && _to="timeout 8"
  if command -v getent >/dev/null 2>&1; then
    _out="$($_to getent ahostsv4 "$_h" 2>/dev/null | awk '{print $1}' | sort -u || true)"
  elif command -v dig >/dev/null 2>&1; then
    _out="$($_to dig +short +time=3 +tries=1 A "$_h" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u || true)"
  elif command -v host >/dev/null 2>&1; then
    _out="$($_to host -W 3 "$_h" 2>/dev/null | awk '/has address/{print $NF}' | sort -u || true)"
  elif command -v nslookup >/dev/null 2>&1; then
    _out="$($_to nslookup "$_h" 2>/dev/null | awk '/^Address: ?/{print $NF}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | sort -u || true)"
  fi
  printf '%s' "$_out"
}

# This host's own IPv4 from LOCAL sources only — the primary interface address, then the default-route
# source IP. NO outbound call (that would break the "no IP probe by default" trust-wedge; the opt-in echo
# lives behind --detect-public-ip elsewhere). Behind NAT this is a private address, so the caller treats a
# mismatch as advisory. Prints "" when it can't tell (then the caller falls back to a resolve-only note).
_local_ip() {
  _i="$( { hostname -I 2>/dev/null || true; } | awk '{print $1; exit}' )"
  [ -n "$_i" ] || _i="$( { ip route get 1.1.1.1 2>/dev/null || true; } | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' )"
  case "$_i" in localhost|"") printf '' ;; *) printf '%s' "$_i" ;; esac
}

# Advisory DNS/token sanity for the panel's HTTPS, run BEFORE anything is provisioned so a misconfigured domain
# is caught here (with an exact fix) instead of as a silent cert failure — the #1 "SSL just didn't work"
# foot-gun. It ONLY prints guidance: never errors, never changes the decision, never blocks headless, so a
# false read can't stop a correct setup or burn a Let's Encrypt attempt. Crucially it makes NO outbound IP
# probe (trust-wedge): HTTP-01 compares the domain's A record against this host's LOCAL interface IP (or a
# --public-ip you gave), never an external echo. DNS-01 (Cloudflare token) validates over DNS instead, so
# the record may stay proxied and we verify the token — a call to the user's own Cloudflare account, which
# DNS-01 provisioning makes anyway — rather than the address. A Cloudflare-proxied record needs NO token for HTTP-01
# (the common case), so it is only ever mentioned as an option. Args: <domain> <dns01?> [known-ipv4].
# Is the panel's hostname proxied by Cloudflare (its A/AAAA records resolve to Cloudflare edge addresses)? Reuses the
# preflight's answer when it ran; otherwise resolves the stored panel host (a re-run with a stored PANEL_TLS skips the
# preflight). Local DNS lookup only, no outbound probe. Returns 0 when proxied.
panel_behind_cloudflare() {
  [ "${PANEL_BEHIND_CF:-0}" = "1" ] && return 0
  [ "$DRY_RUN" -eq 0 ] || return 1
  local _h _r _a
  _h="${DOMAIN:-}"
  [ -n "$_h" ] || _h="$(env_get PANEL_DOMAIN)"
  [ -n "$_h" ] || { _h="$(env_get HUB_PUBLIC_URL)"; _h="${_h#*://}"; _h="${_h%%/*}"; _h="${_h%%:*}"; }
  [ -n "$_h" ] || return 1
  _r="$(_resolve_a "$_h" 2>/dev/null || true)"
  [ -n "$_r" ] || return 1
  while IFS= read -r _a; do
    if [ -n "$_a" ] && is_cloudflare_ip "$_a"; then PANEL_BEHIND_CF=1; return 0; fi
  done <<<"$_r"
  return 1
}

panel_dns_preflight() {
  _dom="$1"; _dns01="$2"; _knownip="${3:-}"
  _dom="$(printf '%s' "$_dom" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#[/:].*$##')"
  [ -n "$_dom" ] || return 0

  if [ "$_dns01" = "1" ]; then
    if command -v curl >/dev/null 2>&1 && [ -n "${ACME_DNS_TOKEN_ARG:-}" ]; then
      # No -f here: an invalid token returns HTTP 400 with a JSON error body we WANT to read (so we can say
      # "rejected" vs. "couldn't reach"). -f would discard that body and make both look like a network miss.
      # The bearer header goes through a curl config on stdin (-K -), so the token never appears in argv / ps.
      _vr="$(printf 'header = "Authorization: Bearer %s"\n' "${ACME_DNS_TOKEN_ARG}" | curl -sS --max-time 6 -K - \
             https://api.cloudflare.com/client/v4/user/tokens/verify 2>/dev/null || true)"
      case "$_vr" in
        *'"status":"active"'*) ok "Cloudflare API token verified (DNS-01 — a real cert while $_dom stays proxied, IP hidden)." ;;
        '') note "Couldn't reach Cloudflare to verify the DNS-01 token right now; provisioning continues and the cert issues once it works." ;;
        *) warn "Cloudflare rejected the DNS-01 token (not active / wrong scope). The panel cert won't issue until it's a valid token with Zone:DNS:Edit — re-run with a correct --acme-dns-cloudflare <token>." ;;
      esac
    fi
    return 0
  fi

  _resolved="$(_resolve_a "$_dom")"
  if [ -z "$_resolved" ]; then
    note "$_dom has no A record yet. HTTP-01 needs it pointing at this server's public IP; add the DNS record and the panel cert issues automatically."
    return 0
  fi
  _disp="$(printf '%s' "$_resolved" | tr '\n' ' ' | sed 's/ *$//')"
  # Behind Cloudflare's orange cloud the A record is a Cloudflare edge address, never this host — and that is fine:
  # HTTP-01 works through the proxy as long as Cloudflare forwards :80 to this server (it does by default). No token.
  _cf=0
  while IFS= read -r _ra; do [ -n "$_ra" ] && is_cloudflare_ip "$_ra" && _cf=1; done <<<"$_resolved"
  if [ "$_cf" = "1" ]; then
    PANEL_BEHIND_CF=1
    ok "$_dom is behind Cloudflare's proxy (orange cloud). Tugra asks Let's Encrypt over HTTP-01 first, so no Cloudflare token is needed."
    note "If the certificate does not issue: set Cloudflare SSL/TLS mode to 'Full' (not 'Flexible') while the first cert issues and turn 'Always Use HTTPS' off (or set the record to DNS only for a minute)."
    note "Only if you would rather not depend on :80 reaching this server: re-run with --acme-dns-cloudflare-file <path> (optional DNS-01)."
    return 0
  fi
  [ -n "$_knownip" ] || _knownip="$(_local_ip)"
  if [ -z "$_knownip" ]; then
    note "$_dom resolves to $_disp. Make sure that is THIS server's public IP — HTTP-01 validates over :80 at that address."
    return 0
  fi
  # here-string, not a pipe: under pipefail the pipe form fails on SIGPIPE when grep exits at the first match
  if grep -qxF "$_knownip" <<<"$_resolved"; then
    ok "$_dom resolves to this host ($_knownip) — HTTP-01 can validate; the panel cert issues on the first reachable request."
  else
    warn "$_dom resolves to $_disp, but this host's address is $_knownip."
    note "HTTP-01 validates over :80 at the domain's address, so the panel cert WON'T issue until $_dom points at this server's public IP."
    note "On a server behind NAT (the address above is private) that is expected: pass --public-ip <ip>. On a bare VPS, set $_dom's A record to this host."
  fi
}

# The private-address warning shared by the install and --doctor.
warn_private_ip() {
  warn "This server's address ($1) is a private one — it will only open from inside that network, not from the internet."
  note "On a cloud server (behind NAT) re-run with --public-ip <the server's public IP> so the panel URL and agents use it."
}

# Network health checks (ports, firewall, cloud provider, IPv6) + --doctor: lib/netcheck.sh, read-only.
if [ -f "$SCRIPT_DIR/lib/netcheck.sh" ]; then
  # shellcheck source=lib/netcheck.sh
  . "$SCRIPT_DIR/lib/netcheck.sh"
fi
if [ -f "$SCRIPT_DIR/lib/swap.sh" ]; then
  # shellcheck source=lib/swap.sh
  . "$SCRIPT_DIR/lib/swap.sh"
fi
if [ -f "$SCRIPT_DIR/lib/hostfacts.sh" ]; then
  # shellcheck source=lib/hostfacts.sh
  . "$SCRIPT_DIR/lib/hostfacts.sh"
fi

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
    if command -v curl >/dev/null 2>&1 && curl -fsSL https://get.docker.com | sh >"$LOGDIR/docker-install.log" 2>&1 && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      ok "Docker installed ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo present))"
    else
      bad "Automatic Docker install failed — install it manually: https://get.docker.com (log: $LOGDIR/docker-install.log)"; fail=1
    fi
  fi
  if docker compose version >/dev/null 2>&1; then ok "Docker Compose v2 plugin"; else bad "Docker Compose v2 plugin is required (docker compose)"; fail=1; fi
  ensure_pkg git git && ok "git" || note "git not found and could not be installed (needed only for Git-source deploys)"
  command -v curl >/dev/null 2>&1 && ok "curl" || note "curl not found (used for the post-install health check)"
  arch="$(uname -m 2>/dev/null || echo '?')"
  case "$arch" in
    x86_64|amd64) ok "Architecture: $arch" ;;
    aarch64|arm64)
      # Only the agent image is published multi-arch; the hub/web/updater are amd64-only. So on an arm64
      # control-plane host `compose pull` finds no matching image and the installer BUILDS them from source
      # (correct, just slower + a little RAM) rather than failing. Say so up front — not a surprise long build.
      note "arm64 host: the hub/web images are amd64-only, so they'll be BUILT from source here (a few minutes + ~2GB RAM). Automatic; pass --build to force it, or run the hub on an amd64 box to pull prebuilt images." ;;
    *) note "Unusual architecture: $arch — prebuilt images target amd64, so the installer will build from source." ;;
  esac
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
  if declare -F nc_preflight >/dev/null 2>&1; then
    # Who holds :80/:443 and the raw ports (with advice), the host + cloud firewall, the hosting provider, IPv6/AAAA. Advice only.
    nc_preflight
  elif command -v ss >/dev/null 2>&1; then
    for p in "${HUB_PORT:-3000}" "${WEB_PORT:-3001}" 80 443; do
      ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$" && note "Port ${p} looks busy — Tugra's proxy / the stack may fail to bind it (free it or set HUB_PORT/WEB_PORT). (Docker-published ports bypass ufw — use a cloud firewall.)"
    done
  fi
  [ "$fail" -eq 0 ] || { err "Preflight failed — fix the ✗ item(s) above and re-run."; exit 1; }
  printf '\n'
}
if [ "$DOCTOR" -eq 1 ]; then
  declare -F nc_doctor >/dev/null 2>&1 || { err "scripts/lib/netcheck.sh not found next to this installer — update the checkout and re-run"; exit 1; }
  if nc_doctor; then exit 0; else exit 1; fi
fi
if [ "$DRY_RUN" -eq 0 ]; then
  banner
  preflight
fi

# Anonymous usage stats are ON by default, opt-out. COUNTS ONLY (servers, apps, databases, deploys) plus
# version/edition/OS with a random id — never names, IPs, domains or secrets — changeable anytime in
# Settings. An EXPLICIT choice on THIS run (--no-telemetry / --enable-telemetry, or TUGRA_TELEMETRY=0|1)
# always wins and OVERRIDES a value already in .env — so `install.sh --no-telemetry` on an existing box
# truly turns it off (TELEMETRY_OVERRIDE → set_env below). With no explicit choice we decide once on a
# fresh install (interactive [Y/n], default yes; headless keeps it on with a notice) and KEEP a prior
# choice already in .env (TELEMETRY_DECISION → ensure_env below).
if [ "$NO_TELEMETRY" = "1" ] || [ "${TUGRA_TELEMETRY:-}" = "0" ]; then
  TELEMETRY_OVERRIDE="0"
elif [ "$ENABLE_TELEMETRY" = "1" ] || [ "${TUGRA_TELEMETRY:-}" = "1" ]; then
  TELEMETRY_OVERRIDE="1"
elif ! env_has TUGRA_TELEMETRY; then
  if [ "$DRY_RUN" -eq 0 ] && [ -r /dev/tty ]; then
    printf '\n  Help improve Tugra with anonymous usage stats? Counts only (servers, apps, deploys), no\n  names, IPs or secrets, and you can turn it off anytime in Settings.\n'
    printf '  Share stats? [Y/n] '
    IFS= read -r _tel_ans </dev/tty || _tel_ans=""
    case "$_tel_ans" in [Nn] | [Nn][Oo]) TELEMETRY_DECISION="0" ;; *) TELEMETRY_DECISION="1" ;; esac
    printf '\n'
  else
    TELEMETRY_DECISION="1"
    [ "$DRY_RUN" -eq 0 ] && note "Anonymous usage stats are ON by default (counts only, no identifiers). Turn off with --no-telemetry or TUGRA_TELEMETRY=0, or in Settings."
  fi
fi

# --- resolve the public URLs + cookie/proxy mode ----------------------------------------------------
# Flag-less re-run on an existing install = the documented upgrade path (README / docs/upgrade.md): it
# must PRESERVE the configured origin, not silently revert a --domain deployment back to the http quick
# start. Explicit flags still override; a deliberate downgrade passes --hub-url/--web-url (http://…).
# Each half is preserved independently: passing only --hub-url (or only --web-url) keeps the stored other
# half rather than recomputing it from the host IP (which would leave an https hub with an http web origin).
# IP mode (the default for a fresh install without --domain): Tugra's own proxy serves the panel on http://<ip>/ (port 80),
# with the same single-origin routing as a domain install, so only 80/443 have to be reachable. Decided ONCE, before the
# URLs are resolved: a fresh install gets it (unless --raw-ports, explicit --hub-url/--web-url, or port 80 is taken by
# something else); an existing install keeps exactly what it has (a stored PANEL_IP_ROUTE=1 stays on, every other
# existing install keeps its raw ports) — a flag-less upgrade never moves anyone's panel.
IP_PRIVATE_NOTICE=0
IP_MODE=0; IP_MODE_FRESH=0   # IP_MODE_FRESH: THIS run is the one that first enables IP mode (a fresh install)
if [ -z "$DOMAIN" ] && [ -z "$HUB_URL" ] && [ -z "$WEB_URL" ]; then
  if env_has HUB_PUBLIC_URL; then
    [ "$(env_get PANEL_IP_ROUTE | tr -d "\"' \r")" = "1" ] && IP_MODE=1
  elif [ "$RAW_PORTS" != "1" ]; then
    IP_MODE=1; IP_MODE_FRESH=1
    if [ "$DRY_RUN" -eq 0 ] && foreign_port_busy 80; then
      IP_MODE=0; IP_MODE_FRESH=0
      note "Port 80 is already in use by another service, so the panel is published on the raw ports (:$HUB_PORT/:$WEB_PORT) instead of http://<ip>/."
      note "Free port 80 and re-run with --hub-url/--web-url removed, or add --domain <host> once your own proxy fronts Tugra."
    fi
  fi
fi
if [ -z "$DOMAIN" ]; then
  if [ -z "$HUB_URL" ] && env_has HUB_PUBLIC_URL; then HUB_URL="$(env_get HUB_PUBLIC_URL)"; fi
  if [ -z "$WEB_URL" ] && env_has WEB_PUBLIC_URL; then WEB_URL="$(env_get WEB_PUBLIC_URL)"; fi
fi
if [ -n "$DOMAIN" ]; then
  # Single public origin behind the user's TLS reverse proxy (see README for the path-routing rules).
  HUB_URL="${HUB_URL:-https://$DOMAIN}"
  WEB_URL="${WEB_URL:-https://$DOMAIN}"
elif [ -z "$HUB_URL" ] || [ -z "$WEB_URL" ]; then
  # Quick start: plain http on this host's first IP (agents must be able to reach the hub port).
  # Detect the IP PORTABLY — `hostname -I` is GNU/net-tools-only and ERRORS on macOS/BSD and on
  # busybox/Alpine; guard every step (`{ … || true; }`) so `set -euo pipefail` can't kill the script
  # silently when it's unavailable. Fall back to the default-route source IP, then to localhost.
  # An explicit --public-ip is the address the operator wants in the URL (a cloud box's interface IP is private behind NAT).
  HOST_IP="${MANUAL_PUBLIC_IP:-}"
  [ -n "$HOST_IP" ] || HOST_IP="$( { hostname -I 2>/dev/null || true; } | awk '{print $1; exit}' )"
  if [ -z "$HOST_IP" ]; then
    HOST_IP="$( { ip route get 1.1.1.1 2>/dev/null || true; } | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' )"
  fi
  if [ -z "$HOST_IP" ]; then
    HOST_IP="localhost"
    warn "Could not auto-detect this host's IP; using 'localhost'. If agents run on other machines, re-run with --hub-url http://<host-ip>:$HUB_PORT --web-url http://<host-ip>:$WEB_PORT"
  fi
  if [ "$IP_MODE" = "1" ]; then
    # A private interface address (cloud VM behind NAT, home LAN) is not reachable from outside: say so instead of
    # printing it as the address to open. Only when the operator did not pin a public IP themselves.
    if [ -z "$MANUAL_PUBLIC_IP" ] && is_private_ipv4 "$HOST_IP"; then
      IP_PRIVATE_NOTICE=1
      warn_private_ip "$HOST_IP"
    fi
    # Through the proxy on port 80: no port in the URL (agents dial http://<ip>/agent, the browser opens http://<ip>/).
    HUB_URL="${HUB_URL:-http://$HOST_IP}"
    WEB_URL="${WEB_URL:-http://$HOST_IP}"
  else
    HUB_URL="${HUB_URL:-http://$HOST_IP:$HUB_PORT}"
    WEB_URL="${WEB_URL:-http://$HOST_IP:$WEB_PORT}"
  fi
fi
# Cookie + proxy mode follow the RESOLVED hub origin's scheme: https => a TLS reverse proxy fronts the
# hub, so set Secure cookies and trust exactly ONE proxy hop for X-Forwarded-For; plain http => no proxy,
# trust only the un-spoofable raw TCP peer IP. Deriving from the scheme (not just the --domain flag) is
# what lets a flag-less upgrade preserve the mode while an explicit http downgrade clears a stale proxy.
# IP mode is plain http but sits behind Tugra's own proxy, so it trusts that one hop too (Secure cookies stay off: http).
HUB_HTTPS=0
case "$HUB_URL" in
  https://*) COOKIE_SECURE="true";  HUB_TRUSTED_PROXY="true"; HUB_HTTPS=1 ;;
  *)         COOKIE_SECURE="false"; HUB_TRUSTED_PROXY="false" ;;
esac
[ "$IP_MODE" = "1" ] && HUB_TRUSTED_PROXY="true"
# Cloudflare client-IP mode reads a forwarding chain it only believes behind a trusted proxy (https): refuse to
# silently ignore the flag, and never leave a stale true behind a plain-http origin (the hub would refuse to boot).
case "$CF_PROXY" in ""|0|1) ;; *) err "TUGRA_CLOUDFLARE_PROXY must be 1 or 0 (got: $CF_PROXY)"; exit 1 ;; esac
if [ "$CF_PROXY" = "1" ] && [ "$HUB_HTTPS" != "1" ]; then
  err "--cloudflare-proxy needs the panel served over https (--domain <host> or an https --hub-url): Cloudflare only proxies a real hostname. Nothing was changed."
  exit 1
fi
if [ -n "$ACME_DNS_TOKEN_ARG" ] && [ -z "$CF_PROXY" ] && [ "$(env_get HUB_TRUSTED_PROXY_CLOUDFLARE)" != "true" ]; then
  note "Behind Cloudflare's orange cloud every client looks like a Cloudflare edge address (IP allowlists are meaningless). If this record is proxied, re-run with --cloudflare-proxy."
fi
# Host bind for the published hub/web ports. A trusted-proxy (https) hub honors X-Forwarded-For (and only from
# private/loopback/docker peers, see HUB_TRUSTED_PROXY_CIDRS), so its raw port should not be internet-exposed.
# A FRESH --domain install binds to loopback (same-host proxy). The http quick start keeps 0.0.0.0 (agents dial
# host:3000). An EXISTING install turning https is moved to loopback below at the .env write (opt out:
# --keep-raw-ports), and bundled TLS moves it once the panel router is live. Override anytime with
# HUB_BIND/WEB_BIND (e.g. a private-interface IP for a proxy on another host).
if [ "$HUB_TRUSTED_PROXY" = "true" ] && ! env_has HUB_PUBLIC_URL; then
  PORT_BIND_DEFAULT="127.0.0.1"   # a fresh --domain or IP-mode install: only the proxy needs the raw ports
else
  PORT_BIND_DEFAULT="0.0.0.0"
fi

# --- Panel-TLS: decide + validate BEFORE writing .env or starting anything -------------------------
# Only with a --domain https origin. Tugra provisions the panel's HTTPS itself by default (bundled Traefik + Let's
# Encrypt HTTP-01 — no token, no email needed), the way `--domain` is expected to behave in one command. Explicit
# --no-auto-tls keeps bring-your-own-proxy, and so does a domain given while :80/:443 are held by another web server
# (the bundled proxy could not bind them). A stored PANEL_TLS (an existing install's choice) is never overridden by a
# flag-less run, and a re-run with --domain on an install that already decided keeps that decision.
PANEL_TLS_DECISION=""; PANEL_ACME_EMAIL=""
STORED_HUB_HTTPS=0
if env_has HUB_PUBLIC_URL; then case "$(env_get HUB_PUBLIC_URL | tr -d "\"' \r")" in https://*) STORED_HUB_HTTPS=1 ;; esac; fi
if [ -n "$DOMAIN" ] && [ "$HUB_TRUSTED_PROXY" = "true" ]; then
  _want=""
  if [ "$AUTO_TLS" = "1" ] || [ -n "$ACME_EMAIL_ARG" ] || [ -n "$ACME_DNS_TOKEN_ARG" ]; then _want=1
  elif [ "$AUTO_TLS" = "0" ]; then _want=0
  elif ! env_has PANEL_TLS && [ "$STORED_HUB_HTTPS" = "1" ]; then
    # An install that predates PANEL_TLS and is ALREADY https is fronted by the operator's own proxy (possibly on another
    # host, pointing at host:3001). A flag-less --domain re-run must not start a second proxy and move the raw ports to
    # loopback underneath it: keep bring-your-own-proxy, and say how to opt in.
    note "This install is already served over https by your own proxy, so it stays that way. To let Tugra provision the panel's HTTPS instead, re-run with --auto-tls."
  elif ! env_has PANEL_TLS; then
    _want=1
    for _p in 80 443; do
      if [ "$DRY_RUN" -eq 0 ] && foreign_port_busy "$_p"; then
        _want=0
        note "Port ${_p} is already in use by another service, so Tugra's own HTTPS proxy can't bind it: keeping bring-your-own-proxy for $DOMAIN."
        note "Front Tugra with that proxy (tugra.io/docs/install has the routing table), or free :80/:443 and re-run with --auto-tls."
      fi
    done
  fi
  if [ "$_want" = "1" ]; then
    # The contact email is OPTIONAL (Let's Encrypt only uses it for expiry notices); one that is given must be real.
    PANEL_ACME_EMAIL="$ACME_EMAIL_ARG"
    # env_has guards the fresh-install case: .env does not exist yet here, and `grep` on a missing file
    # exits 2, which under `set -e` + `&&` would silently abort. env_has returns false (no grep) if absent.
    if [ -z "$PANEL_ACME_EMAIL" ] && env_has ACME_EMAIL; then PANEL_ACME_EMAIL="$(env_get ACME_EMAIL)"; fi
    if [ -n "$PANEL_ACME_EMAIL" ] && ! valid_acme_email "$PANEL_ACME_EMAIL"; then
      err "--acme-email must be a real address (not example/test/localhost). Nothing was changed."
      exit 1
    fi
    PANEL_TLS_DECISION=1
    # Catch a misconfigured domain HERE (before any ACME attempt), not as a silent cert failure later.
    # Advisory only — never blocks the install. DNS-01 token in play => check the token, not the A record.
    if [ "$DRY_RUN" -eq 0 ]; then
      _p01=0
      if [ -n "$ACME_DNS_TOKEN_ARG" ] || env_has ACME_DNS_TOKEN; then _p01=1; fi
      # Pass a known IP so the HTTP-01 check needs no outbound probe: --public-ip if given, else a local read.
      panel_dns_preflight "$DOMAIN" "$_p01" "${MANUAL_PUBLIC_IP:-}" || true
    fi
  elif [ "$_want" = "0" ]; then
    PANEL_TLS_DECISION=0
  fi
elif [ "$AUTO_TLS" = "1" ] || [ -n "$ACME_EMAIL_ARG" ] || [ -n "$ACME_DNS_TOKEN_ARG" ]; then
  err "--auto-tls / --acme-email / --acme-dns-cloudflare require --domain <host> (the panel's HTTPS hostname). To set the domain later, use Settings -> Instance -> Panel domain."
  exit 1
fi

# --- write the .env (create with 0600, preserve secrets on re-run) ----------------------------------
[ "$DRY_RUN" -eq 1 ] || step "Writing configuration (.env with fresh secrets)…"
[ -f "$ENV_FILE" ] || (umask 077; : > "$ENV_FILE")
chmod 600 "$ENV_FILE"   # BEFORE any secret is appended (a pre-existing 0644 .env must not leak them in the interim)

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
# Agent image: the installer no longer writes TUGRA_AGENT_IMAGE / AGENT_IMAGE. Compose derives the local
# agent's image from TUGRA_VERSION, and an unset AGENT_IMAGE lets the hub default to its own version AND keep
# the signed-manifest digest pin (any AGENT_IMAGE disables it). Older installers froze both at the first
# install's tag: drop those stale installer-default values, but never touch a custom/mirror override.
for _k in AGENT_IMAGE TUGRA_AGENT_IMAGE; do
  if env_has "$_k"; then
    case "$(env_get "$_k" | tr -d "\"'")" in
      ghcr.io/simeraycom/tugra-agent:latest|ghcr.io/simeraycom/tugra-agent:[0-9]*) unset_env "$_k"; note "removed stale $_k (installer default, frozen at the first install's tag)" ;;
      "") unset_env "$_k" ;;
    esac
  fi
done
# Pin hub/web/agent to a specific release when TUGRA_VERSION is set (e.g. a beta:
# TUGRA_VERSION=0.1.0-beta.1 ./scripts/install.sh). Persist it so later `compose up`/reboots keep the pinned
# tag instead of drifting back to :latest (compose reads ${TUGRA_VERSION:-latest}). set_env (override), not
# ensure_env: an explicit TUGRA_VERSION on this run is a deliberate repin. A plain install leaves it unset
# (:latest); the self-updater rewrites this line on each applied update.
# The self-updater also pins hub/web by digest (TUGRA_HUB_DIGEST / TUGRA_WEB_DIGEST → `repo:tag@sha256:…` in
# compose). A pin belongs to the version it was written for: it would override a deliberate repin and cannot be
# used as the tag of a locally BUILT image, so drop it whenever this run repins or builds (empty = tag-only).
drop_digest_pins() {
  local k
  for k in TUGRA_HUB_DIGEST TUGRA_WEB_DIGEST; do
    if env_has "$k" && [ -n "$(env_get "$k")" ]; then set_env "$k" ""; fi
  done
}
if [ -n "${TUGRA_VERSION:-}" ]; then
  set_env TUGRA_VERSION "$TUGRA_VERSION"
  drop_digest_pins
fi
if [ "$FORCE_BUILD" -eq 1 ]; then drop_digest_pins; fi
# Signed self-update checks — ON by default. The hub fetches ONE ed25519-signed manifest (no identifiers, no
# version, no payload) hourly and when the panel is opened; the official URL/key are built into the hub, so
# nothing is written here unless the operator decides. An EXPLICIT choice on this run upserts (set_env) so it
# overrides a stored value; a flag-less re-run keeps whatever is stored (including an earlier opt-out).
# An operator's own UPDATE_MANIFEST_URL/UPDATE_PUBLISHER_KEY pair in .env still wins over the built-in defaults.
if [ "$NO_UPDATE_CHECKS" = "1" ]; then set_env TUGRA_UPDATE_CHECKS "0"
elif [ "$ENABLE_UPDATE_CHECKS" = "1" ]; then set_env TUGRA_UPDATE_CHECKS "1"; fi
# Persist the telemetry choice decided above. The hub sends a once-a-day anonymous ping of COUNTS only
# (servers, apps, databases, deploys) + version/edition/OS with a random instance id when
# TUGRA_TELEMETRY != "0". An EXPLICIT choice on this run upserts (set_env) so it OVERRIDES a stored value;
# the implicit fresh-install default is only-if-unset (ensure_env) so an unrelated re-run keeps it.
[ -n "${TELEMETRY_OVERRIDE:-}" ] && set_env TUGRA_TELEMETRY "$TELEMETRY_OVERRIDE"
[ -n "${TELEMETRY_DECISION:-}" ] && ensure_env TUGRA_TELEMETRY "$TELEMETRY_DECISION"
# --home: start the owner account in the simple Home launcher instead of the full Fleet control plane. The
# owner can still pick/switch during onboarding (the welcome wizard) or later in Settings. only-if-unset.
[ "$HOME_MODE" = "1" ] && ensure_env DEFAULT_UI_MODE home
# Swap safety net for small hosts (lib/swap.sh): an explicit --no-swap / --enable-swap is remembered in .env; a flag-less
# re-run keeps it. Only the real run touches the host (never --dry-run); a failure there is never fatal.
if [ "$NO_SWAP" = "1" ]; then set_env TUGRA_NO_SWAP "1"
elif [ "$ENABLE_SWAP" = "1" ]; then set_env TUGRA_NO_SWAP "0"; fi
if [ "$DRY_RUN" -eq 0 ] && declare -F swap_ensure >/dev/null 2>&1; then
  [ "$(env_get TUGRA_NO_SWAP | tr -d "\"' \r")" = "1" ] && NO_SWAP=1
  [ "$ENABLE_SWAP" = "1" ] && NO_SWAP=0
  swap_ensure || true
fi

PG_PWD="$(env_get POSTGRES_PASSWORD)"
set_env NODE_ENV       "production"
set_env DATABASE_URL   "postgresql://tugra:${PG_PWD}@postgres:5432/tugra?schema=public"
set_env REDIS_URL      "redis://redis:6379"          # in-compose Redis (rewritten on every run). hub-api honours a full redis[s]://user:pass@host:port/db URL, but an external Redis is unsupported here: the tugra-updater sidecar is pinned to redis://redis:6379.
set_env HUB_PORT       "$HUB_PORT"
set_env WEB_PORT       "$WEB_PORT"
# Preserve on re-run (ensure_env, not set_env): never clobber an operator's deliberate bind lock-down.
ensure_env HUB_BIND    "${HUB_BIND:-$PORT_BIND_DEFAULT}"
ensure_env WEB_BIND    "${WEB_BIND:-$PORT_BIND_DEFAULT}"
# http -> https TRANSITION (this run turns HUB_TRUSTED_PROXY on): the hub now honors X-Forwarded-For, so a
# raw 0.0.0.0 port is no longer appropriate. Move a still-default 0.0.0.0 bind to loopback, unless the operator
# opted out (--keep-raw-ports) or passed an explicit HUB_BIND/WEB_BIND on this run. A non-0.0.0.0 bind and a
# flag-less re-run of an already-trusted install are never touched (the hub's peer check protects those).
REBOUND=0
if [ "$HUB_TRUSTED_PROXY" = "true" ] && [ "$PREV_TRUSTED" != "true" ] && [ "$KEEP_RAW_PORTS" != "1" ]; then
  if [ -z "${HUB_BIND:-}" ] && [ "$(env_get HUB_BIND)" = "0.0.0.0" ]; then set_env HUB_BIND 127.0.0.1; REBOUND=1; fi
  if [ -z "${WEB_BIND:-}" ] && [ "$(env_get WEB_BIND)" = "0.0.0.0" ]; then set_env WEB_BIND 127.0.0.1; REBOUND=1; fi
  if [ "$REBOUND" = "1" ]; then
    note "Switching to https: the raw hub/web ports (:$HUB_PORT/:$WEB_PORT) are now bound to 127.0.0.1 — only your reverse proxy should reach them."
    note "Agents still dialing the old plain-http URL need the new https URL (re-run their install command); pass --keep-raw-ports to keep 0.0.0.0."
  fi
fi
set_env HUB_PUBLIC_URL "$HUB_URL"
set_env WEB_PUBLIC_URL "$WEB_URL"
set_env COOKIE_SECURE  "$COOKIE_SECURE"
# Always upsert (not just in --domain mode): switching back from --domain to the http quick-start must
# CLEAR a stale HUB_TRUSTED_PROXY=true, else the hub would keep trusting spoofable X-Forwarded-For.
set_env HUB_TRUSTED_PROXY "$HUB_TRUSTED_PROXY"
# Cloudflare client-IP mode: explicit flag wins; a flag-less re-run keeps the stored value while the proxy trust is
# still on; leaving https (or trusted-proxy mode) CLEARS it (Cloudflare only proxies a real https hostname).
if [ "$HUB_HTTPS" != "1" ]; then
  if env_has HUB_TRUSTED_PROXY_CLOUDFLARE; then set_env HUB_TRUSTED_PROXY_CLOUDFLARE "false"; fi
elif [ "$CF_PROXY" = "1" ]; then set_env HUB_TRUSTED_PROXY_CLOUDFLARE "true"
elif [ "$CF_PROXY" = "0" ]; then set_env HUB_TRUSTED_PROXY_CLOUDFLARE "false"
elif [ "$(env_get HUB_TRUSTED_PROXY_CLOUDFLARE)" != "true" ] && panel_behind_cloudflare; then
  # The panel's DNS resolves to Cloudflare's edge (orange cloud): every connection reaches the hub from a Cloudflare
  # address, so without this every agent's server IP and every login IP would be Cloudflare's. Turn the verified
  # CF-Connecting-IP mode on automatically (it only trusts hops inside the published Cloudflare ranges).
  set_env HUB_TRUSTED_PROXY_CLOUDFLARE "true"
  ok "Cloudflare proxy detected: real client and server IPs are taken from Cloudflare's verified header (turn off with --no-cloudflare-proxy)."
fi
# IP mode: the hub renders the host-less http://<ip>/ router from this flag. Switched OFF whenever this run moves the panel
# to a domain or to explicit URLs; never written for an install that does not use it.
if [ "$IP_MODE" = "1" ]; then set_env PANEL_IP_ROUTE 1
elif env_has PANEL_IP_ROUTE; then set_env PANEL_IP_ROUTE 0; fi
# Panel-TLS: persist only when a decision was made THIS run (a flag-less re-run leaves these untouched).
if [ -n "$PANEL_TLS_DECISION" ]; then
  set_env PANEL_TLS "$PANEL_TLS_DECISION"
  if [ "$PANEL_TLS_DECISION" = "1" ]; then
    set_env PANEL_DOMAIN "$DOMAIN"
    [ -z "$PANEL_ACME_EMAIL" ] || set_env ACME_EMAIL "$PANEL_ACME_EMAIL"
    # A domain is live: the host-less http://<ip>/ route is not (IP mode off; the hub reads PANEL_IP_ROUTE=1 only).
    if env_has PANEL_IP_ROUTE; then set_env PANEL_IP_ROUTE 0; fi
    # DNS-01 (optional): a real cert while the record stays proxied (IP hidden). Token is a secret → 0600 .env.
    if [ -n "$ACME_DNS_TOKEN_ARG" ]; then
      set_env ACME_DNS_PROVIDER "${ACME_DNS_PROVIDER_ARG:-cloudflare}"
      set_env ACME_DNS_TOKEN "$ACME_DNS_TOKEN_ARG"
    fi
  fi
elif [ -n "$DOMAIN" ] && [ "$(env_get PANEL_TLS)" = "1" ]; then
  # Bundled TLS already on and no TLS decision this run, but the domain changed: the panel router must follow
  # it, else it keeps provisioning the OLD host.
  set_env PANEL_DOMAIN "$DOMAIN"
fi

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
# The local agent runs in a container: record the HOST's hostname, OS and IPs where it can read them (/etc/tugra).
if command -v tugra_write_host_facts >/dev/null 2>&1; then tugra_write_host_facts; fi

# The pre-run .env goes back the same way every other .env write happens: a SAME-DIR temp, size-verified against the saved
# copy, fsync'ed, then renamed over the live file. An in-place copy that ran out of space would leave a truncated .env (every
# secret lost) and still claim success. On failure the live .env is untouched and the saved copy is KEPT (its path is printed).
_restore_env_before() {
  local tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")" || return 1
  if ! { cp -p "$ENV_BEFORE" "$tmp" \
         && [ "$(wc -c < "$tmp" | tr -d '[:space:]')" = "$(wc -c < "$ENV_BEFORE" | tr -d '[:space:]')" ] \
         && _fsync_file "$tmp" && mv "$tmp" "$ENV_FILE"; }; then
    rm -f "$tmp"; return 1
  fi
}
# Abort AFTER the .env was rewritten and BEFORE any container was touched: put the pre-run .env back so the file
# on disk matches the (unchanged) running stack, and say so truthfully. A fresh install has no pre-run file, so
# its freshly generated .env is kept. Usage: abort_untouched <reason lines…> ; exits 1.
abort_untouched() {
  for _m in "$@"; do err "$_m"; done
  if [ -n "${ENV_BEFORE:-}" ] && [ -f "$ENV_BEFORE" ]; then
    if _restore_env_before; then
      err "No application containers were touched, and $ENV_FILE was restored to its pre-run state."
    else
      err "No application containers were touched, but $ENV_FILE could NOT be restored (disk full?): it keeps the configuration this run wrote."
      err "The pre-run copy is saved at $ENV_BEFORE — after freeing disk space run: cp -p $ENV_BEFORE $ENV_FILE"
      ENV_BEFORE=""   # keep that copy: the exit trap removes only a copy that is no longer needed
    fi
  else
    err "No application containers were touched. ($ENV_FILE keeps the configuration written by this run — it is a fresh install.)"
  fi
  # A pre-run .env that already names a release NEWER than the one that runs is the leftover of a half-finished update
  # (an older updater wrote it before the pull, then the pull or the rollback failed). Restoring it verbatim would keep
  # a version whose images are not on this machine: put it back to what actually runs.
  if [ -n "${RUNNING_VERSION:-}" ] && [ -f "$ENV_FILE" ]; then
    _hv="$(env_get TUGRA_VERSION | tr -d "\"' \r")"
    if [ -n "$_hv" ] && is_newer "$_hv" "$RUNNING_VERSION"; then
      if set_env TUGRA_VERSION "$RUNNING_VERSION" && drop_digest_pins; then
        err "$ENV_FILE named $_hv, a release that was never installed here; TUGRA_VERSION is set back to the running $RUNNING_VERSION."
      else
        err "$ENV_FILE names $_hv, a release that was never installed here: set TUGRA_VERSION=$RUNNING_VERSION by hand."
      fi
    fi
  fi
  exit 1
}

# Upgrade path (`git pull && ./scripts/install.sh`): a re-run against an EXISTING stack — running, stopped
# (`compose down` for maintenance) or just a populated tugra_pg volume — takes the same mandatory pre-update
# restore point as the in-app updater BEFORE any image is pulled or any container recreated (the new hub runs
# migrations on boot, and they are not reversible). No existing postgres/volume = fresh install = nothing to
# protect. A failure aborts with the stack untouched; PRE_UPDATE_BACKUP=0 (in .env or env) is the only opt-out.
# shellcheck source=lib/snapshot.sh
. "$SCRIPT_DIR/lib/snapshot.sh"
# shellcheck source=lib/images.sh
. "$SCRIPT_DIR/lib/images.sh"
# Which release the hub-api + web containers REALLY run. A re-run on a half-updated install (an older updater wrote the
# new TUGRA_VERSION to .env, then its pull failed — typically a full disk) finds .env ahead of the containers: the running
# release is then the real "previous" one (restore point name, rollback anchor, what the disk estimate measures). The
# re-run itself needs nothing special: it pulls whatever .env names (or the TUGRA_VERSION given), whether or not those
# images are on this machine yet.
RUNNING_VERSION="$(running_stack_version 2>/dev/null || true)"
if [ -n "$RUNNING_VERSION" ] && [ "$PREV_VERSION" != latest ] && is_newer "$PREV_VERSION" "$RUNNING_VERSION"; then
  note "$ENV_FILE names $PREV_VERSION but the running stack is on $RUNNING_VERSION — a half-finished update; this run finishes it."
  PREV_VERSION="$RUNNING_VERSION"
fi
# 0 when every image the compose file resolves (the .env's TUGRA_VERSION and digest pins applied) is already on this machine.
all_images_local() {
  local imgs ref
  imgs="$(compose config --images 2>/dev/null | sed '/^[[:space:]]*$/d')" || return 1
  [ -n "$imgs" ] || return 1
  while IFS= read -r ref; do
    docker image inspect "$ref" >/dev/null 2>&1 || return 1
  done <<EOF_IMGS
$imgs
EOF_IMGS
  return 0
}
# DISK PREFLIGHT, before the restore point and before anything is pulled: room for the images in the Docker data root and
# for the bookkeeping here. When short, the safe image cleanup runs once and it is measured again; still short = stop with
# the numbers, the stack and the pre-run .env untouched. (TUGRA_DISK_CHECK=0 skips it; building from source has no pull.)
# A routine re-run (another domain, a flag) with every image already on this machine pulls nothing and needs no room, so
# the check only runs when at least one image compose uses is missing locally (an unreadable list = run it, to be safe).
# (An unpinned `latest` is a moving tag: the pull may fetch new layers, so it is always measured.)
DISK_TARGET="$(env_get TUGRA_VERSION | tr -d "\"' \r")"
if [ "$FORCE_BUILD" -eq 0 ] && { [ -z "$DISK_TARGET" ] || [ "$DISK_TARGET" = latest ] || ! all_images_local; }; then
  if ! disk_preflight "$PREV_VERSION" "$REPO_DIR" ""; then
    abort_untouched "$(disk_short_text)." "Nothing was pulled."
  fi
fi
pg_running() { [ -n "$(compose ps -q postgres 2>/dev/null | head -n1)" ]; }
pg_exists() {
  [ -n "$(compose ps -aq postgres 2>/dev/null | head -n1)" ] && return 0
  grep -Eq '(^|_)tugra_pg$' < <(docker volume ls -q 2>/dev/null)  # not a pipe: grep -q exiting early would SIGPIPE docker under pipefail
}
# Start ONLY postgres (--no-deps) and wait, bounded, until its docker healthcheck passes.
start_postgres() {
  compose up -d --no-deps postgres >"$LOGDIR/pg-start.log" 2>&1 || return 1
  _n=0
  while [ "$_n" -lt "${TUGRA_PG_TRIES:-30}" ]; do
    _pc="$(compose ps -q postgres 2>/dev/null | head -n1 || true)"
    if [ -n "$_pc" ]; then
      _ps="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$_pc" 2>/dev/null || true)"
      case "$_ps" in healthy|running) return 0 ;; esac
    fi
    _n=$((_n + 1)); sleep "${TUGRA_HEALTH_INTERVAL:-2}"
  done
  return 1
}
if pg_exists; then
  if snapshot_disabled; then
    warn "PRE_UPDATE_BACKUP=0 — upgrading WITHOUT a pre-update restore point."
  else
    if ! pg_running; then
      log "Existing database found but not running — starting only postgres to take the restore point…"
      start_postgres || abort_untouched "Could not start postgres to take the pre-update backup (see $LOGDIR/pg-start.log)." \
        "Fix the cause (disk space? corrupt volume?) and re-run, or set PRE_UPDATE_BACKUP=0 in $ENV_FILE to skip it (NOT recommended)."
    fi
    log "Taking a pre-update backup (database dump + .env copy)…"
    TUGRA_SNAPSHOT_ENV_SRC="${ENV_BEFORE:-$ENV_FILE}"
    _snap_to="$(env_get TUGRA_VERSION | tr -d "\"' \r")"
    if tugra_snapshot "$PREV_VERSION" "${TUGRA_VERSION:-${_snap_to:-$PREV_VERSION}}"; then
      ok "Restore point: $SNAPSHOT_PATH"
    else
      abort_untouched "Pre-update backup failed — no images pulled, no containers recreated." \
        "Fix the cause above (disk space? postgres unhealthy?) and re-run, or set PRE_UPDATE_BACKUP=0 in $ENV_FILE to skip it (NOT recommended)."
    fi
  fi
fi

# Pull failure policy: only a genuinely MISSING image (no arch/tag match — the hub/web images are amd64-only)
# on an UNPINNED install falls back to building this checkout. Any other failure (rate limit, network, auth),
# or any pinned TUGRA_VERSION, stops here — it must never silently turn into un-released checkout code.
pull_image_missing() { grep -qiE 'manifest unknown|not found|no matching manifest|manifest for .* not found' "$LOGDIR/pull.log" 2>/dev/null; }

# A container that compose will (re)create but that exists WITHOUT compose labels cannot be adopted: `compose up`
# aborts half-way ("container name already in use") and leaves the stack partly recreated — hub/postgres/redis
# created but never started. The agent self-update recreates itself with a plain `docker run` (not compose), so a
# server that ever clicked "Update agent" hits exactly this on its next installer run. The agent's identity and
# journal live in the tugra-agent-data volume, so removing the stale container is safe; compose then creates the
# managed one on the same volume.
reclaim_unmanaged_containers() {
  local svc name all managed
  for svc in agent; do
    name="tugra-${svc}-1"
    all="$(docker ps -a -q --filter "name=^/${name}\$" 2>/dev/null || true)"
    [ -n "$all" ] || continue
    managed="$(docker ps -a -q --filter "name=^/${name}\$" --filter "label=com.docker.compose.project" 2>/dev/null || true)"
    [ -z "$managed" ] || continue
    note "Container $name exists outside docker compose (an agent self-update recreated it) — removing it so compose can take over; its data stays in the tugra-agent-data volume."
    docker rm -f "$name" >/dev/null 2>&1 || warn "could not remove $name — if 'compose up' fails with a name conflict, remove it by hand and re-run."
  done
}
# Called by every `compose up` branch below. On a failure the stack may be PARTLY recreated: say so instead of exiting silently.
compose_up() {
  reclaim_unmanaged_containers
  if ! compose up -d "$@"; then
    err "docker compose up failed — the stack may be partly recreated (some containers 'Created' but not started)."
    err "Fix the cause above, then run: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE up -d"
    exit 1
  fi
}
# Pull the published images. The bundled agent is NOT pulled with `compose pull`: on an engine that uses the
# containerd image store that pull fetched the BuildKit attestation entries of the multi-platform tag and failed
# ("could not fetch content descriptor … application/vnd.in-toto+json … not found", then compose's misleading
# "must be built from source: docker compose build agent"). A plain `docker pull` of the tag does not (lib/images.sh).
pull_published_images() {
  compose pull postgres redis hub-api web || return 1
  _av="$(env_get TUGRA_VERSION | tr -d "\"' ")"
  pull_agent_image "${_av:-latest}" || return 1
  pull_updater_image "${_av:-latest}" || return 1
}
if [ "$FORCE_BUILD" -eq 1 ]; then
  log "Building images from source…"; compose_up --build
elif [ "$FORCE_PULL" -eq 1 ]; then
  pull_published_images || abort_untouched "Could not pull the published images (--pull)."
  compose_up --no-build
elif pull_published_images >"$LOGDIR/pull.log" 2>&1; then
  log "Using published images."; compose_up --no-build
elif [ -z "$(env_get TUGRA_VERSION)" ] && pull_image_missing && [ -f "$REPO_DIR/deploy/Dockerfile.hub" ]; then
  # No published image for this arch/tag (see $LOGDIR/pull.log). Build from this checkout. This is a full pnpm +
  # Next build and can take several minutes (and wants ~2 GB free RAM); it is NOT a hang.
  note "No published image available (see $LOGDIR/pull.log) — building from source instead."
  drop_digest_pins
  log "Building images from this checkout (several minutes; needs ~2 GB RAM)…"
  compose_up --build
else
  err "Could not pull the published images:"
  tail -n 5 "$LOGDIR/pull.log" >&2 2>/dev/null || true
  _pin="$(env_get TUGRA_VERSION)"   # read BEFORE abort_untouched restores the pre-run .env
  if [ -n "$_pin" ]; then
    abort_untouched "TUGRA_VERSION is pinned ($_pin), so the installer will not build unreleased code from this checkout. Retry once the registry is reachable, or pass --build to build deliberately."
  else
    abort_untouched "This looks like a registry/network problem, not a missing image. Retry, or pass --build to build from this checkout."
  fi
fi

# --- wait for health + print next steps -------------------------------------------------------------
# HEALTHY: 1 = passed, 0 = still failing after the timeout, 2 = could not verify (no curl AND no docker
# health to read). The final exit code reflects it so automation (and `curl … | sh`) can tell a failed install
# from a good one; 2 is NOT reported as "up" — it prints an explicit "could not verify" and exits 0.
#
# The probe targets the address the hub is actually published on: 127.0.0.1 for the default/wildcard bind, or
# the operator's specific HUB_BIND (a private-interface bind is unreachable via localhost, which used to make a
# healthy hub time out for 4 minutes and exit 1). Without curl it reads the container's docker healthcheck.
TUGRA_HEALTH_TRIES="${TUGRA_HEALTH_TRIES:-120}"
TUGRA_HEALTH_INTERVAL="${TUGRA_HEALTH_INTERVAL:-2}"
hub_probe_url() {
  _hb="$(env_get HUB_BIND)"
  case "$_hb" in
    ""|0.0.0.0|"::"|"[::]") _ph="127.0.0.1" ;;
    *:*) _ph="[${_hb#[}"; _ph="${_ph%]}]" ;;   # a specific IPv6 bind needs brackets in a URL
    *) _ph="$_hb" ;;
  esac
  printf 'http://%s:%s/health' "$_ph" "${HUB_PORT}"
}
# 0 = healthy, 1 = not (yet) healthy, 2 = cannot tell.
hub_healthy_once() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$(hub_probe_url)" >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v docker >/dev/null 2>&1; then
    _cid="$(compose ps -q hub-api 2>/dev/null | head -n1 || true)"
    [ -n "$_cid" ] || return 2
    _hs="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$_cid" 2>/dev/null || true)"
    case "$_hs" in healthy|running) return 0 ;; "") return 2 ;; *) return 1 ;; esac
  fi
  return 2
}
# Wait loop shared by the initial start and the post-rebind re-check. Sets HEALTHY (1/0/2).
wait_hub_healthy() {
  HEALTHY=1; _i=0
  until hub_healthy_once; do
    _rc=$?
    if [ "$_rc" = "2" ]; then HEALTHY=2; break; fi
    _i=$((_i + 1))
    if [ "$_i" -ge "$TUGRA_HEALTH_TRIES" ]; then printf '\r\033[K'; HEALTHY=0; warn "hub not healthy after ~$((TUGRA_HEALTH_TRIES * TUGRA_HEALTH_INTERVAL))s — check: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs hub-api"; break; fi
    case $((_i % 4)) in 0) _c='|' ;; 1) _c='/' ;; 2) _c='-' ;; 3) _c='\' ;; esac
    printf '\r  \033[38;5;179m%s\033[0m still starting… (%ss)' "$_c" "$((_i * TUGRA_HEALTH_INTERVAL))"
    sleep "$TUGRA_HEALTH_INTERVAL"
  done
  printf '\r\033[K'
}
step "Waiting for the hub to become healthy…"
HEALTHY=2
wait_hub_healthy

printf '\n'
if [ "$HEALTHY" = "0" ]; then
  warn "Tugra started, but the hub did not pass its health check yet (see the log hint above)."
elif [ "$HEALTHY" = "2" ]; then
  warn "Could not verify the hub's health (no curl, and no readable docker health status). Check: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE ps"
else
  log "Tugra is up."
fi

# --- Panel proxy: Tugra's own Traefik in front of the panel (reads the persisted .env) -----------------------------
# Two flavours, both through the hub image's print-proxy-setup (single source of the Traefik flags):
#   - bundled HTTPS (PANEL_TLS=1): https://<domain>, Let's Encrypt HTTP-01 (or the optional DNS-01 token).
#   - IP mode (PANEL_IP_ROUTE=1, a plain install): the panel on http://<ip>/ (port 80), no domain, no cert.
# Runs for a fresh enable AND a flag-less upgrade re-run. On a failure in the HTTPS flavour NOTHING else changes (no flag
# flip, no rebind) — the panel stays reachable on the host port. In IP mode the URLs already point at port 80, so a proxy
# that does not come up falls back to the raw ports (below) instead of leaving a panel nobody can open.
PANEL_UP=0; PANEL_PROXY_KIND=""
if [ "$HEALTHY" != "0" ]; then
  if [ "$(env_get PANEL_TLS)" = "1" ] && [ -n "$(env_get PANEL_DOMAIN)" ]; then PANEL_PROXY_KIND="tls"
  elif [ "$(env_get PANEL_IP_ROUTE | tr -d "\"' \r")" = "1" ]; then PANEL_PROXY_KIND="ip"; fi
fi
if [ -n "$PANEL_PROXY_KIND" ]; then
  _pd=""; _pe="$(env_get ACME_EMAIL)"
  [ "$PANEL_PROXY_KIND" = "tls" ] && _pd="$(env_get PANEL_DOMAIN)"
  _pip=""; [ "$PANEL_PROXY_KIND" = "ip" ] && _pip=1
  # DNS-01 creds (optional) — passed to the generator so it emits the le-dns resolver for a real cert while proxied.
  _pdp="$(env_has ACME_DNS_PROVIDER && env_get ACME_DNS_PROVIDER || true)"; _pdt="$(env_has ACME_DNS_TOKEN && env_get ACME_DNS_TOKEN || true)"
  if [ -n "$_pd" ] || [ -n "$_pip" ]; then
    if [ -n "$_pip" ]; then step "Starting Tugra's proxy so the panel answers on port 80…"; else step "Provisioning HTTPS for the panel ($_pd)…"; fi
    # The generated script embeds the DNS-01 token: keep it in the private 0700 dir at 0600 and delete it on
    # exit (the EXIT trap above), never a leftover default-permission file in /tmp.
    _setup="$(umask 077; mktemp "$LOGDIR/panel-setup.XXXXXX")"
    # Single source of truth: the hub image prints the Traefik setup script (panel router); we run it as root.
    # The DNS token travels in the environment (`-e ACME_DNS_TOKEN` with no value forwards it), never in argv.
    if ACME_DNS_TOKEN="$_pdt" compose run --rm --no-deps -T -e PANEL_DOMAIN="$_pd" -e PANEL_IP_ROUTE="$_pip" -e ACME_EMAIL="$_pe" -e ACME_DNS_PROVIDER="$_pdp" -e ACME_DNS_TOKEN \
        --entrypoint node hub-api dist/deploy/print-proxy-setup.js >"$_setup" 2>"$LOGDIR/panel-setup.log" && [ -s "$_setup" ]; then
      if sh "$_setup" >"$LOGDIR/panel-run.log" 2>&1; then
        # The router is up immediately (self-signed until Let's Encrypt issues over :80). Resolve the panel
        # host to loopback so we test the local Traefik regardless of external DNS; -k since the cert may be
        # the interim self-signed one until DNS + :80 let ACME complete.
        i=0
        while [ "$i" -lt "${TUGRA_PANEL_TRIES:-45}" ]; do
          if [ -n "$_pip" ]; then
            curl -fsS --max-time 4 "http://127.0.0.1/health" >/dev/null 2>&1 && { PANEL_UP=1; break; }  # host-less route -> the hub's /health
          else
            curl -fsSk --resolve "$_pd:443:127.0.0.1" "https://$_pd/health" >/dev/null 2>&1 && { PANEL_UP=1; break; }
          fi
          i=$((i + 1)); sleep "${TUGRA_PANEL_INTERVAL:-2}"
        done
      fi
    fi
    rm -f "$_setup"; _setup=""
    if [ "$PANEL_UP" = "1" ] && [ -n "$_pip" ]; then
      ok "Panel proxy is live: the panel answers on port 80 (only :80/:443 need to be open to the outside)."
    elif [ "$PANEL_UP" = "1" ]; then
      ok "Panel HTTPS router is live (cert issues once $_pd resolves here and :80/:443 are reachable)."
      # Traefik reaches the hub/web over the tugra-panel docker network, so the raw host ports do not need to be
      # internet-exposed. Move a still-0.0.0.0 bind to loopback (opt out: --keep-raw-ports / an explicit
      # HUB_BIND/WEB_BIND). Only after the router is verified live; on ANY failure here the old bind is restored
      # and the install stays successful (the panel is reachable either way).
      if [ "$KEEP_RAW_PORTS" != "1" ] && [ -z "${HUB_BIND:-}" ] && [ -z "${WEB_BIND:-}" ] \
         && { [ "$(env_get HUB_BIND)" = "0.0.0.0" ] || [ "$(env_get WEB_BIND)" = "0.0.0.0" ]; }; then
        _ohb="$(env_get HUB_BIND)"; _owb="$(env_get WEB_BIND)"; _hprev="$HEALTHY"
        log "Binding the raw hub/web ports to 127.0.0.1 (the bundled TLS proxy reaches them privately)…"
        [ "$_ohb" = "0.0.0.0" ] && set_env HUB_BIND 127.0.0.1
        [ "$_owb" = "0.0.0.0" ] && set_env WEB_BIND 127.0.0.1
        if compose up -d --no-deps hub-api web >"$LOGDIR/rebind.log" 2>&1 && { wait_hub_healthy; [ "$HEALTHY" = "1" ]; }; then
          ok "Raw ports are now loopback-only."
        else
          warn "Could not re-bind the raw ports to loopback — restoring the previous bind (the install is otherwise fine)."
          [ "$_ohb" = "0.0.0.0" ] && set_env HUB_BIND "$_ohb"
          [ "$_owb" = "0.0.0.0" ] && set_env WEB_BIND "$_owb"
          compose up -d --no-deps hub-api web >>"$LOGDIR/rebind.log" 2>&1 || true
          HEALTHY="$_hprev"   # the hub was verified before the rebind attempt; do not flip a good install to failed
        fi
      fi
    elif [ -n "$_pip" ] && [ "$IP_MODE_FRESH" != "1" ]; then
      # An EXISTING IP-mode install (a flag-less upgrade re-run): never move it. A slow proxy recreate or a transient
      # probe miss must not turn a working http://<ip>/ panel into raw public ports; agents and bookmarks keep working.
      warn "Tugra's proxy did not answer on port 80 yet (setup log: $LOGDIR/panel-run.log). The panel's address was left exactly as it is."
      note "Check:  docker logs tugra-proxy  ·  is another service on :80?  Re-run this installer once it is fixed."
    elif [ -n "$_pip" ]; then
      # FRESH install: the URLs already name port 80, so a proxy that did not come up must not leave a panel nobody can open: put the
      # classic raw-port setup back (the same keys --raw-ports writes) and recreate hub/web on it.
      warn "Tugra's proxy did not come up on port 80 (setup log: $LOGDIR/panel-run.log) — falling back to the raw ports so the panel stays reachable."
      _fbh="$(printf '%s' "$WEB_URL" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#[/:].*$##')"
      set_env HUB_PUBLIC_URL "http://$_fbh:$HUB_PORT"; set_env WEB_PUBLIC_URL "http://$_fbh:$WEB_PORT"
      set_env COOKIE_SECURE false; set_env HUB_TRUSTED_PROXY false; set_env PANEL_IP_ROUTE 0
      set_env HUB_BIND 0.0.0.0; set_env WEB_BIND 0.0.0.0
      HUB_URL="http://$_fbh:$HUB_PORT"; WEB_URL="http://$_fbh:$WEB_PORT"; HUB_TRUSTED_PROXY="false"; IP_MODE=0; PANEL_PROXY_KIND=""
      if compose up -d --no-deps hub-api web >"$LOGDIR/fallback.log" 2>&1; then wait_hub_healthy; else HEALTHY=0; fi
      note "Check why :80 failed:  docker logs tugra-proxy  ·  is another service on :80? Then re-run with --raw-ports to keep this setup."
    else
      warn "Panel HTTPS didn't come up yet — the install is fine; the panel is still reachable on the host port."
      note "Check: docker logs tugra-proxy  ·  DNS for $_pd -> this host  ·  :80/:443 reachable (setup log: $LOGDIR/panel-run.log)"
      note "Behind Cloudflare's proxy: set SSL/TLS mode 'Full' and turn 'Always Use HTTPS' off while the first cert issues; no token needed (optional: --acme-dns-cloudflare-file <path>)."
      note "Reach it meanwhile:  ssh -L 3001:127.0.0.1:3001 <this-host>  then open http://localhost:3001"
      note "Disable auto-TLS anytime:  re-run with --no-auto-tls  (nothing else is changed on failure)."
    fi
  fi
fi

# --- old release images: every release leaves ~8 GB (hub + web + agent + updater) that nothing removed ----------
# Opt-in removal (--prune-images); otherwise just say how much could be freed. Only Tugra's own release images older
# than the previous release are ever candidates (lib/images.sh); a failure here never fails the install.
if [ "$HEALTHY" != "0" ] && [ "$FORCE_BUILD" -eq 0 ]; then
  _cur="$(env_get TUGRA_VERSION | tr -d "\"' ")"; _cur="${_cur:-latest}"
  if [ "$PRUNE_IMAGES" = "1" ]; then
    prune_release_images "$_cur" "$PREV_VERSION" || warn "image cleanup did not finish (the install itself is fine)."
  else
    _ps="$(prune_summary "$_cur" "$PREV_VERSION" 2>/dev/null || true)"
    _pn="${_ps%% *}"; _pb="${_ps#* }"
    case "$_pn" in ''|*[!0-9]*) _pn=0 ;; esac
    if [ "$_pn" -gt 0 ]; then
      note "$_pn old Tugra release image(s), about $(_img_human "${_pb:-0}"), are no longer needed. Remove them with: re-run this installer with --prune-images (the in-app updater cleans up after each update by itself)."
    fi
  fi
fi

printf '  Web UI:  %s\n' "$WEB_URL"
printf '  Hub API: %s\n' "$HUB_URL"
if [ "$IP_MODE" = "1" ] && [ "$PANEL_UP" = "1" ]; then
  printf '  \033[1mOpen %s in your browser\033[0m — Tugra serves the panel on port 80 itself, so only ports 80 and 443 need to be open.\n' "$WEB_URL"
  if [ "$IP_PRIVATE_NOTICE" = "1" ]; then
    printf '  \033[33mNote: %s is a private address, reachable only from inside your network. On a cloud server re-run with --public-ip <public IP>.\033[0m\n' "$WEB_URL"
  fi
  printf '  Have a domain? Point its DNS at this server, then set it in Settings -> Instance -> Panel domain (free HTTPS, no token),\n'
  printf '  or re-run this installer with --domain <host>. (A cloud server behind NAT needs --public-ip <ip> for a reachable URL.)\n'
elif [ "$(env_get PANEL_TLS)" = "1" ]; then
  [ "$PANEL_UP" = "1" ] && printf "  HTTPS is provisioned automatically (Let's Encrypt). Point %s's DNS at this host; the cert issues on the first reachable request.\n" "$(env_get PANEL_DOMAIN)"
  _hb="$(env_get HUB_BIND)"; _wb="$(env_get WEB_BIND)"
  if [ "$PANEL_UP" = "1" ] && [ "${_hb:-0.0.0.0}" = "0.0.0.0" ]; then
    printf '  Raw hub/web ports are still bound to 0.0.0.0 (--keep-raw-ports / explicit HUB_BIND). Keep :80/:443 reachable; firewall :%s/:%s (Docker-published ports bypass ufw).\n' "$HUB_PORT" "$WEB_PORT"
  else
    printf '  Raw hub/web ports bound to %s/%s. Keep :80/:443 reachable; the raw ports are not needed from outside.\n' "${_hb:-127.0.0.1}" "${_wb:-127.0.0.1}"
  fi
elif [ "$HUB_TRUSTED_PROXY" = "true" ]; then
  _hb="$(env_get HUB_BIND)"
  printf '  Ports bound to %s. With a trusted proxy the hub honors X-Forwarded-For, so the raw ports must\n' "${_hb:-127.0.0.1}"
  printf '  reach ONLY the proxy. Same-host proxy: the 127.0.0.1 default is correct. Proxy on another host:\n'
  printf '  set HUB_BIND/WEB_BIND to this box private IP and firewall 3000/3001 (Docker-published ports bypass ufw).\n'
else
  printf "  For TLS + a public domain: re-run with --domain <host> (automatic HTTPS), or front the stack with your own reverse proxy.\n"
fi
printf '  Back up the hub: keep %s offsite and schedule a pg_dump of the hub database (see tugra.io/docs/disaster-recovery).\n' "$ENV_FILE"
printf '  Open the Web UI and create the owner account (enter the setup code if one is shown below). This machine connects itself as your first server; add more from Settings -> Servers.\n'
printf '  \033[2mGuides: https://tugra.io/docs/first-setup (add a server: https://tugra.io/docs/add-a-server).\033[0m\n'
# Trust-wedge hints: say plainly what is ON/OFF and how to change it.
if ! env_has LOCAL_SERVER_PUBLIC_IP; then
  printf '  \033[2mPublic IP: found automatically once this machine connects (its network interface, then the cloud provider metadata; no outbound probe). Behind NAT or a floating IP, pin it with --public-ip <ip> or LOCAL_SERVER_PUBLIC_IP in %s.\033[0m\n' "$ENV_FILE"
fi
if [ "$(env_get TUGRA_UPDATE_CHECKS)" = "0" ]; then
  printf '  \033[2mUpdate checks are OFF (--no-update-checks). Watch GitHub releases for security advisories; re-enable with --enable-update-checks.\033[0m\n'
else
  printf '  \033[2mUpdate checks are ON: a signed release manifest is fetched hourly (no identifiers sent); the owner sees new releases in Settings -> Updates. Turn off with --no-update-checks.\033[0m\n'
fi
# Email is OUTBOUND-only and optional: with no MAIL_HOST the hub sends nothing (reset/verify links go to the hub
# log). `|| true` + quote-stripping keep this safe under `set -euo pipefail` and for a blank `MAIL_HOST=""`.
_mail_host="$( { env_get MAIL_HOST || true; } | tr -d "\"' " )"
if [ -z "$_mail_host" ]; then
  printf '  \033[2mEmail: not configured — set MAIL_* in %s to enable password reset / invites (see tugra.io/docs/email).\033[0m\n' "$ENV_FILE"
fi
if [ "$(env_get TUGRA_TELEMETRY)" = "0" ]; then
  printf '  \033[2mAnonymous usage stats are OFF.\033[0m\n'
else
  printf '  \033[2mAnonymous usage stats are ON (counts only: servers, apps, deploys — no names, IPs or secrets). Turn off anytime with --no-telemetry or in Settings.\033[0m\n'
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

# Exit non-zero if the hub never became healthy, so `curl … | sh` and CI can detect a failed install.
[ "$HEALTHY" = "0" ] && exit 1
exit 0
