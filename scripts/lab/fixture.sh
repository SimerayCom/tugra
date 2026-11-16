#!/usr/bin/env bash
# fixture.sh <volume> <MiB> [random|zeros]
# Deterministic-per-run source data in a docker volume: one big file (incompressible by default), nested and unicode
# directories, a >100 character path, a 200 character file name, owners 999/70/1000, modes 0600/0700/0750, a hard link, a
# symlink, a dangling symlink and a FIFO. Generated once per scenario so the tar stream is identical across attempts (resume
# compares raw slice hashes).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

VOL="${1:?volume}"
MIB="${2:?size in MiB}"
KIND="${3:-random}"
case "$KIND" in random) SRCDEV=/dev/urandom ;; zeros) SRCDEV=/dev/zero ;; *) lab_die "kind must be random or zeros" ;; esac
case "$MIB" in '' | *[!0-9]*) lab_die "MiB must be a number" ;; esac

docker volume create "$VOL" >/dev/null
lab_log "fixture: ${MIB} MiB ${KIND} into volume $VOL"
docker run --rm -v "$VOL":/data "$(lab_helper_image)" sh -c '
  set -e; cd /data
  dd if="$1" of=big.bin bs=1048576 count="$2" 2>/dev/null
  L="$(printf "d%.60d" 0)/$(printf "e%.60d" 0)/$(printf "f%.60d" 0)"
  mkdir -p secret empty "ünï-dir" "dir with spaces" "$L"
  echo x > secret/f && chmod 0600 secret/f && chown 999:999 secret/f
  chmod 0700 secret && chown 999:999 secret
  echo hl > a && ln a a.hardlink && ln -s a a.symlink && ln -s missing dangling && mkfifo fifo
  echo deep > "$L/f.txt"; echo u > "ünï-dir/ü.txt"; echo s > "dir with spaces/x y.txt"
  N="$(printf "n%.200d" 0)"; echo long > "$N"
  echo exec > run.sh && chmod 0755 run.sh && chown 1000:1000 run.sh
  chown 70:70 empty && chmod 0750 empty
  touch -h -t 202301151030.45 a big.bin run.sh fifo "$N" secret/f "$L/f.txt" "ünï-dir/ü.txt" "dir with spaces/x y.txt"' _ "$SRCDEV" "$MIB"
lab_log "fixture ready"
