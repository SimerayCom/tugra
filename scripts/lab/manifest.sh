#!/bin/sh
# Runs INSIDE the alpine helper (busybox) with a volume at /data (DATA overrides the directory): one deterministic line per
# entry with every field a restore must keep: type, numeric owner, the FULL mode (the setuid/setgid/sticky digit included),
# size, hard-link count, mtime, symlink target, content hash. The volume root itself (`.`) is an entry too: its owner and mode
# are what a restored database or app directory starts with.
# Environment: EXCLUDE (a path relative to the volume root to skip, e.g. postmaster.pid), DIR_MTIME=1 (also print directory
# mtimes: the extractor, not the source, decides them, so they are off by default and reported separately).
cd "${DATA:-/data}" || exit 2
if [ -n "${EXCLUDE:-}" ]; then
  set -- ! -path "./$EXCLUDE"
else
  set --
fi
find . ! -type s "$@" | LC_ALL=C sort | while IFS= read -r p; do
  t=$(stat -c '%F' "$p")
  case "$t" in
    "regular file" | "regular empty file")
      printf '%s|%s|%s|%s|%s|%s\n' "$p" "$t" "$(stat -c '%u:%g' "$p")" "$(stat -c '%a' "$p")" "$(stat -c '%s|%h|%Y' "$p")" "$(sha256sum <"$p" | cut -d' ' -f1)"
      ;;
    "symbolic link") printf '%s|%s|%s|%s|%s\n' "$p" "$t" "$(stat -c '%u:%g' "$p")" "$(readlink "$p")" "$(stat -c '%Y' "$p")" ;;
    directory)
      if [ "${DIR_MTIME:-0}" = 1 ]; then printf '%s|%s|%s|%s|%s\n' "$p" "$t" "$(stat -c '%u:%g' "$p")" "$(stat -c '%a' "$p")" "$(stat -c '%Y' "$p")"
      else printf '%s|%s|%s|%s\n' "$p" "$t" "$(stat -c '%u:%g' "$p")" "$(stat -c '%a' "$p")"; fi
      ;;
    *) printf '%s|%s|%s|%s|%s\n' "$p" "$t" "$(stat -c '%u:%g' "$p")" "$(stat -c '%a' "$p")" "$(stat -c '%Y' "$p")" ;;
  esac
done
