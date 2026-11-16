#!/usr/bin/env bash
# L0: --dry-run inventory + disk check. Nothing may move, stop, start, stage or be written on the hub besides the stored
# inventory. Then three negative cases: a running source (with and without --stop-source: a dry run never stops it), an insufficient
# target disk, a device node in the source. The real fleet's sources are RUNNING, uuid-named containers: scripts/lab/l12-fleet-hosts.sh.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

lab_scenario_begin l0
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" "${L0_MIB:-256}" random
snap_before="$(lab_docker_snapshot)"

lab_run dry --arms all --dry-run
[ "$LAB_RC" = 0 ] || lab_die "dry-run exit $LAB_RC (log: $LAB_DIR/run.dry.log)"
lab_expect_item dry planned
lab_check "disk verdict is ok" test "$(lab_item dry disk)" = ok
lab_check "the inventory reports entries" test "$(lab_item dry entries)" -gt 10
lab_check "the inventory reports raw bytes >= the fixture" test "$(lab_item dry rawBytes)" -ge $(( ${L0_MIB:-256} * 1048576 ))

snap_after="$(lab_docker_snapshot)"
lab_check "docker ps -a is unchanged by a dry run" test "$snap_before" = "$snap_after"
lab_source_untouched
lab_check "nothing is staged on the target" test -z "$(lab_staging_dirs)"
lab_check "the hub has no transfer row" test "$(lab_transfer | awk '{print $1}')" = NONE
inv="$(lab_api GET "/import/operations/$OP_ID/volumes")"
lab_check "GET .../volumes shows the stored inventory" node -e 'const v=JSON.parse(process.argv[1]).volumes[0]; process.exit(v.inventory && v.diskVerdict ? 0 : 1)' "$inv"

# --- negative 1: a running source is skipped (never stopped without --stop-source) ---
docker start "$SRC_CONTAINER" >/dev/null
lab_run running --arms all --dry-run
lab_expect_item running volume-skipped-running
lab_check "the running source was not stopped by the dry run" test "$(docker inspect -f '{{.State.Running}}' "$SRC_CONTAINER")" = true
lab_run wouldstop --arms all --dry-run --stop-source
lab_expect_item wouldstop planned would-stop-source
lab_check "a dry run with --stop-source did not stop the running source either" test "$(docker inspect -f '{{.State.Running}}' "$SRC_CONTAINER")" = true
docker stop -t 0 "$SRC_CONTAINER" >/dev/null

# --- negative 2: the target disk check names its numbers when the volume cannot fit (twice the free space asked, within
#     the hub's 256 GiB per-volume limit, so the verdict comes from the real probe of the target host) ---
avail="$(df -Pk /etc/tugra | awk 'NR==2{print $4}')"
ask=$(( avail * 1024 * 2 + 1073741824 ))
max=$(( 250 * 1073741824 ))
if [ "$ask" -gt "$max" ]; then
  lab_log "skip: $(( avail / 1048576 )) GiB free on /etc/tugra, more than half the hub's per-volume limit (no insufficient size can be asked)"
else
  dc="$(lab_api POST "/import/operations/$OP_ID/volumes/$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$ITEMREF")/disk-check" "{\"rawBytes\":$ask}")"
  lab_log "disk-check $ask bytes: $dc"
  lab_check "an impossible size is not ok, and the verdict is not 'unknown'" node -e 'const d=JSON.parse(process.argv[1]); process.exit(d.ok===false && d.unknown===false ? 0 : 1)' "$dc"
fi

# --- negative 3: a device node in the source refuses the volume ---
docker run --rm -v "$SRC_VOLUME":/data "$(lab_helper_image)" mknod /data/lab-null c 1 3
lab_run special --arms all --dry-run
lab_expect_item special volume-special-files
docker run --rm -v "$SRC_VOLUME":/data "$(lab_helper_image)" rm -f /data/lab-null

lab_pass "L0 dry-run"
