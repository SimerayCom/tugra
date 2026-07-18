#!/usr/bin/env bash
#
# Derive the release version, channel, and latest-flag from a git tag or a workflow_dispatch input.
# Prints GitHub-Actions `key=value` lines to stdout so the workflow can do:
#   bash scripts/release-version.sh "$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"
# The SHIPPED derivation is this tested script — the workflow YAML holds no version logic.
#
#   release-version.sh v1.2.3        -> version=1.2.3      channel=stable latest=true
#   release-version.sh v1.2.3-beta.1 -> version=1.2.3-beta.1 channel=beta latest=false
#   release-version.sh 1.2.3         -> (raw dispatch input, same as v1.2.3)
# Any non-semver input exits non-zero (fail-closed — never publish a garbage tag).
set -euo pipefail

ref="${1:-}"
[ -n "$ref" ] || { printf 'release-version: missing ref argument\n' >&2; exit 1; }

# Accept a full ref (refs/tags/vX.Y.Z) or a bare tag/version; strip refs/tags/ then a leading v.
ref="${ref#refs/tags/}"
version="${ref#v}"

# SemVer MAJOR.MINOR.PATCH with an optional -prerelease. Build metadata (+build) is deliberately NOT
# accepted: the version is used verbatim as an OCI image tag, and '+' is not a legal tag character, so a
# `+build` tag would fail late at `docker buildx` with a cryptic error. Reject it up front (fail-closed).
semver_re='^([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9A-Za-z.-]+)?$'
if [[ ! "$version" =~ $semver_re ]]; then
  printf 'release-version: not a valid image-taggable semver: %s\n' "$version" >&2
  exit 1
fi

# A pre-release suffix (-beta, -rc, …) ships to the beta channel and never moves `latest`.
if [ -n "${BASH_REMATCH[4]}" ]; then
  channel="beta"
  latest="false"
else
  channel="stable"
  latest="true"
fi

printf 'version=%s\n' "$version"
printf 'channel=%s\n' "$channel"
printf 'latest=%s\n' "$latest"
