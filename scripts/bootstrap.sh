#!/bin/sh
# Tugra one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/SimerayCom/tugra/main/scripts/bootstrap.sh | sh
#
# It installs the prerequisites it can (git), clones the repo, and runs
# scripts/install.sh — which installs Docker if missing and brings the stack up,
# so a fresh Linux box goes from nothing to a running Tugra in one command.
#
# Pass installer flags through after `--`, e.g. a TLS domain:
#   curl -fsSL .../bootstrap.sh | sh -s -- --domain tugra.example.com
#
# Prefer to read before you run (recommended for any root-level installer)? Clone first:
#   git clone https://github.com/SimerayCom/tugra.git && cd tugra && less scripts/install.sh && ./scripts/install.sh
set -eu

REPO_URL="${TUGRA_REPO_URL:-https://github.com/SimerayCom/tugra.git}"
REPO_REF="${TUGRA_REF:-main}"
DIR="${TUGRA_DIR:-tugra}"

say() { printf '\033[36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- prerequisite: git (needed to fetch the repo; install.sh handles Docker) ---
if ! command -v git >/dev/null 2>&1; then
  say "Installing git…"
  if   command -v apt-get >/dev/null 2>&1; then apt-get update -y >/dev/null 2>&1 && apt-get install -y git >/dev/null 2>&1
  elif command -v dnf     >/dev/null 2>&1; then dnf install -y git >/dev/null 2>&1
  elif command -v yum     >/dev/null 2>&1; then yum install -y git >/dev/null 2>&1
  elif command -v apk     >/dev/null 2>&1; then apk add --no-cache git >/dev/null 2>&1
  elif command -v pacman  >/dev/null 2>&1; then pacman -Sy --noconfirm git >/dev/null 2>&1
  elif command -v zypper  >/dev/null 2>&1; then zypper -n install git >/dev/null 2>&1
  else die "git is required and no supported package manager was found. Install git, then re-run."
  fi
  command -v git >/dev/null 2>&1 || die "git install failed — install it manually, then re-run."
fi

# --- fetch (clone fresh, or fast-forward an existing checkout) ---
if [ -d "$DIR/.git" ]; then
  say "Updating existing checkout in ./$DIR …"
  git -C "$DIR" fetch --depth 1 origin "$REPO_REF" >/dev/null 2>&1 || true
  git -C "$DIR" checkout -q "$REPO_REF" 2>/dev/null || true
  git -C "$DIR" reset --hard "origin/$REPO_REF" >/dev/null 2>&1 || true
else
  say "Cloning $REPO_URL …"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$DIR" >/dev/null 2>&1 || git clone "$REPO_URL" "$DIR"
fi

# --- run the installer (it installs Docker if missing + brings the stack up) ---
# One-command context = the operator opted in, so don't re-prompt for the Docker install.
cd "$DIR"
say "Running the installer…"
TUGRA_ASSUME_YES=1 exec ./scripts/install.sh "$@"
