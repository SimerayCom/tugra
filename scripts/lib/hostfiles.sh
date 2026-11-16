#!/usr/bin/env bash
#
# Host files: the compose file and installer/updater scripts that live in the operator's checkout (outside every
# container image). Sourced by scripts/update.sh (the tugra-updater sidecar) so an in-app update can apply a release
# that changes them, instead of requiring `git pull && ./scripts/install.sh`.
#
# TRUST MODEL — the sidecar verifies everything itself and never takes file content (or a manifest) from the hub or
# Redis. Both of those only carry the target VERSION and the sha256 the hub read from its signature-verified
# versions.json (`hostFilesDigest`). For that version the sidecar:
#   1. downloads <manifest dir>/host/<version>/HOSTFILES and HOSTFILES.sig over https,
#   2. verifies the detached ed25519 signature with the publisher key (UPDATE_PUBLISHER_KEY, or the official one) via
#      openssl — the same key and algorithm that sign versions.json — and that sha256(HOSTFILES) equals the digest
#      the signed versions.json committed to (a different but validly signed manifest cannot be substituted),
#   3. parses HOSTFILES strictly (header, version == target, sorted unique `<sha256>  <path>` lines, every path a
#      compose file / scripts/*.sh / scripts/lib/*.sh and nothing else),
#   4. downloads ONLY the files whose local sha256 differs, and checks each against its signed hash and a size cap,
#   5. validates the result BEFORE touching the checkout: `bash -n` on every script, `docker compose config` of the
#      new compose file against the real .env, and a refusal when it introduces a variable the .env cannot satisfy.
# Applying = backup of every file about to change, then atomic same-directory renames; a failure at any later step
# of the update restores the backup (hf_rollback). The .env is never read for writing here — it stays byte-for-byte.
# TUGRA_UPDATE_CHECKS=0 is a hard off: nothing is fetched.
#
# Format + path rule are implemented in TypeScript too (apps/hub-api/src/update/host-files.ts, which the release
# runner scripts/sign-host-files.mjs uses). A jest spec drives THIS file with that module's output — keep them in
# lockstep.
#
# The caller provides: log(), compose() (docker compose wrapper), ENV_FILE, REPO_DIR, _snap_cfg (from snapshot.sh),
# and DRY (update.sh --dry-run: fetch+verify still run — they only write a private temp dir — but nothing in the
# checkout is changed).

HF_OFFICIAL_MANIFEST_URL="https://simeraycom.github.io/tugra/versions.json"
HF_OFFICIAL_PUBLISHER_KEY="MCowBQYDK2VwAyEA4+vvlIQS9SWHEKc0Fo1UD2ZW+DSl0AJA9hOK5NeiXBE="
HF_MAX_FILES=64
HF_MAX_FILE_BYTES=1048576
HF_MAX_MANIFEST_BYTES=16384
HF_HEADER="tugra-host-files v1"
HF_STATE_FILE=".tugra-host-applied"   # `<sha256>  <path>` of the last in-app apply (bootstrap.sh uses it to reset git state)

# Results of the last hf_prepare / hf_apply (read by update.sh).
HF_STAGE=""            # private staging dir (inside the checkout so renames stay same-filesystem); "" when none
HF_CHANGED=()          # repo-relative paths whose content will change
HF_ERROR=""            # short operator-facing reason when hf_prepare/hf_apply fail
HF_SCRIPTS_CHANGED=0   # 1 when any scripts/*.sh changed (update.sh then re-execs itself after the update)
HF_COMPOSE_CHANGED=0   # 1 when deploy/docker-compose.yml changed
HF_BACKUP_DIR=""       # where hf_apply saved the previous copies (rollback source)
HF_APPLIED=0           # 1 once hf_apply replaced files (rollback is then needed on a later failure)

hf_sha256() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# The one path rule (mirrors isHostFilePath in host-files.ts): the compose file, or scripts/<name>.sh,
# scripts/lib/<name>.sh. No `..`, no absolute paths, no odd characters.
hf_path_ok() {
  local p="$1"
  case "$p" in *..*|/*|*\\*) return 1 ;; esac
  [ "$p" = "deploy/docker-compose.yml" ] && return 0
  local re='^scripts/(lib/)?[A-Za-z0-9][A-Za-z0-9._-]*[.]sh$'
  [[ "$p" =~ $re ]]
}

hf_version_ok() { local re='^[0-9A-Za-z][0-9A-Za-z.+-]*$'; [[ "${1:-}" =~ $re ]] && [ "${#1}" -le 64 ]; }

# Resolve the manifest source from the process env / .env. Sets HF_BASE_URL (…/host) and HF_KEY.
# Returns 0 ok, 2 = update checks are hard-off (TUGRA_UPDATE_CHECKS=0), 3 = half-configured pair or non-https URL.
HF_BASE_URL=""
HF_KEY=""
hf_resolve_source() {
  local url key
  [ "$(_snap_cfg TUGRA_UPDATE_CHECKS 1)" != "0" ] || return 2
  url="$(_snap_cfg UPDATE_MANIFEST_URL "")"
  key="$(_snap_cfg UPDATE_PUBLISHER_KEY "")"
  if [ -z "$url" ] && [ -z "$key" ]; then url="$HF_OFFICIAL_MANIFEST_URL"; key="$HF_OFFICIAL_PUBLISHER_KEY"; fi
  { [ -n "$url" ] && [ -n "$key" ]; } || return 3
  case "$url" in https://*) ;; *) return 3 ;; esac
  case "$url" in *[[:space:]]*|*\?*|*\#*) return 3 ;; esac
  HF_BASE_URL="${url%/*}/host"
  HF_KEY="$key"
}

# hf_fetch <url> <dest> <max-bytes>: https only (no downgrade on redirect), bounded time + size. The size is checked
# AFTER the download too, because a server that does not announce a length defeats curl's --max-filesize.
hf_fetch() {
  local url="$1" dest="$2" max="$3" size
  case "$url" in https://*) ;; *) return 1 ;; esac
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --connect-timeout 15 --max-time 120 --max-filesize "$max" --output "$dest" "$url" || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 60 -O "$dest" "$url" || return 1
  else
    return 1
  fi
  size="$(wc -c < "$dest" 2>/dev/null | tr -d '[:space:]')"
  case "$size" in ''|*[!0-9]*) return 1 ;; esac
  [ "$size" -le "$max" ]
}

# hf_verify_sig <manifest> <sig-file> <key-b64>: detached ed25519 over the EXACT manifest bytes.
hf_verify_sig() {
  local manifest="$1" sigfile="$2" key="$3" work hex ok=1
  command -v openssl >/dev/null 2>&1 || return 1
  work="$(mktemp -d)" || return 1
  # The key must be a 44-byte ed25519 SubjectPublicKeyInfo (fixed 12-byte prefix + 32-byte key).
  hex="$(printf '%s' "$key" | tr -d '[:space:]' | openssl base64 -d -A 2>/dev/null | od -An -tx1 | tr -d ' \n')"
  case "$hex" in 302a300506032b6570032100????????????????????????????????????????????????????????????????) ;; *) rm -rf "$work"; return 1 ;; esac
  { printf -- '-----BEGIN PUBLIC KEY-----\n'; printf '%s' "$key" | tr -d '[:space:]' | fold -w 64; printf '\n-----END PUBLIC KEY-----\n'; } > "$work/key.pem"
  tr -d '[:space:]' < "$sigfile" | openssl base64 -d -A > "$work/sig.bin" 2>/dev/null || { rm -rf "$work"; return 1; }
  [ "$(wc -c < "$work/sig.bin" | tr -d '[:space:]')" = "64" ] || { rm -rf "$work"; return 1; }
  openssl pkeyutl -verify -pubin -inkey "$work/key.pem" -rawin -in "$manifest" -sigfile "$work/sig.bin" >/dev/null 2>&1 && ok=0
  rm -rf "$work"
  return "$ok"
}

# Parse the (already signature-verified) HOSTFILES into HF_PATHS / HF_SHAS (parallel arrays). Strict: anything
# unexpected fails. Usage: hf_parse <file> <expected-version>
HF_PATHS=()
HF_SHAS=()
hf_parse() {
  local file="$1" want="$2" line n=0 prev="" sha path
  local LC_COLLATE=C   # byte order for the sorted check, the same order the publisher sorts by
  local re='^([0-9a-f]{64})  ([^[:space:]]+)$'
  HF_PATHS=(); HF_SHAS=()
  [ "$(wc -c < "$file" | tr -d '[:space:]')" -le "$HF_MAX_MANIFEST_BYTES" ] || return 1
  [ -z "$(tail -c1 "$file")" ] || return 1   # must end with a newline ($(…) strips it, so an empty result == ends in \n)
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    if [ "$n" -eq 1 ]; then [ "$line" = "$HF_HEADER" ] || return 1; continue; fi
    if [ "$n" -eq 2 ]; then [ "$line" = "version $want" ] || return 1; continue; fi
    [[ "$line" =~ $re ]] || return 1
    sha="${BASH_REMATCH[1]}"; path="${BASH_REMATCH[2]}"
    hf_path_ok "$path" || return 1
    [[ "$path" > "$prev" ]] || return 1   # strictly increasing: sorted AND unique
    prev="$path"
    HF_PATHS+=("$path"); HF_SHAS+=("$sha")
  done < "$file"
  [ "${#HF_PATHS[@]}" -ge 1 ] && [ "${#HF_PATHS[@]}" -le "$HF_MAX_FILES" ]
}

hf_cleanup() {
  if [ -n "$HF_STAGE" ]; then rm -rf "$HF_STAGE"; fi
  HF_STAGE=""
}

# hf_prepare <target-version> <hostFilesDigest>
# Download + verify + validate the release's host files into a private staging dir WITHOUT touching the checkout.
#   0  ok — HF_CHANGED lists what would change (empty = the fast path: the checkout already matches the release)
#   1  failed — HF_ERROR says why; nothing was changed
hf_prepare() {
  local target="$1" digest="$2" rc i path sha local_sha url hexre='^[0-9a-f]{64}$'
  HF_CHANGED=(); HF_ERROR=""; HF_SCRIPTS_CHANGED=0; HF_COMPOSE_CHANGED=0
  hf_cleanup
  hf_version_ok "$target" || { HF_ERROR="invalid target version"; return 1; }
  [[ "$digest" =~ $hexre ]] || { HF_ERROR="invalid host files digest"; return 1; }

  hf_resolve_source && rc=0 || rc=$?
  case "$rc" in
    0) ;;
    2) HF_ERROR="update checks are disabled (TUGRA_UPDATE_CHECKS=0): nothing was fetched"; return 1 ;;
    *) HF_ERROR="cannot fetch the release's compose/scripts: set UPDATE_MANIFEST_URL (https) together with UPDATE_PUBLISHER_KEY in .env, or neither"; return 1 ;;
  esac
  command -v openssl >/dev/null 2>&1 || { HF_ERROR="this updater image has no openssl, so it cannot verify the release's compose/scripts — run git pull && ./scripts/install.sh once to refresh it"; return 1; }
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || { HF_ERROR="this updater image has no curl/wget — run git pull && ./scripts/install.sh once to refresh it"; return 1; }

  # A previous job killed mid-run (container stop) can leave its private staging dir behind; jobs are single-flight
  # (the hub's lock), so anything old enough is stale.
  find "$REPO_DIR" -maxdepth 1 -name '.update-staging.*' -mmin +30 -exec rm -rf {} + 2>/dev/null || true
  HF_STAGE="$(mktemp -d "$REPO_DIR/.update-staging.XXXXXX")" || { HF_ERROR="cannot create a staging directory in the checkout"; return 1; }
  chmod 700 "$HF_STAGE" 2>/dev/null || true
  url="$HF_BASE_URL/$target"

  hf_fetch "$url/HOSTFILES" "$HF_STAGE/HOSTFILES" "$HF_MAX_MANIFEST_BYTES" \
    && hf_fetch "$url/HOSTFILES.sig" "$HF_STAGE/HOSTFILES.sig" 512 \
    || { HF_ERROR="could not download the release's host files manifest from $url"; return 1; }
  hf_verify_sig "$HF_STAGE/HOSTFILES" "$HF_STAGE/HOSTFILES.sig" "$HF_KEY" \
    || { HF_ERROR="host files signature verification failed"; return 1; }
  [ "$(hf_sha256 "$HF_STAGE/HOSTFILES")" = "$digest" ] \
    || { HF_ERROR="host files manifest does not match the digest in the signed release manifest"; return 1; }
  hf_parse "$HF_STAGE/HOSTFILES" "$target" || { HF_ERROR="host files manifest is malformed"; return 1; }

  # Only the files that differ are downloaded; each is checked against its signed hash before it is trusted.
  for i in "${!HF_PATHS[@]}"; do
    path="${HF_PATHS[$i]}"; sha="${HF_SHAS[$i]}"
    local_sha=""
    [ -f "$REPO_DIR/$path" ] && local_sha="$(hf_sha256 "$REPO_DIR/$path")"
    [ "$local_sha" != "$sha" ] || continue
    mkdir -p "$HF_STAGE/files/$(dirname "$path")" || { HF_ERROR="cannot stage $path"; return 1; }
    hf_fetch "$url/$path" "$HF_STAGE/files/$path" "$HF_MAX_FILE_BYTES" || { HF_ERROR="could not download $path"; return 1; }
    [ "$(hf_sha256 "$HF_STAGE/files/$path")" = "$sha" ] || { HF_ERROR="$path does not match its signed hash"; return 1; }
    HF_CHANGED+=("$path")
    case "$path" in deploy/docker-compose.yml) HF_COMPOSE_CHANGED=1 ;; *) HF_SCRIPTS_CHANGED=1 ;; esac
  done
  [ "${#HF_CHANGED[@]}" -gt 0 ] || return 0

  hf_validate || return 1
  return 0
}

# Warnings docker compose prints for a variable the .env does not define (one name per line, sorted). Compose
# prints either `The "FOO" variable is not set…` or, in logfmt form, `msg="The \"FOO\" variable is not set…"`.
_hf_unset_vars() {
  docker compose --project-directory "$REPO_DIR/deploy" --env-file "$ENV_FILE" -f "$1" config 2>&1 >/dev/null \
    | sed -En 's/.*The \\?"([A-Za-z0-9_]+)\\?" variable is not set.*/\1/p' | sort -u
}

# Validate the staged files BEFORE anything is applied: every script parses, and the new compose file is valid
# against the REAL .env and needs no variable the .env cannot satisfy (a new required setting means the installer
# must run to generate it — the updater never edits .env).
hf_validate() {
  local path f before after added
  for path in "${HF_CHANGED[@]}"; do
    f="$HF_STAGE/files/$path"
    case "$path" in
      *.sh) bash -n "$f" 2>/dev/null || { HF_ERROR="$path from the release is not valid shell"; return 1; } ;;
    esac
  done
  [ "$HF_COMPOSE_CHANGED" -eq 1 ] || return 0
  f="$HF_STAGE/files/deploy/docker-compose.yml"
  if [ "${DRY:-0}" -eq 1 ]; then
    printf 'RUN: docker compose --project-directory %s/deploy --env-file %s -f <staged compose> config -q\n' "$REPO_DIR" "$ENV_FILE"
    return 0
  fi
  docker compose --project-directory "$REPO_DIR/deploy" --env-file "$ENV_FILE" -f "$f" config -q >/dev/null 2>&1 \
    || { HF_ERROR="the release's compose file is not valid for this installation"; return 1; }
  before="$(_hf_unset_vars "$REPO_DIR/deploy/docker-compose.yml")"
  after="$(_hf_unset_vars "$f")"
  added="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | tr '\n' ' ' | sed 's/ *$//')"
  if [ -n "$added" ]; then
    HF_ERROR="this release's compose file needs new settings that .env does not define ($added) — run git pull && ./scripts/install.sh, which generates them"
    return 1
  fi
  return 0
}

_hf_file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null || true; }
_hf_file_owner() { stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1" 2>/dev/null || true; }

# Atomically put <src> at <dest> (same directory temp + rename), keeping the destination's mode/owner when it exists.
_hf_install() {
  local src="$1" dest="$2" mode owner tmp
  mode=""; owner=""
  if [ -e "$dest" ]; then mode="$(_hf_file_mode "$dest")"; owner="$(_hf_file_owner "$dest")"; fi
  if [ -z "$mode" ]; then case "$dest" in *.sh) mode=755 ;; *) mode=644 ;; esac; fi
  if [ -z "$owner" ]; then owner="$(_hf_file_owner "$(dirname "$dest")")"; fi
  mkdir -p "$(dirname "$dest")" || return 1
  tmp="$(mktemp "$dest.tugra-new.XXXXXX")" || return 1
  cp "$src" "$tmp" && chmod "$mode" "$tmp" || { rm -f "$tmp"; return 1; }
  if [ -n "$owner" ]; then chown "$owner" "$tmp" 2>/dev/null || true; fi   # only effective as root
  mv -f "$tmp" "$dest" || { rm -f "$tmp"; return 1; }
}

# Write the `<sha256>  <path>` record of what was applied (atomic). Best-effort: it only helps bootstrap.sh.
_hf_write_state() {
  local tmp i
  tmp="$(mktemp "$REPO_DIR/$HF_STATE_FILE.XXXXXX")" || return 0
  for i in "${!HF_PATHS[@]}"; do printf '%s  %s\n' "${HF_SHAS[$i]}" "${HF_PATHS[$i]}"; done > "$tmp" || { rm -f "$tmp"; return 0; }
  chmod 644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$REPO_DIR/$HF_STATE_FILE" 2>/dev/null || rm -f "$tmp"
  return 0
}

# hf_apply <from-version> <to-version>: back up every file about to change, then replace them atomically.
# Any failure restores what was already replaced. Requires a successful hf_prepare with a non-empty HF_CHANGED.
hf_apply() {
  local from to stamp dir keep path i n
  HF_ERROR=""; HF_APPLIED=0; HF_BACKUP_DIR=""
  [ "${#HF_CHANGED[@]}" -gt 0 ] || return 0
  from="$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
  to="$(printf '%s' "$2" | tr -c 'A-Za-z0-9._-' '_')"
  if [ "${DRY:-0}" -eq 1 ]; then
    printf 'HOSTFILES: would replace %s\n' "${HF_CHANGED[*]}"
    return 0
  fi
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dir="${HF_BACKUP_ROOT:-$(_snap_cfg TUGRA_BACKUP_DIR "$REPO_DIR/backups")}/host-files-${from}-to-${to}-${stamp}"
  (umask 077; mkdir -p "$dir") || { HF_ERROR="cannot create the host files backup directory $dir"; return 1; }
  chmod 700 "$dir" 2>/dev/null || true
  # PATHS: `K <path>` = existed (copy saved), `N <path>` = new file (rollback removes it).
  : > "$dir/PATHS"
  for path in "${HF_CHANGED[@]}"; do
    if [ -f "$REPO_DIR/$path" ]; then
      mkdir -p "$dir/files/$(dirname "$path")" && cp -p "$REPO_DIR/$path" "$dir/files/$path" \
        || { HF_ERROR="cannot back up $path"; return 1; }
      printf 'K %s\n' "$path" >> "$dir/PATHS"
    else
      printf 'N %s\n' "$path" >> "$dir/PATHS"
    fi
  done
  if [ -f "$REPO_DIR/$HF_STATE_FILE" ]; then cp -p "$REPO_DIR/$HF_STATE_FILE" "$dir/state" 2>/dev/null || true; fi
  HF_BACKUP_DIR="$dir"
  HF_APPLIED=1   # from here a failure must roll back (hf_rollback is a no-op for files not yet replaced)
  for path in "${HF_CHANGED[@]}"; do
    if ! _hf_install "$HF_STAGE/files/$path" "$REPO_DIR/$path"; then
      HF_ERROR="could not replace $path"
      hf_rollback || HF_ERROR="$HF_ERROR; ROLLBACK ALSO FAILED — restore the files in $dir by hand"
      return 1
    fi
  done
  _hf_write_state
  # Keep the newest PRE_UPDATE_KEEP backup sets (best-effort).
  keep="$(_snap_cfg PRE_UPDATE_KEEP 5)"; case "$keep" in ''|*[!0-9]*) keep=5 ;; esac
  n=0
  # shellcheck disable=SC2012  # generated names, mtime order is what we want
  for i in $(ls -1dt "$(dirname "$dir")"/host-files-* 2>/dev/null); do
    n=$((n + 1)); if [ "$n" -gt "$keep" ]; then rm -rf "$i"; fi
  done
  log "host files: replaced ${#HF_CHANGED[@]} file(s) from release $to (previous copies: $dir)"
  return 0
}

# Put the files hf_apply replaced back (new files removed). 0 only when every restore succeeded.
hf_rollback() {
  local kind path rc=0
  [ "$HF_APPLIED" -eq 1 ] && [ -n "$HF_BACKUP_DIR" ] || return 0
  while read -r kind path; do
    hf_path_ok "$path" || continue
    case "$kind" in
      K) _hf_install "$HF_BACKUP_DIR/files/$path" "$REPO_DIR/$path" || rc=1 ;;
      N) rm -f "$REPO_DIR/$path" || rc=1 ;;
    esac
  done < "$HF_BACKUP_DIR/PATHS"
  if [ -f "$HF_BACKUP_DIR/state" ]; then cp -p "$HF_BACKUP_DIR/state" "$REPO_DIR/$HF_STATE_FILE" 2>/dev/null || true
  else rm -f "$REPO_DIR/$HF_STATE_FILE"; fi
  if [ "$rc" -eq 0 ]; then HF_APPLIED=0; log "host files: restored the previous compose/scripts from $HF_BACKUP_DIR"; fi
  return "$rc"
}
