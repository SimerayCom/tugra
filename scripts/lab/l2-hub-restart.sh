#!/usr/bin/env bash
# L2: the hub is killed (SIGKILL, a crash) and restarted
#   A. mid-part: a slow part is in flight on the target; the migrator rides the outage (--hub-outage-wait) and the run ends
#      volume-applied with an identical volume, with no operator action.
#   B. mid-apply: the hub dies while the target applies; vx-recovery settles the apply from the target's markers: DONE, one
#      copy, identical volume, no rollback snapshot left.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap 'lab_proxy_stop; "$LAB_SELF_DIR/hub.sh" reset-extra >/dev/null 2>&1 || true' EXIT

# ---------------- A: mid-part (32 MiB parts through a 2 MB/s link: a part takes ~16 s) ----------------
"$LAB_SELF_DIR/hub.sh" restart MIGRATION_VX_PART_MIB=32
lab_scenario_begin l2-part
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" "${L2A_MIB:-128}" random
lab_proxy_start 2
lab_run_bg partrun --hub "$LAB_PROXY_URL" --arms all --part-mib 32 --hub-outage-wait 10m
# a part is in flight on the target when a p.NNNNN.tmp exists in the staging dir
lab_wait 300 "a part in flight on the target" bash -c "docker exec ${LAB_AGENT:-lab-agent} sh -c 'ls /etc/tugra/app-moves/*/0/ 2>/dev/null' | grep -q 'tmp'"
lab_log "a part is in flight: killing the hub"
"$LAB_SELF_DIR/hub.sh" kill
sleep 20
"$LAB_SELF_DIR/hub.sh" start
rc="$(lab_run_wait partrun 1200)"
[ "$rc" = 0 ] || { tail -40 "$LAB_DIR/run.partrun.log" >&2; lab_die "mid-part: migrator exit $rc"; }
lab_expect_item partrun volume-applied
lab_proxy_stop
lab_no_leftovers
lab_compare
lab_pass "L2-A hub restart mid-part"

# ---------------- B: mid-apply (default 128 MiB parts, direct) ----------------
"$LAB_SELF_DIR/hub.sh" restart MIGRATION_VX_PART_MIB=128
lab_scenario_begin l2-apply
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" "${L2B_MIB:-1536}" random
lab_run_bg applyrun --arms all --part-mib 128
caught=0
for _ in $(seq 1 3600); do
  st="$(lab_transfer_state)"
  if [ "$st" = APPLYING ]; then caught=1; break; fi
  if [ "$st" = DONE ] || [ -f "$LAB_DIR/run.applyrun.rc" ]; then break; fi
  sleep 0.5
done
[ "$caught" = 1 ] || lab_die "the APPLYING window was missed (raise L2B_MIB): the apply finished before the hub could be killed"
lab_log "apply in progress: killing the hub"
"$LAB_SELF_DIR/hub.sh" kill
sleep 5
"$LAB_SELF_DIR/hub.sh" start
rc="$(lab_run_wait applyrun 1800)"
[ "$rc" = 0 ] || { tail -40 "$LAB_DIR/run.applyrun.log" >&2; lab_die "mid-apply: migrator exit $rc"; }
lab_expect_item applyrun volume-applied
lab_wait 120 "the transfer to settle DONE" bash -c "[ \"\$(node $LAB_SELF_DIR/seed.mjs transfer $OP_ID | awk '{print \$1}')\" = DONE ]"
lab_check "still the first attempt: the recovery settled the apply, it did not start a second copy" bash -c "[ \"\$(node $LAB_SELF_DIR/seed.mjs transfer $OP_ID | awk '{print \$4}')\" = 1 ]"
lab_no_leftovers
lab_compare
lab_pass "L2 hub restart mid-part and mid-apply"
