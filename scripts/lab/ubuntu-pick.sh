#!/usr/bin/env bash
# ubuntu-pick.sh [wanted-image] [fallback-image]
# Pull the distribution image the 26.04 source job wants (default ubuntu:26.04, the release three of the real estate's hosts run) and
# print "<image> <exact|fallback>". When the wanted tag cannot be pulled the closest older LTS (default ubuntu:24.04) is used and
# the answer says `fallback`, so the job can say so loudly instead of passing as if it had tested 26.04. Exit 1 when neither pulls.
set -uo pipefail
WANTED="${1:-ubuntu:26.04}"
FALLBACK="${2:-ubuntu:24.04}"
if docker pull -q "$WANTED" >/dev/null 2>&1; then echo "$WANTED exact"; exit 0; fi
if docker pull -q "$FALLBACK" >/dev/null 2>&1; then echo "$FALLBACK fallback"; exit 0; fi
echo "neither $WANTED nor $FALLBACK could be pulled" >&2
exit 1
