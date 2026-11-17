#!/usr/bin/env bash
#
# Checkout consistency: keep the install directory's git checkout in step with the compose file and scripts that the
# in-app updater (scripts/lib/hostfiles.sh) writes into it. Sourced by scripts/lib/hostfiles.sh (the updater sidecar)
# and scripts/install.sh.
#
# The problem it solves: the updater replaces deploy/docker-compose.yml and scripts/**/*.sh with the release's signed
# copies, so a checkout of the repo is left "dirty" although every file is byte-identical to the release commit. git
# then refuses `git pull` and `git checkout <tag>` ("Your local changes ... would be overwritten"). co_sync moves the
# checkout to the release tag when - and only when - that is provably a no-op for the managed files:
#   - the release commit is the tag v<version> (fetched when it is not in the repo yet and fetching is allowed;
#     offline or unreachable is a graceful "skipped", never an error),
#   - every dirty managed path (compose file, scripts/*.sh, scripts/lib/*.sh) has exactly the content the commit has
#     (and, when the caller supplies the signed list, every listed path is byte-identical in the commit too).
# A managed file that differs from the commit is a real local edit: nothing in git is touched and the reason is
# reported. Other dirty paths (an untracked override file, an edit elsewhere) are never discarded: git's own checks
# stay in force, and when they refuse the move, git is left exactly as it was.
#
# The caller provides REPO_DIR; log() is used when defined. CO_* results:
#   CO_RESULT  clean | synced | not-a-checkout | skipped
#   CO_NOTE    operator-facing reason when skipped
#   CO_COMMIT  the release commit
# co_sync returns 0 when the checkout is consistent afterwards (or is not a checkout at all), 1 when it is left as is.

CO_RESULT=""
CO_NOTE=""
CO_COMMIT=""
CO_TOUCHED=0   # 1 once git was asked to write anything (fetch / index / HEAD): ownership is repaired on every exit then
CO_OLD=""
CO_DIRTY_CODE=()
CO_DIRTY_PATH=()

_co_log() { if declare -F log >/dev/null 2>&1; then log "$*"; else printf '%s\n' "$*"; fi; }

# --safe.directory: the sidecar runs as root against a checkout that belongs to another user.
co_git() { GIT_TERMINAL_PROMPT=0 git -c safe.directory="$REPO_DIR" -C "$REPO_DIR" "$@"; }

_co_sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else return 1; fi
}
_co_file_sha() { _co_sha256_stdin < "$1" 2>/dev/null; }
_co_blob_sha() { co_git cat-file blob "$1:$2" 2>/dev/null | _co_sha256_stdin; }

# The managed-path rule (mirrors hf_path_ok in hostfiles.sh and isHostFilePath in host-files.ts).
co_path_ok() {
  local p="$1"
  case "$p" in *..*|/*|*\\*) return 1 ;; esac
  [ "$p" = "deploy/docker-compose.yml" ] && return 0
  local re='^scripts/(lib/)?[A-Za-z0-9][A-Za-z0-9._-]*[.]sh$'
  [[ "$p" =~ $re ]]
}

# True when REPO_DIR is a usable git checkout with a commit.
co_is_checkout() {
  command -v git >/dev/null 2>&1 || return 1
  [ -e "$REPO_DIR/.git" ] || return 1
  co_git rev-parse -q --verify HEAD >/dev/null 2>&1
}

# Fills CO_DIRTY_CODE / CO_DIRTY_PATH from `git status`. Returns 1 when git cannot say.
co_dirty() {
  local entry from
  CO_DIRTY_CODE=(); CO_DIRTY_PATH=()
  co_git status --porcelain=v1 -z --untracked-files=all >/dev/null 2>&1 || return 1
  while IFS= read -r -d '' entry; do
    CO_DIRTY_CODE+=("${entry:0:2}"); CO_DIRTY_PATH+=("${entry:3}")
    case "${entry:0:2}" in
      R*|C*) IFS= read -r -d '' from || true; CO_DIRTY_CODE+=(" D"); CO_DIRTY_PATH+=("$from") ;;
    esac
  done < <(co_git status --porcelain=v1 -z --untracked-files=all 2>/dev/null)
  return 0
}

# A merge/rebase/cherry-pick/bisect in progress: moving HEAD under it would corrupt the operator's work.
co_busy() {
  local gd f
  gd="$(co_git rev-parse --absolute-git-dir 2>/dev/null)" || return 0
  for f in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply BISECT_LOG; do
    [ -e "$gd/$f" ] && return 0
  done
  return 1
}

# co_resolve_commit <version> <allow-fetch 0|1>: sets CO_COMMIT to the commit of tag v<version>, fetching just that
# tag (shallow when the checkout is shallow) when it is missing and fetching is allowed. Bounded in time.
co_resolve_commit() {
  local tag="v${1#v}" c depth="" t="" sshenv=()
  CO_COMMIT=""
  c="$(co_git rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null)" && [ -n "$c" ] && { CO_COMMIT="$c"; return 0; }
  [ "${2:-0}" = "1" ] || return 1
  [ "$(co_git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ] && depth="--depth=1"
  command -v timeout >/dev/null 2>&1 && t="timeout 120"
  # A default non-interactive ssh command only when the operator configured none: GIT_SSH_COMMAND in the environment
  # outranks core.sshCommand (a deploy key's `-i`), so setting it would silently drop working credentials.
  if [ -z "${GIT_SSH_COMMAND:-}" ] && [ -z "$(co_git config --get core.sshCommand 2>/dev/null)" ]; then
    sshenv=(GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=20")
  fi
  CO_TOUCHED=1
  # shellcheck disable=SC2086  # $t / $depth are intentionally word-split (empty or one word / two words)
  $t env GIT_TERMINAL_PROMPT=0 ${sshenv[@]+"${sshenv[@]}"} \
    git -c safe.directory="$REPO_DIR" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 -C "$REPO_DIR" \
    fetch -q $depth --no-tags --no-write-fetch-head origin "+refs/tags/$tag:refs/tags/$tag" >/dev/null 2>&1 || return 1
  c="$(co_git rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null)" && [ -n "$c" ] || return 1
  CO_COMMIT="$c"
}

# Hand git's new files/dirs back to the checkout's owner when running as root (the sidecar), so a later `git pull`
# by the operator can still write them. Best-effort.
_co_fix_owner() {
  local old="${1:-}" new="${2:-}" owner p d
  [ "$(id -u 2>/dev/null)" = "0" ] || return 0
  owner="$(stat -c '%u:%g' "$REPO_DIR/.git" 2>/dev/null || stat -f '%u:%g' "$REPO_DIR/.git" 2>/dev/null)" || return 0
  [ -n "$owner" ] || return 0
  chown -R "$owner" "$REPO_DIR/.git" 2>/dev/null || true
  while IFS= read -r -d '' p; do
    [ -e "$REPO_DIR/$p" ] || continue
    chown "$owner" "$REPO_DIR/$p" 2>/dev/null || true
    d="$(dirname "$p")"
    while [ "$d" != "." ] && [ "$d" != "/" ]; do chown "$owner" "$REPO_DIR/$d" 2>/dev/null || true; d="$(dirname "$d")"; done
  done < <([ -n "$old" ] && [ -n "$new" ] && co_git diff --name-only -z "$old" "$new" 2>/dev/null)
}

# co_sync <version> [<signed list file: `<sha256>  <path>` lines>] [<allow-fetch 0|1, default 1>]
# Whatever way it ends, anything git wrote as root (fetch, index, HEAD) is handed back to the checkout's owner.
co_sync() {
  local rc
  CO_TOUCHED=0; CO_OLD=""
  _co_sync_run "$@"; rc=$?
  if [ "$CO_TOUCHED" = 1 ]; then _co_fix_owner "$CO_OLD" "$CO_COMMIT"; fi
  return "$rc"
}

_co_sync_run() {
  local version="$1" list="${2:-}" fetch="${3:-1}" i code path want got branch old rtip err sha p rescue=""
  local managed=() mv=()
  CO_RESULT=""; CO_NOTE=""; CO_COMMIT=""
  if ! co_is_checkout; then CO_RESULT="not-a-checkout"; CO_NOTE="not a git checkout"; return 0; fi
  if ! co_dirty; then CO_RESULT="skipped"; CO_NOTE="git status failed"; return 1; fi
  for i in "${!CO_DIRTY_PATH[@]}"; do
    co_path_ok "${CO_DIRTY_PATH[$i]}" && managed+=("${CO_DIRTY_PATH[$i]}")
  done
  if [ "${#managed[@]}" -eq 0 ]; then CO_RESULT="clean"; return 0; fi
  if co_busy; then CO_RESULT="skipped"; CO_NOTE="a merge, rebase or cherry-pick is in progress in the checkout"; return 1; fi
  _co_version_ok "$version" || { CO_RESULT="skipped"; CO_NOTE="no release version to match the checkout against"; return 1; }
  if ! co_resolve_commit "$version" "$fetch"; then
    CO_RESULT="skipped"
    CO_NOTE="the release tag v${version#v} is not in the checkout and could not be fetched (offline?); the compose/scripts are correct, git still shows them as modified"
    return 1
  fi
  # Every dirty managed path must be byte-identical to the release commit; anything else is a real local edit.
  for path in "${managed[@]}"; do
    want="$(_co_blob_sha "$CO_COMMIT" "$path")"
    got="$(_co_file_sha "$REPO_DIR/$path")"
    if [ -z "$want" ] || [ -z "$got" ] || [ "$want" != "$got" ]; then
      CO_RESULT="skipped"
      CO_NOTE="$path differs from release v${version#v}: treated as a local edit, git was left untouched"
      return 1
    fi
  done
  # The signed list (when given) must describe exactly this commit, so the tag is the release and not a lookalike.
  if [ -n "$list" ] && [ -r "$list" ]; then
    while read -r sha p; do
      [ -n "$p" ] || continue
      want="$(_co_blob_sha "$CO_COMMIT" "$p")"
      if [ "$want" != "$sha" ]; then
        CO_RESULT="skipped"; CO_NOTE="tag v${version#v} does not match the signed release content ($p), git was left untouched"; return 1
      fi
    done < "$list"
  fi
  old="$(co_git rev-parse HEAD)"; CO_OLD="$old"
  CO_TOUCHED=1
  # 1. Put the managed paths into the index at the commit's content (the worktree already has it).
  if ! err="$(co_git checkout -q "$CO_COMMIT" -- "${managed[@]}" 2>&1)"; then
    co_git reset -q -- "${managed[@]}" >/dev/null 2>&1 || true
    CO_RESULT="skipped"; CO_NOTE="could not stage the release files: $(printf '%s' "$err" | head -n1)"; return 1
  fi
  # 2. Move HEAD. A branch that is a plain fast-forward (or has no local commits) keeps its name, so `git pull` keeps
  #    working; anything else is detached at the release commit.
  branch="$(co_git symbolic-ref -q --short HEAD 2>/dev/null || true)"
  mv=(--detach)
  if [ -n "$branch" ]; then
    # Keep the name only when `git pull` still fast-forwards afterwards: the release is ahead of the branch, or the
    # branch has no commits of its own and the release sits on origin's line (a shallow checkout cannot show that
    # ancestry, so an up-to-date branch there keeps its name).
    rtip="$(co_git rev-parse -q --verify "refs/remotes/origin/$branch" 2>/dev/null || true)"
    if co_git merge-base --is-ancestor "$old" "$CO_COMMIT" >/dev/null 2>&1 \
       || { [ -n "$rtip" ] && co_git merge-base --is-ancestor "$old" "$rtip" >/dev/null 2>&1 \
            && { co_git merge-base --is-ancestor "$CO_COMMIT" "$rtip" >/dev/null 2>&1 \
                 || { [ "$rtip" = "$old" ] && [ "$(co_git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; }; }; }; then
      mv=(-B "$branch")
    fi
  elif [ -n "$(co_git rev-list -n1 "$old" --not --branches --tags --remotes 2>/dev/null)" ]; then
    # Detached on a commit no ref reaches (local commits on a tag install): moving away would orphan them and drop
    # their files from the worktree, so give them a branch first.
    rescue="tugra-local-${old:0:8}"
    if co_git branch -q "$rescue" "$old" >/dev/null 2>&1; then _co_log "git checkout: local commits not on any branch were kept on branch $rescue"; else rescue=""; fi
  fi
  if ! err="$(co_git checkout -q "${mv[@]}" "$CO_COMMIT" 2>&1)"; then
    [ -z "$rescue" ] || co_git branch -q -D "$rescue" >/dev/null 2>&1 || true
    co_git reset -q -- "${managed[@]}" >/dev/null 2>&1 || true
    CO_RESULT="skipped"; CO_NOTE="git refused to move the checkout to v${version#v} (local changes in the way), left as it was: $(printf '%s' "$err" | head -n1)"; return 1
  fi
  if [ -n "$(co_git status --porcelain=v1 --untracked-files=all -- "${managed[@]}" 2>/dev/null)" ]; then
    CO_RESULT="skipped"; CO_NOTE="the checkout moved to v${version#v} but some compose/scripts still show as modified"; return 1
  fi
  CO_RESULT="synced"
  return 0
}

# A release version as it appears in a tag name: no whitespace/slashes, same charset the updater accepts.
_co_version_ok() { local re='^[0-9A-Za-z][0-9A-Za-z.+-]*$'; [[ "${1#v}" =~ $re ]] && [ "${#1}" -le 64 ]; }

# co_report: one operator-facing line for the last co_sync.
co_report() {
  case "$CO_RESULT" in
    synced) _co_log "git checkout: moved to release tag v${1#v} (${CO_COMMIT:0:8}); compose and scripts are clean in git" ;;
    skipped) _co_log "git checkout: $CO_NOTE" ;;
  esac
}
