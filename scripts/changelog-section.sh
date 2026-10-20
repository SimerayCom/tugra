#!/usr/bin/env bash
# Print the CHANGELOG.md body under "## [<version>]" up to the next "## [" heading,
# with leading/trailing blank lines trimmed. Used by the release workflow to turn the
# matching changelog entry into GitHub Release notes. Exits non-zero (no output) when
# the version has no section, so the caller can fall back to a generic note.
#
# Usage: changelog-section.sh <version> [changelog-file]
set -euo pipefail

version="${1:?usage: changelog-section.sh <version> [changelog-file]}"
file="${2:-CHANGELOG.md}"

awk -v ver="$version" '
  $0 ~ "^## \\[" ver "\\]" { inb = 1; next }   # start of the requested version block
  inb && /^## \[/          { exit }             # next version block ends it
  inb                      { buf[n++] = $0 }
  END {
    s = 0;     while (s < n   && buf[s] ~ /^[[:space:]]*$/) s++   # trim leading blanks
    e = n - 1; while (e >= s  && buf[e] ~ /^[[:space:]]*$/) e--   # trim trailing blanks
    for (i = s; i <= e; i++) print buf[i]
    if (n == 0) exit 1                            # no section found
  }
' "$file"
