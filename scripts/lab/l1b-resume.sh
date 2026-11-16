#!/usr/bin/env bash
# L1b: interrupt and resume.
#  1. kill -9 the migrator at ~50%: the rerun is refused while the dead run's lease is fresh ("another migrator run is
#     active"), then, after MIGRATION_VX_STALE_MS (30 s here), it resumes: the committed parts are NOT re-sent, the volume is
#     applied and equals the source.
#  2. a graceful interrupt (docker stop = SIGTERM) releases the lease at once: the rerun is accepted immediately, and the
#     source container is never started.
#  3. a source that changed between runs is refused (volume-diverged) with no part sent; --reset-volume recovers.
# The first run of each case goes through the throttle proxy (L1B_RATE MB/s) so "about half way" is a window, not a race.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap lab_proxy_stop EXIT

MIB="${L1B_MIB:-1024}"
RATE="${L1B_RATE:-20}"
KILL_AT=$(( MIB / 128 / 2 ))   # part index ~ half way
[ "$KILL_AT" -ge 2 ] || KILL_AT=2

start_slow() { # <tag>: a migration through the throttle proxy, in the background
  lab_proxy_start "$RATE"
  lab_run_bg "$1" --hub "$LAB_PROXY_URL" --arms all --part-mib 128
}

# ---------------- case 1: kill -9, lease refusal, resume ----------------
lab_scenario_begin l1b-kill
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" "$MIB" random
start_slow first
lab_wait_part first "$KILL_AT"
lab_kill9_migrator
rc="$(lab_run_wait first 120)"
lab_log "killed run exit $rc"
lab_check "the killed run did not report success" test "$rc" != 0
lab_proxy_stop

lab_run immediate --arms all --part-mib 128
lab_check "an immediate rerun is refused while the dead lease is fresh (UX finding if it is not)" test "$(lab_item immediate reason)" = another-run-active
lab_log "the user sees: state=$(lab_item immediate state) reason=$(lab_item immediate reason)"

# after STALE_MS the lease is stale and the rerun takes over (retry every 10 s up to 3 minutes)
resumed=0
for i in $(seq 1 18); do
  sleep 10
  lab_run after --arms all --part-mib 128
  if [ "$(lab_item after reason)" != another-run-active ]; then resumed=1; break; fi
done
[ "$resumed" = 1 ] || lab_die "the dead run's lease never expired (MIGRATION_VX_STALE_MS=30000)"
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.after.log" >&2; lab_die "resumed run exit $LAB_RC"; }
lab_expect_item after volume-applied

# the committed parts were skipped (hash compare only), not re-sent: the resumed run's first reported part is where the
# killed run stopped, and no index appears in both logs
first_resumed="$(lab_first_part after)"
last_killed="$(lab_last_part first)"
lab_log "killed run committed up to part $last_killed; the resumed run started sending at part $first_resumed"
lab_check "the resumed run did not restart from part 0" test "$first_resumed" -gt 0
lab_check "no part index was sent by both runs" test "$first_resumed" -gt "$last_killed"
lab_no_leftovers
lab_source_untouched
lab_compare

# ---------------- case 2: graceful interrupt releases the lease ----------------
lab_scenario_begin l1b-term
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" "$MIB" random
start_slow term1
lab_wait_part term1 2
docker stop "$(lab_migrator_containers)" >/dev/null
rc="$(lab_run_wait term1 120)"
lab_log "stopped run exit $rc (130 expected)"
lab_proxy_stop
lab_run term2 --arms all --part-mib 128
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.term2.log" >&2; lab_die "rerun after SIGTERM exit $LAB_RC (the lease must be released at once)"; }
lab_expect_item term2 volume-applied
lab_check "the source container was never started" test "$(docker inspect -f '{{.State.StartedAt}}' "$SRC_CONTAINER" | cut -c1-4)" = 0001
lab_no_leftovers
lab_compare

# ---------------- case 3: divergence and --reset-volume ----------------
lab_scenario_begin l1b-diverge
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" "$MIB" random
start_slow div1
lab_wait_part div1 2
lab_kill9_migrator
lab_run_wait div1 120 >/dev/null
lab_proxy_stop
docker run --rm -v "$SRC_VOLUME":/data "$(lab_helper_image)" sh -c 'printf x >> /data/big.bin'   # the source changed
for i in $(seq 1 18); do
  sleep 10
  lab_run div2 --arms all --part-mib 128
  [ "$(lab_item div2 reason)" != another-run-active ] && break
done
lab_expect_item div2 volume-diverged
lab_check "a diverged resume sent no part" test "$(grep -c -E '^ *part [0-9]+ ' "$LAB_DIR/run.div2.log" || true)" = 0
lab_run div3 --arms all --part-mib 128 --reset-volume "$ITEMREF"
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.div3.log" >&2; lab_die "--reset-volume run exit $LAB_RC"; }
lab_expect_item div3 volume-applied
lab_no_leftovers
lab_compare

lab_pass "L1b interrupt, resume, divergence"
