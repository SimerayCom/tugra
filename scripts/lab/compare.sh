#!/usr/bin/env bash
# compare.sh <source-volume> <destination-volume>
# 1. ARCHIVE: the sha256 of the SAME tar the migrator streams (agent image GNU tar, --sort=name --numeric-owner
#    --format=gnu) over both volumes. Equal = the copy is bit-for-bit what the migrator would stream again.
# 2. On a difference, a field-level manifest diff (busybox stat + content hash, volume root and full modes included) names the
#    exact entry and field. Directory mtimes are decided by the extractor, so a difference ONLY there prints DIR-MTIME-ONLY and
#    exits 0 (COMPARE_STRICT=1 makes it fail); that verdict is taken from the tar listing with only directory mtimes masked
#    (tarlist.sh), so it cannot hide a root owner or mode, a setuid bit, or a symlink or FIFO mtime. Expected non-copies
#    (documented): sockets, xattrs, ACLs, file capabilities, sub-second mtimes, holes.
# Environment: COMPARE_EXCLUDE=<path> skips one top-level entry on both sides (postmaster.pid for a Postgres volume).
# Prints ARCHIVE-IDENTICAL | DIR-MTIME-ONLY | ARCHIVE-DIFFERS; exit 0 for the first two.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SRC="${1:?source volume}"
DST="${2:?destination volume}"
IMG="${LAB_IMAGE}"
HELPER="$(lab_helper_image)"
EX="${COMPARE_EXCLUDE:-}"

tar_hash() {
  local args=(--sort=name --numeric-owner --format=gnu)
  [ -n "$EX" ] && args+=("--exclude=./$EX")
  docker run --rm -v "$1":/data:ro --entrypoint tar "$IMG" "${args[@]}" -C /data -cf - . | sha256sum | cut -d' ' -f1
}

manifest() { # $1 volume, $2 DIR_MTIME
  docker run --rm -v "$1":/data:ro -v "$LAB_SELF_DIR/manifest.sh":/manifest.sh:ro -e "EXCLUDE=$EX" -e "DIR_MTIME=$2" "$HELPER" sh /manifest.sh
}

listing() { # $1 volume: the masked tar listing (tarlist.sh), run in the agent image where GNU tar lives
  docker run --rm -v "$1":/data:ro -v "$LAB_SELF_DIR/tarlist.sh":/tarlist.sh:ro -e "EXCLUDE=$EX" --entrypoint sh "$IMG" /tarlist.sh
}

a="$(tar_hash "$SRC")"
b="$(tar_hash "$DST")"
if [ "$a" = "$b" ]; then
  echo "ARCHIVE-IDENTICAL $a"
  exit 0
fi
lab_log "archive hashes differ ($a vs $b): field-level diff follows"
fields_a="$(mktemp)"; fields_b="$(mktemp)"
trap 'rm -f "$fields_a" "$fields_b"' EXIT
manifest "$SRC" 0 >"$fields_a"
manifest "$DST" 0 >"$fields_b"
if diff -u "$fields_a" "$fields_b" >"$LAB_DIR/compare.diff"; then
  # every manifest field matches (the volume root, full modes and symlink/special mtimes included). Whether ONLY directory
  # mtimes remain is decided by the tar listing itself with just those masked, never by the manifest being empty.
  listing "$SRC" >"$fields_a"
  listing "$DST" >"$fields_b"
  if diff -u "$fields_a" "$fields_b" >"$LAB_DIR/compare.listing.diff"; then
    manifest "$SRC" 1 >"$fields_a"
    manifest "$DST" 1 >"$fields_b"
    diff -u "$fields_a" "$fields_b" >"$LAB_DIR/compare.dirs.diff" || true
    if [ "${COMPARE_STRICT:-0}" = 1 ]; then echo "ARCHIVE-DIFFERS (strict): see $LAB_DIR/compare.dirs.diff"; cat "$LAB_DIR/compare.dirs.diff" >&2; exit 1; fi
    echo "DIR-MTIME-ONLY"
    head -20 "$LAB_DIR/compare.dirs.diff" >&2 || true
    exit 0
  fi
  echo "ARCHIVE-DIFFERS (tar listing, outside directory mtimes)"
  head -60 "$LAB_DIR/compare.listing.diff" >&2
  exit 1
fi
echo "ARCHIVE-DIFFERS"
head -60 "$LAB_DIR/compare.diff" >&2
exit 1
