#!/bin/sh
# Runs INSIDE the alpine helper (busybox) with a volume at /data: one deterministic line per entry with every field a
# restore must keep (type, numeric owner, mode, size, hard-link count, file mtime, symlink target, content hash).
# Environment: EXCLUDE (a path relative to the volume root to skip, e.g. postmaster.pid), DIR_MTIME=1 (also print directory
# mtimes: the extractor, not the source, decides them, so they are off by default and reported separately).
cd /data || exit 2
if [ -n "${EXCLUDE:-}" ]; then
  set -- ! -path "./$EXCLUDE"
else
  set --
fi
find . -mindepth 1 ! -type s "$@" | LC_ALL=C sort | while IFS= read -r p; do
  t=$(stat -c '%F' "$p")
  case "$t" in
    "regular file" | "regular empty file")
      m=$(stat -c '%a' "$p")
      [ "${#m}" -eq 4 ] && m=${m#?} # the setuid/sticky digit is not part of the comparison (busybox may drop it)
      printf '%s|%s|%s|%s|%s|%s\n' "$p" "$t" "$(stat -c '%u:%g' "$p")" "$m" "$(stat -c '%s|%h|%Y' "$p")" "$(sha256sum <"$p" | cut -d' ' -f1)"
      ;;
    "symbolic link") printf '%s|%s|%s|%s\n' "$p" "$t" "$(stat -c '%u:%g' "$p")" "$(readlink "$p")" ;;
    directory)
      if [ "${DIR_MTIME:-0}" = 1 ]; then printf '%s|%s|%s|%s|%s\n' "$p" "$t" "$(stat -c '%u:%g' "$p")" "$(stat -c '%a' "$p")" "$(stat -c '%Y' "$p")"
      else printf '%s|%s|%s|%s\n' "$p" "$t" "$(stat -c '%u:%g' "$p")" "$(stat -c '%a' "$p")"; fi
      ;;
    *) printf '%s|%s|%s|%s\n' "$p" "$t" "$(stat -c '%u:%g' "$p")" "$(stat -c '%a' "$p")" ;;
  esac
done
