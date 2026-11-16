#!/usr/bin/env bash
# migrate.sh [--hub URL] [--image IMAGE] [migrator flags...]
# Runs the REAL installer line from the lab hub: `curl .../install/migrator.sh | TUGRA_MIGRATION_TOKEN=... sh -s -- ...`
# against the current op ($LAB_DIR/op.main.env, or LAB_OP=<name>). Everything after the two lab flags goes to the migrator
# verbatim (--arms all, --dry-run, --part-mib 128, --only REF, --stop-source ...). The installer's own `docker pull` is
# satisfied by the local registry image.
# Output: the migrator's stdout (its single JSON result line) goes to stdout and to $LAB_DIR/run.<tag>.json; its human log goes
# to stderr and to $LAB_DIR/run.<tag>.log (tag: LAB_RUN_TAG or the epoch). The exit code is the migrator's.
# LAB_INSTALLER_IMAGE=<image> runs the installer's `sh` INSIDE that image (a distribution userland: ubuntu:26.04 plus a docker CLI)
# against the host's docker socket, instead of on the lab host: the installer then meets that image's sh, coreutils and curl
# (R31, scripts/lab/l14-ubuntu-source.sh). The migrator container itself is the agent image either way.
set -uo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
lab_load
lab_op_load "${LAB_OP:-main}"

HUB="$HUB_URL"
IMAGE="$LAB_IMAGE"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hub) HUB="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    *) break ;;
  esac
done

TAG="${LAB_RUN_TAG:-$(date +%s)}"
OUT="$LAB_DIR/run.$TAG.json"
ERR="$LAB_DIR/run.$TAG.log"

# the real line: curl | TUGRA_MIGRATION_TOKEN=... sh -s -- --hub ... (the hub serves it with the lab image as the default)
runner=(sh)
if [ -n "${LAB_INSTALLER_IMAGE:-}" ]; then
  # the token rides the environment of the docker client and is passed into the container by name only, as the installer itself does
  runner=(docker run --rm -i --network host -v /var/run/docker.sock:/var/run/docker.sock -e TUGRA_MIGRATION_TOKEN "$LAB_INSTALLER_IMAGE" sh)
fi
curl -fsSL "http://127.0.0.1:${LAB_HUB_PORT}/install/migrator.sh" | TUGRA_MIGRATION_TOKEN="$MIG_TOKEN" "${runner[@]}" -s -- --hub "$HUB" --image "$IMAGE" --allow-insecure-http "$@" >"$OUT" 2> >(tee "$ERR" >&2)
rc=$?
wait
cat "$OUT"
lab_log "migrator exit $rc (result: $OUT)"
exit "$rc"
