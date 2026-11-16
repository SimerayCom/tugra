#!/usr/bin/env bash
# L8: relay seats. Migration parts draw from their OWN seat pool (MIGRATION_RELAY_CONCURRENCY), never the app-move pool
# (MOVE_MAX_CONCURRENT_RELAYS). The hub runs with ONE seat in each pool.
#  A. two migrator runs (two ops, two source volumes) race for the single migration seat: the second sees `busy` (an uncounted,
#     jittered backoff) and both finish volume-applied, with no part failure.
#  B. while A runs, a real app move (a deployed app with data, to a second agent) proceeds through the app-move pool. This
#     leg is OBSERVATIONAL: both "servers" are one docker host sharing /etc/tugra and the docker daemon, so a failure of the
#     move itself is reported (MOVE: ...) but only a move that is STARVED by the migration (stuck behind it) fails the lab.
#     Set L8_MOVE=0 to skip it.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap '"$LAB_SELF_DIR/hub.sh" reset-extra >/dev/null 2>&1 || true' EXIT

MIB="${L8_MIB:-512}"
"$LAB_SELF_DIR/hub.sh" restart MIGRATION_RELAY_CONCURRENCY=1 MOVE_MAX_CONCURRENT_RELAYS=1

# op 1 (main) and op 2 (second) on the same target server, with their own source container and volume
lab_scenario_begin l8-a
SRC1_C="$SRC_CONTAINER"; SRC1_V="${SRC_VOLUME:-lab-src}"; DEST1="$DEST_VOLUME"
"$LAB_SELF_DIR/fixture.sh" "$SRC1_V" "$MIB" random
docker rm -f labsrc2 >/dev/null 2>&1 || true
docker volume rm -f lab-src2 >/dev/null 2>&1 || true
docker volume create lab-src2 >/dev/null
docker create --name labsrc2 -v lab-src2:/var/www/data alpine:3.21 sleep 86400 >/dev/null
lab_seed op --name "lab-l8-b-$(date +%s)" --source labsrc2 >"$LAB_DIR/op.second.env"
"$LAB_SELF_DIR/fixture.sh" lab-src2 "$MIB" random

# the move leg's setup: a second agent (server B) and an app deployed on the target (server A) with data in its volume.
# Observational: any failure here only turns the leg into "setup-failed" in the summary.
move_setup() {
  [ -f "$LAB_DIR/b.env" ] || lab_seed server --name lab-b --prefix B >"$LAB_DIR/b.env"
  # shellcheck disable=SC1091
  . "$LAB_DIR/b.env"
  docker rm -f lab-agent-b >/dev/null 2>&1 || true
  docker volume rm -f lab-agent-b-state >/dev/null 2>&1 || true
  docker run -d --name lab-agent-b --restart unless-stopped \
    -v /var/run/docker.sock:/var/run/docker.sock -v lab-agent-b-state:/root/.tugra -v /etc/tugra:/etc/tugra \
    -e "TUGRA_HUB=ws://${LAB_HOST}:${LAB_HUB_PORT}/agent" -e "TUGRA_TOKEN=${B_ENROLL_TOKEN}" -e "TUGRA_AGENT_IMAGE=${LAB_IMAGE}" \
    "$LAB_IMAGE" >/dev/null
  lab_wait 90 "server B ONLINE" bash -c "[ \"\$(node $LAB_SELF_DIR/seed.mjs server-status $B_SERVER_ID)\" = ONLINE ]"
  local name="lab-move-$(date +%s)"
  lab_seed app --name "$name" >"$LAB_DIR/move.env"
  # shellcheck disable=SC1091
  . "$LAB_DIR/move.env"
  lab_api POST "/apps/$APP_ID/deploy" '{}' >/dev/null
  lab_wait 300 "the move app to be RUNNING" bash -c "curl -fsS -H \"Authorization: Bearer \$(cat $LAB_DIR/user.token)\" http://127.0.0.1:${LAB_HUB_PORT}/api/v1/apps/$APP_ID | grep -q '\"status\":\"RUNNING\"'"
  docker run --rm -v "$APP_VOLUME":/data "$(lab_helper_image)" sh -c 'dd if=/dev/urandom of=/data/move.bin bs=1048576 count=256 2>/dev/null'
  echo "MOVE_NAME=$name" >>"$LAB_DIR/move.env"
  echo "B_SERVER_ID=$B_SERVER_ID" >>"$LAB_DIR/move.env"
}

MOVE_OK=skipped
if [ "${L8_MOVE:-1}" = 1 ]; then
  if (move_setup) >"$LAB_DIR/move-setup.log" 2>&1; then MOVE_OK=ready; else MOVE_OK=setup-failed; lab_log "MOVE: setup failed (see $LAB_DIR/move-setup.log)"; fi
fi

# A: two concurrent migrations, each in the background
lab_op_load main
lab_run_bg m1 --arms all --part-mib 128
LAB_OP=second lab_run_bg m2 --arms all --part-mib 128
t0=$(date +%s)

# B: the move, started while both migrations stream; polled until it ends (or stays stuck 5 minutes after the migrations)
if [ "$MOVE_OK" = ready ]; then
  # shellcheck disable=SC1091
  . "$LAB_DIR/move.env"
  lab_wait_part m1 1
  pf="$(lab_api POST "/apps/$APP_ID/move/preflight" "{\"targetServerId\":\"$B_SERVER_ID\"}" 2>&1 || true)"
  if node -e 'try{process.exit(JSON.parse(process.argv[1]).ok===true?0:1)}catch{process.exit(1)}' "$pf" 2>/dev/null; then
    started="$(lab_api POST "/apps/$APP_ID/move" "{\"targetServerId\":\"$B_SERVER_ID\",\"confirmName\":\"$MOVE_NAME\"}" 2>&1 || true)"
    MOVE_ID="$(node -e 'try{console.log(JSON.parse(process.argv[1]).moveId||"")}catch{console.log("")}' "$started" 2>/dev/null)"
    if [ -n "$MOVE_ID" ]; then
      MOVE_OK=running
      grace=0
      while :; do
        mphase="$(lab_api GET "/apps/$APP_ID/moves/$MOVE_ID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).phase))')"
        case "$mphase" in COMPLETED | FAILED | ROLLED_BACK) MOVE_OK="$mphase"; break ;; esac
        if [ -f "$LAB_DIR/run.m1.rc" ] && [ -f "$LAB_DIR/run.m2.rc" ]; then
          grace=$((grace + 1))
          if [ "$grace" -gt 150 ]; then MOVE_OK="STUCK-$mphase"; break; fi
        fi
        sleep 2
      done
      lab_log "MOVE: $MOVE_OK after $(( $(date +%s) - t0 )) s (one docker host: a FAILED or ROLLED_BACK move is a topology finding, a STUCK one is starvation)"
    else
      MOVE_OK="not-started"; lab_log "MOVE: not started: $started"
    fi
  else
    MOVE_OK="preflight-refused"; lab_log "MOVE: preflight refused on this single-host topology: $pf"
  fi
fi

rc1="$(lab_run_wait m1 1800)"; rc2="$(lab_run_wait m2 1800)"
t1=$(( $(date +%s) - t0 ))
lab_log "migrations finished in ${t1} s: exits $rc1 / $rc2; move: $MOVE_OK"
[ "$rc1" = 0 ] || { tail -30 "$LAB_DIR/run.m1.log" >&2; lab_die "migration 1 exit $rc1"; }
[ "$rc2" = 0 ] || { tail -30 "$LAB_DIR/run.m2.log" >&2; lab_die "migration 2 exit $rc2"; }
lab_expect_item m1 volume-applied
(lab_op_load second; lab_expect_item m2 volume-applied)
for t in m1 m2; do
  lab_check "no part failed ($t): busy is waited out, never counted" bash -c "! grep -q -E 'part-failed|ErrPartFailed|could not be delivered' $LAB_DIR/run.$t.log"
done
case "$MOVE_OK" in STUCK-*) lab_die "the app move never progressed while migrations held the migration seat: $MOVE_OK (starvation across pools)" ;; esac
lab_no_leftovers
lab_compare
(lab_op_load second; SRC_VOLUME=lab-src2 lab_compare)
echo "L8_MOVE=$MOVE_OK" >>"$LAB_DIR/l8.summary"
lab_pass "L8 relay seats (move leg: $MOVE_OK)"
