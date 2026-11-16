#!/bin/sh
# Runs INSIDE the agent image (GNU tar) with a volume at /data (DATA overrides the directory, TAR the tar binary): the
# `tar -tv` listing of the SAME archive the migrator streams (--sort=name --numeric-owner --format=gnu), one line per entry
# with type, mode (setuid and sticky bits included), numeric owner, size, full-resolution mtime and name, in which ONLY the
# mtime of DIRECTORIES and SYMLINKS is masked. The extractor decides directory mtimes and busybox tar cannot set symlink ones; every other byte of the listing, the root `./` entry
# included, is a real difference. compare.sh calls this to decide DIR-MTIME-ONLY, so that verdict can never hide anything else.
# Environment: EXCLUDE (a path relative to the volume root to skip, e.g. postmaster.pid).
TAR="${TAR:-tar}"
cd "${DATA:-/data}" || exit 2
set -- --sort=name --numeric-owner --format=gnu
[ -n "${EXCLUDE:-}" ] && set -- "$@" "--exclude=./$EXCLUDE"
"$TAR" "$@" -cf - . | "$TAR" --numeric-owner --utc --full-time -tvf - |
  sed -E 's/^([dl][^ ]+ +[^ ]+ +[0-9]+ )[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+ /\1MASKED /'
