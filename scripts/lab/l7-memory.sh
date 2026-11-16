#!/usr/bin/env bash
# L7: the migrator's memory under its 768 MiB container cap (--memory=768m --memory-swap=768m: an overrun is an OOM kill,
# exit 137, with no message). Run on INCOMPRESSIBLE data (every member is ~128 MiB, the worst case) and on zeros (best case).
# Pass: exit 0, no OOM event, peak under 700 MiB (a peak above 640 MiB is flagged). L7_MIB (default 3072) is the volume size.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MIB="${L7_MIB:-3072}"
PEAK_FAIL=700
PEAK_WARN=640

mem_mib() { # "123.4MiB / 768MiB" -> 123 (integer MiB of the usage half)
  awk '{u=$1; sub(/\/.*/,"",u); v=u+0; if (u ~ /GiB/) v*=1024; else if (u ~ /KiB|kB/) v/=1024; else if (u ~ /MiB/) v=v; else if (u ~ /B$/) v/=1048576; printf "%d\n", v}' <<<"$1"
}

run_case() { # <random|zeros>
  local kind="$1" tag="mem-$1" peak=0 sample c oom_pid
  lab_scenario_begin "l7-$kind"
  "$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" "$MIB" "$kind"
  : >"$LAB_DIR/oom.$kind.log"
  docker events --filter type=container --filter event=oom >"$LAB_DIR/oom.$kind.log" 2>&1 &
  oom_pid=$!
  : >"$LAB_DIR/mem.$kind.log"
  lab_run_bg "$tag" --arms all --part-mib 128
  # sample the migrator container once a second until the run ends
  local capped=0
  while [ ! -f "$LAB_DIR/run.$tag.rc" ]; do
    c="$(lab_migrator_containers | head -1)"
    if [ -n "$c" ]; then
      if [ "$capped" = 0 ]; then
        lab_check "the migrator runs under --memory=768m (got $(docker inspect -f '{{.HostConfig.Memory}}' "$c"))" test "$(docker inspect -f '{{.HostConfig.Memory}}' "$c")" = 805306368
        capped=1
      fi
      sample="$(docker stats --no-stream --format '{{.MemUsage}}' "$c" 2>/dev/null || true)"
      if [ -n "$sample" ]; then
        echo "$(date -u +%T) $sample" >>"$LAB_DIR/mem.$kind.log"
        local m; m="$(mem_mib "$sample")"
        [ "$m" -gt "$peak" ] && peak="$m"
      fi
    fi
    sleep 1
  done
  kill "$oom_pid" 2>/dev/null || true
  local rc; rc="$(cat "$LAB_DIR/run.$tag.rc")"
  lab_log "L7 $kind: exit $rc, peak ${peak} MiB (cap 768, fail > ${PEAK_FAIL}, warn > ${PEAK_WARN}); samples in $LAB_DIR/mem.$kind.log"
  [ "$capped" = 1 ] || lab_die "the migrator container was never observed"
  lab_check "no OOM event was reported by docker" test ! -s "$LAB_DIR/oom.$kind.log"
  [ "$rc" != 137 ] || lab_die "exit 137: the migrator was OOM-killed"
  [ "$rc" = 0 ] || { tail -30 "$LAB_DIR/run.$tag.log" >&2; lab_die "migrator exit $rc"; }
  lab_expect_item "$tag" volume-applied
  [ "$peak" -le "$PEAK_FAIL" ] || lab_die "peak memory ${peak} MiB exceeds ${PEAK_FAIL} MiB"
  [ "$peak" -le "$PEAK_WARN" ] || lab_log "WARNING: peak memory ${peak} MiB is above ${PEAK_WARN} MiB"
  echo "L7_PEAK_${kind}=${peak}" >>"$LAB_DIR/l7.summary"
  lab_no_leftovers
  if [ "$kind" = random ]; then lab_compare; fi
  # free the disk before the next case (the volumes are recreated by the next scenario)
  docker volume rm -f "$DEST_VOLUME" >/dev/null 2>&1 || true
}

: >"$LAB_DIR/l7.summary"
run_case random
run_case zeros
cat "$LAB_DIR/l7.summary" >&2
lab_pass "L7 memory bound"
