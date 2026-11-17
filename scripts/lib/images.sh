#!/usr/bin/env bash
#
# Tugra image housekeeping, sourced by scripts/update.sh (the tugra-updater sidecar) and scripts/install.sh.
#
#   is_newer <candidate> <baseline>          semver-aware "strictly newer" (shared by both scripts)
#   prune_select <current> <previous>        PURE: reads image rows on stdin, prints what to remove
#   prune_release_images <current> <prev>    removes Tugra's own old release images, logs what was freed
#   pull_agent_image <version> [digest]      pulls the bundled agent image without `docker compose pull`
#
# WHY PRUNE: every release adds a hub (~3.7 GB), web (~4.2 GB), agent and updater image and nothing ever removed the
# old ones, so a box that followed the beta train ran out of disk. After a verified update only the running release and
# the one before it (the rollback anchor) are kept.
#
# WHAT COUNTS AS TUGRA'S: an image whose repository is one of the four release repositories
# (ghcr.io/simeraycom/tugra-{hub,web,agent,updater}, overridable via HUB_IMAGE_REPO / WEB_IMAGE_REPO /
# AGENT_IMAGE_REPO / UPDATER_IMAGE_REPO for a mirror), or an UNNAMED image (`<none>:<none>`, left behind when a tag
# moved) that still carries the release's OCI source + title labels. Everything else is never touched: app images,
# databases, Traefik, a locally built `tugra-hub-api`, a user's own tags.
#
# VERSION OF AN IMAGE: its `org.opencontainers.image.version` label (set on every release image). Digest-pinned pulls
# (`repo:tag@sha256:…`, how the updater pulls hub/web) leave NO tag locally, so the tag alone cannot be relied on; it
# is the fallback for images that predate the label.
#
# SAFETY: `docker rmi` WITHOUT -f — an image used by any container (running or stopped) is refused by the engine and
# simply stays. `latest` is never removed. When the previous version cannot be ordered (`latest`, empty, not semver)
# no versioned image is removed at all; only unnamed Tugra leftovers go.
#
# The caller provides log(). Needs docker; no jq, no awk beyond the size formatting.

TUGRA_IMG_SOURCE_LABEL="https://github.com/SimerayCom/tugra"
TUGRA_IMG_TITLES=("Tugra Hub API" "Tugra Web" "Tugra Agent" "Tugra Updater")
TUGRA_IMG_VERSION_LABEL="org.opencontainers.image.version"

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

# The four release image repositories, one per line.
tugra_release_repos() {
  printf '%s\n' \
    "${HUB_IMAGE_REPO:-ghcr.io/simeraycom/tugra-hub}" \
    "${WEB_IMAGE_REPO:-ghcr.io/simeraycom/tugra-web}" \
    "${AGENT_IMAGE_REPO:-ghcr.io/simeraycom/tugra-agent}" \
    "${UPDATER_IMAGE_REPO:-ghcr.io/simeraycom/tugra-updater}"
}

# True for a plain MAJOR.MINOR.PATCH[-pre][+build] version (optionally v-prefixed).
_img_is_version() { [[ "${1:-}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]]; }

# _prune_is_tugra <repo> <src label> <title label>: 0 when the image is one of Tugra's own release images.
_prune_is_tugra() {
  local repo="$1" src="$2" title="$3" t
  if printf '%s\n' "$(tugra_release_repos)" | grep -qxF -- "$repo"; then return 0; fi
  if [ "$repo" = "<none>" ] && [ "$src" = "$TUGRA_IMG_SOURCE_LABEL" ]; then
    for t in "${TUGRA_IMG_TITLES[@]}"; do [ "$title" = "$t" ] && return 0; done
  fi
  return 1
}

# prune_select <current> <previous>
# stdin: one image reference per line, fields separated by `|`:
#   ID|REPOSITORY|TAG|DIGEST|VERSION_LABEL|SOURCE_LABEL|TITLE_LABEL        (`<none>` for an empty repo/tag/digest)
# stdout: `ID|REF|VERSION` for every reference to remove (REF is repo:tag, repo@digest, or the bare ID for an unnamed
# image). An ID with at least one reference that must stay is never emitted: one image id can carry several tags.
# When <previous> equals <current> (a re-run on the same release) the rollback anchor is the highest Tugra release
# below <current> found in the input, never <current> itself.
prune_select() {
  local cur="${1#v}" prev="${2#v}" floor="" input
  input="$(cat)"
  # Re-run on the SAME version (installer repair, --pull, applying host files after an in-app update): the caller's
  # "previous" is the current release itself and says nothing about the real rollback anchor. Take the highest
  # Tugra release below <current> that is present on disk as the previous one, so it is kept.
  if _img_is_version "$cur" && [ "$prev" = "$cur" ]; then
    local a_id a_repo a_tag a_digest a_ver a_src a_title a_v best=""
    while IFS='|' read -r a_id a_repo a_tag a_digest a_ver a_src a_title || [ -n "$a_id" ]; do
      [ -n "$a_id" ] || continue
      [ "$a_ver" = "<no value>" ] && a_ver=""; [ "$a_src" = "<no value>" ] && a_src=""; [ "$a_title" = "<no value>" ] && a_title=""
      _prune_is_tugra "$a_repo" "$a_src" "$a_title" || continue
      a_v="$a_ver"
      if [ -z "$a_v" ] && _img_is_version "$a_tag"; then a_v="$a_tag"; fi
      a_v="${a_v#v}"
      _img_is_version "$a_v" || continue
      is_newer "$cur" "$a_v" || continue          # only versions strictly below <current>
      if [ -z "$best" ] || is_newer "$a_v" "$best"; then best="$a_v"; fi
    done <<EOF_INPUT
$input
EOF_INPUT
    [ -n "$best" ] && prev="$best"
  fi
  # The floor is the OLDER of the two kept releases: strictly older versions are removable. No floor (previous is
  # not a plain version, e.g. `latest`) = nothing versioned is removable.
  if _img_is_version "$prev"; then
    floor="$prev"
    if _img_is_version "$cur" && is_newer "$prev" "$cur"; then floor="$cur"; fi
  fi
  local rows="" keep_ids="|" id repo tag digest ver src title is_tugra version ref
  while IFS='|' read -r id repo tag digest ver src title || [ -n "$id" ]; do
    [ -n "$id" ] || continue
    [ "$ver" = "<no value>" ] && ver=""
    [ "$src" = "<no value>" ] && src=""
    [ "$title" = "<no value>" ] && title=""
    is_tugra=0
    _prune_is_tugra "$repo" "$src" "$title" && is_tugra=1
    [ "$is_tugra" -eq 1 ] || continue   # foreign image: never kept-or-removed, simply not ours

    version="$ver"
    if [ -z "$version" ] && _img_is_version "$tag"; then version="$tag"; fi
    version="${version#v}"

    local keep=0
    if [ "$tag" = "latest" ]; then keep=1
    elif [ -n "$version" ] && { [ "$version" = "$cur" ] || [ "$version" = "$prev" ]; }; then keep=1
    elif [ -n "$version" ]; then
      # A versioned image: removable only when STRICTLY older than the floor (and the floor is known).
      if [ -z "$floor" ] || ! _img_is_version "$version" || ! is_newer "$floor" "$version"; then keep=1; fi
    else
      # No version at all. An unnamed / untagged leftover is dangling and goes; a custom tag (edge, dev, a mirror's
      # own naming) is the operator's and stays.
      if [ "$repo" != "<none>" ] && [ "$tag" != "<none>" ]; then keep=1; fi
    fi

    if [ "$keep" -eq 1 ]; then
      keep_ids="${keep_ids}${id}|"
      continue
    fi
    if [ "$repo" != "<none>" ] && [ "$tag" != "<none>" ]; then ref="$repo:$tag"
    elif [ "$repo" != "<none>" ] && [ -n "$digest" ] && [ "$digest" != "<none>" ]; then ref="$repo@$digest"
    else ref="$id"; fi
    rows="${rows}${id}|${ref}|${version:-unknown}"$'\n'
  done <<EOF_MAIN
$input
EOF_MAIN
  # Second pass: drop every row whose image id also carries a reference that stays.
  local line rid
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    rid="${line%%|*}"
    case "$keep_ids" in *"|$rid|"*) continue ;; esac
    printf '%s\n' "$line"
  done <<EOF_ROWS
$rows
EOF_ROWS
}

# Collect every local image that could be Tugra's, one `prune_select` row each. Reads labels with `docker image
# inspect` only for candidates (a release repo or an unnamed image), so a host with many unrelated images stays cheap.
prune_collect() {
  local repos id repo tag digest meta
  repos="$(tugra_release_repos)"
  docker image ls --no-trunc --digests --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Digest}}' 2>/dev/null \
    | while IFS='|' read -r id repo tag digest; do
        [ -n "$id" ] || continue
        if ! printf '%s\n' "$repos" | grep -qxF -- "$repo" && [ "$repo" != "<none>" ]; then continue; fi
        meta="$(docker image inspect -f "{{index .Config.Labels \"$TUGRA_IMG_VERSION_LABEL\"}}|{{index .Config.Labels \"org.opencontainers.image.source\"}}|{{index .Config.Labels \"org.opencontainers.image.title\"}}" "$id" 2>/dev/null | tr -d '\n' | tr -d '\r')" || meta="||"
        [ -n "$meta" ] || meta="||"
        printf '%s|%s|%s|%s|%s\n' "$id" "$repo" "$tag" "$digest" "$meta"
      done
}

# prune_summary <current> <previous>: prints `<image count> <bytes>` of what prune_release_images would remove.
prune_summary() {
  local rows ids id n=0 bytes=0 size
  rows="$(prune_collect | prune_select "$1" "$2")" || rows=""
  ids="$(printf '%s\n' "$rows" | cut -d'|' -f1 | sort -u | sed '/^$/d')"
  for id in $ids; do
    n=$((n + 1))
    size="$(docker image inspect -f '{{.Size}}' "$id" 2>/dev/null | tr -d '[:space:]')"
    case "$size" in ''|*[!0-9]*) size=0 ;; esac
    bytes=$((bytes + size))
  done
  printf '%s %s\n' "$n" "$bytes"
}

_img_human() {
  awk -v b="${1:-0}" 'BEGIN { if (b >= 1073741824) printf "%.1f GB", b / 1073741824; else printf "%.0f MB", b / 1048576 }'
}

# prune_release_images <current> <previous>: remove Tugra's own release images older than <previous>. Never fatal.
# Logs each removal and the total freed. TUGRA_PRUNE_IMAGES=0 is the caller's opt-out (checked by the caller).
prune_release_images() {
  local cur="${1:-}" prev="${2:-}" rows ids id ref refs ver size freed=0 removed=0 skipped=0 gone
  rows="$(prune_collect | prune_select "$cur" "$prev")" || rows=""
  if [ -z "$rows" ]; then
    log "image cleanup: no old Tugra release images to remove (kept ${cur:-?} and ${prev:-?})"
    return 0
  fi
  ids="$(printf '%s\n' "$rows" | cut -d'|' -f1 | sort -u)"
  for id in $ids; do
    refs="$(printf '%s\n' "$rows" | awk -F'|' -v id="$id" '$1 == id { print $2 }')"
    ver="$(printf '%s\n' "$rows" | awk -F'|' -v id="$id" '$1 == id { print $3; exit }')"
    size="$(docker image inspect -f '{{.Size}}' "$id" 2>/dev/null | tr -d '[:space:]')"
    case "$size" in ''|*[!0-9]*) size=0 ;; esac
    for ref in $refs; do
      docker rmi "$ref" >/dev/null 2>&1 || true
    done
    docker rmi "$id" >/dev/null 2>&1 || true
    if docker image inspect "$id" >/dev/null 2>&1; then gone=0; else gone=1; fi
    if [ "$gone" -eq 1 ]; then
      removed=$((removed + 1)); freed=$((freed + size))
      log "image cleanup: removed $(printf '%s' "$refs" | head -n1) (release $ver, $(_img_human "$size"))"
    else
      skipped=$((skipped + 1))
      log "image cleanup: kept $(printf '%s' "$refs" | head -n1) (release $ver): still used by a container"
    fi
  done
  log "image cleanup: removed $removed old Tugra release image(s), freed about $(_img_human "$freed") (kept ${cur:-?} and ${prev:-?}; $skipped in use)"
  return 0
}

# Pull the bundled agent image WITHOUT `docker compose pull`, and make `<repo>:<version>` point at it locally.
# `compose pull agent` failed on engines that use the containerd image store ("could not fetch content descriptor …
# (application/vnd.in-toto+json) … not found"): the release's tag is an OCI index that also lists BuildKit
# attestation manifests (SBOM + provenance, platform unknown/unknown) and that pull path tried to fetch their
# blobs. The per-platform image manifest references no attestation at all, so pulling THAT by digest cannot hit
# it; it is also what the hub's signed agent_update already does for remote agents.
#   with a 64-hex <digest> (the signed per-arch manifest digest): pull <repo>@sha256:<digest>, require its version
#   label to equal <version>, then tag it <repo>:<version> (a digest pull leaves no tag).
#   without one: a plain `docker pull <repo>:<version>`.
# Caller provides log(); AGENT_IMAGE_REPO overrides the repository. Returns 0 only when the tag is usable locally.
pull_agent_image() {
  local version="$1" digest="${2:-}" repo="${AGENT_IMAGE_REPO:-ghcr.io/simeraycom/tugra-agent}" label id
  if [ -n "$digest" ]; then
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || { log "agent image: ignoring a malformed platform digest"; digest=""; }
  fi
  if [ -z "$digest" ]; then
    docker pull "$repo:$version" >/dev/null
    return $?
  fi
  docker pull "$repo@sha256:$digest" >/dev/null || return 1
  label="$(docker image inspect -f "{{index .Config.Labels \"$TUGRA_IMG_VERSION_LABEL\"}}" "$repo@sha256:$digest" 2>/dev/null | tr -d '[:space:]')" || return 1
  if [ "${label#v}" != "${version#v}" ]; then
    log "agent image: $repo@sha256:${digest:0:12}… reports version '${label:-none}', expected $version — not using it"
    return 1
  fi
  id="$(docker image inspect -f '{{.Id}}' "$repo@sha256:$digest" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$id" ] || return 1
  docker tag "$id" "$repo:$version"
}

# Pull the updater sidecar's image WITHOUT `docker compose pull` (the same containerd-store attestation failure the
# agent hit applies to any release tag built with BuildKit provenance/SBOM): a plain `docker pull <ref>`.
#   pull_updater_image <version> [<ref compose resolves for tugra-updater>]
# With a ref it is pulled as given; otherwise <repo>:<version>. UPDATER_IMAGE_REPO overrides the repository.
# Returns 0 only when the image is usable locally.
pull_updater_image() {
  local ref="${2:-}"
  [ -n "$ref" ] || ref="${UPDATER_IMAGE_REPO:-ghcr.io/simeraycom/tugra-updater}:${1:-latest}"
  docker pull "$ref" >/dev/null
}
