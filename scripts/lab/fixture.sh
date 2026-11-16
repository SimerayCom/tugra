#!/usr/bin/env bash
# fixture.sh <volume> <MiB> [random|zeros|pgheap]
# Deterministic-per-run source data in a docker volume: one big file (incompressible by default), nested and unicode
# directories, a >100 character path, a 200 character file name, owners 999/70/65534/1000 (the owners the real estate's volumes
# have: postgres 999 or 70, nobody 65534, a plain app user 1000), modes 0600/0700/0750, a hard link, a symlink, a dangling
# symlink and a FIFO. Generated once per scenario so the tar stream is identical across attempts (resume compares raw slice hashes).
# `pgheap` instead leaves a real, cleanly shut down PostgreSQL 17 data directory of about <MiB> MiB (a time-series table):
# compressible heap pages, not urandom, plus the small file set above is NOT added (the volume is a data directory).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

VOL="${1:?volume}"
MIB="${2:?size in MiB}"
KIND="${3:-random}"
case "$KIND" in random) SRCDEV=/dev/urandom ;; zeros) SRCDEV=/dev/zero ;; pgheap) SRCDEV= ;; *) lab_die "kind must be random, zeros or pgheap" ;; esac
case "$MIB" in '' | *[!0-9]*) lab_die "MiB must be a number" ;; esac

docker volume create "$VOL" >/dev/null
if [ "$KIND" = pgheap ]; then
  # shellcheck source=fleet.sh
  . "$LAB_SELF_DIR/fleet.sh"
  PGC="lab-pgheap-$$"
  lab_log "fixture: ${MIB} MiB of PostgreSQL heap into volume $VOL"
  docker rm -f "$PGC" >/dev/null 2>&1 || true
  docker run -d --name "$PGC" -e POSTGRES_USER=tugra -e POSTGRES_PASSWORD=lab -v "$VOL":/var/lib/postgresql/data postgres:17-alpine >/dev/null
  fleet_pg_wait "$PGC"
  fleet_pg_load_ticks "$PGC" "$MIB"
  docker stop -t 120 "$PGC" >/dev/null # a clean shutdown: a checkpointed data directory, no postmaster.pid
  docker rm -f "$PGC" >/dev/null
  lab_log "fixture ready"
  exit 0
fi
lab_log "fixture: ${MIB} MiB ${KIND} into volume $VOL"
docker run --rm -v "$VOL":/data "$(lab_helper_image)" sh -c '
  set -e; cd /data
  dd if="$1" of=big.bin bs=1048576 count="$2" 2>/dev/null
  L="$(printf "d%.60d" 0)/$(printf "e%.60d" 0)/$(printf "f%.60d" 0)"
  mkdir -p secret empty "ünï-dir" "dir with spaces" nobody-dir app-dir "$L"
  echo x > secret/f && chmod 0600 secret/f && chown 999:999 secret/f
  chmod 0700 secret && chown 999:999 secret
  echo hl > a && ln a a.hardlink && ln -s a a.symlink && ln -s missing dangling && mkfifo fifo
  echo deep > "$L/f.txt"; echo u > "ünï-dir/ü.txt"; echo s > "dir with spaces/x y.txt"
  N="$(printf "n%.200d" 0)"; echo long > "$N"
  echo exec > run.sh && chmod 0755 run.sh && chown 1000:1000 run.sh
  chown 70:70 empty && chmod 0750 empty
  echo n > nobody-dir/f && chown -R 65534:65534 nobody-dir && chmod 0750 nobody-dir
  echo a > app-dir/f && chown -R 1000:1000 app-dir && chmod 0755 app-dir
  touch -h -t 202301151030.45 a big.bin run.sh fifo "$N" secret/f nobody-dir/f app-dir/f "$L/f.txt" "ünï-dir/ü.txt" "dir with spaces/x y.txt"' _ "$SRCDEV" "$MIB"
lab_log "fixture ready"
