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
# Pin what you run: TUGRA_REF may be a branch, a tag or a full commit SHA (default: main), and
# TUGRA_SHA256=<hex> additionally verifies scripts/install.sh before it is executed:
#   curl -fsSL .../bootstrap.sh | TUGRA_REF=v0.1.0 TUGRA_SHA256=<hex> sh
#
# Prefer to read before you run (recommended for any root-level installer)? Clone first:
#   git clone https://github.com/SimerayCom/tugra.git && cd tugra && less scripts/install.sh && ./scripts/install.sh
set -eu

REPO_URL="${TUGRA_REPO_URL:-https://github.com/SimerayCom/tugra.git}"
REPO_REF="${TUGRA_REF:-main}"
DIR="${TUGRA_DIR:-tugra}"

say() { printf '\033[38;5;179m==>\033[0m %s\n' "$*"; }
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
# is_branch_fetch: after `fetch origin REF`, true when REF is a BRANCH (its remote-tracking ref points at what
# was just fetched). Only then do we create a local branch tracking origin, so `git pull` keeps working;
# a tag or a commit SHA is checked out detached (upgrade by re-running bootstrap with a new TUGRA_REF).
is_branch_fetch() {
  _tip="$(git -C "$DIR" rev-parse -q --verify "refs/remotes/origin/$REPO_REF" 2>/dev/null)" || return 1
  [ "$_tip" = "$(git -C "$DIR" rev-parse -q --verify FETCH_HEAD 2>/dev/null)" ]
}

# Only a repo that has a commit counts as an existing checkout (a half-made `git init` from a failed run does not).
if [ -d "$DIR/.git" ] && git -C "$DIR" rev-parse -q --verify HEAD >/dev/null 2>&1; then
  say "Updating existing checkout in ./$DIR …"
  # Fail loud: refuse to install a STALE checkout when the fetch fails (network / bad TUGRA_REF), instead
  # of swallowing it with `|| true` and silently installing old code.
  git -C "$DIR" fetch --depth 1 origin "$REPO_REF" >/dev/null 2>&1 \
    || die "could not fetch origin/$REPO_REF — check your network or TUGRA_REF; refusing to install a stale checkout"
  # Don't silently discard an operator's local edits (the old `reset --hard` did).
  if git -C "$DIR" rev-parse --verify -q HEAD >/dev/null && ! git -C "$DIR" diff --quiet HEAD 2>/dev/null; then
    die "./$DIR has uncommitted local changes — commit/stash them, or set TUGRA_DIR to a fresh path, then re-run"
  fi
  if is_branch_fetch; then
    git -C "$DIR" checkout -q -B "$REPO_REF" --track "origin/$REPO_REF" >/dev/null 2>&1 \
      || die "could not check out origin/$REPO_REF in ./$DIR"
  else
    git -C "$DIR" checkout -q -B "$REPO_REF" FETCH_HEAD >/dev/null 2>&1 \
      || die "could not check out origin/$REPO_REF in ./$DIR"
  fi
else
  say "Fetching $REPO_URL @ $REPO_REF …"
  # Fetch BY REF (branch, tag or full commit SHA — `clone --branch` rejects a SHA). No fallback to a plain
  # clone: a bad TUGRA_REF must fail loudly, never silently install the default branch.
  _made=0; [ -e "$DIR" ] || _made=1
  _madegit=0; [ -d "$DIR/.git" ] || _madegit=1
  # A half-made checkout must not linger (an unborn .git would wedge the next run): remove what THIS run created.
  fresh_die() {
    if [ "$_made" = 1 ]; then rm -rf "$DIR"; elif [ "$_madegit" = 1 ]; then rm -rf "$DIR/.git"; fi
    die "$@"
  }
  mkdir -p "$DIR" || die "could not create ./$DIR"
  git -C "$DIR" init -q || fresh_die "git init failed in ./$DIR"
  # Idempotent over a leftover .git that already has an origin.
  { git -C "$DIR" remote add origin "$REPO_URL" 2>/dev/null || git -C "$DIR" remote set-url origin "$REPO_URL"; } \
    || fresh_die "could not set remote $REPO_URL"
  git -C "$DIR" fetch --depth 1 origin "$REPO_REF" >/dev/null 2>&1 \
    || fresh_die "could not fetch TUGRA_REF=$REPO_REF from $REPO_URL — check the ref and your network"
  if is_branch_fetch; then
    # A branch: local branch tracking origin/<ref>, so the documented `git pull && ./scripts/install.sh` works.
    git -C "$DIR" checkout -q -B "$REPO_REF" --track "origin/$REPO_REF" >/dev/null 2>&1 \
      || fresh_die "could not check out TUGRA_REF=$REPO_REF in ./$DIR"
  else
    git -C "$DIR" checkout -q FETCH_HEAD >/dev/null 2>&1 \
      || fresh_die "could not check out TUGRA_REF=$REPO_REF in ./$DIR"
  fi
fi

# Optional integrity pin: TUGRA_SHA256=<hex> must equal the sha256 of scripts/install.sh at the fetched ref
# (publish the expected value alongside the release). Mismatch aborts BEFORE the installer runs as root.
if [ -n "${TUGRA_SHA256:-}" ]; then
  if   command -v sha256sum >/dev/null 2>&1; then _got="$(sha256sum "$DIR/scripts/install.sh" | cut -d' ' -f1)"
  elif command -v shasum    >/dev/null 2>&1; then _got="$(shasum -a 256 "$DIR/scripts/install.sh" | cut -d' ' -f1)"
  else die "TUGRA_SHA256 is set but neither sha256sum nor shasum is available"
  fi
  [ "$_got" = "$TUGRA_SHA256" ] || die "scripts/install.sh checksum mismatch (expected $TUGRA_SHA256, got $_got) — refusing to run it"
fi

# --- run the installer (it installs Docker if missing + brings the stack up) ---
cd "$DIR"
say "Running the installer…"
exec ./scripts/install.sh "$@"
