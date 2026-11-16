#!/usr/bin/env bash
# L8: relay seats. Migration parts draw from their OWN seat pool (MIGRATION_RELAY_CONCURRENCY), never the app-move pool
# (MOVE_MAX_CONCURRENT_RELAYS). The hub runs with ONE seat in each pool (L8_SEATS sets the migration pool, default 1).
# The real estate has 23 source hosts and one hub: L8_MIGRATORS=4 L8_SEATS=2 runs four migrators from four different sources against
# two seats (the CI matrix does both shapes). Each later migrator starts once the previous one committed a part.
#  A. two migrator runs (two ops, two source volumes) race for the single migration seat: the second sees `busy` (an uncounted,
#     jittered backoff) and both finish volume-applied, with no part failure. Both go through scripts/lab/http-tap.mjs, which
#     counts the hub's {"busy":true} answers: zero would mean the pool was never contended and the scenario proved nothing.
#     The second migrator starts only after the first is streaming: every migrator removes ALL helper containers labelled
#     tugra.vx=1 at its start (reapStaleHelpers, no run scoping), so two starting together would delete each other's live
#     inventory and tar helpers (a harness-induced failure; the product finding is in the runbook).
#  B. while A runs, a real app move (a deployed app with data, to a second agent) proceeds through the app-move pool. This
#     leg is OBSERVATIONAL: both "servers" are one docker host sharing /etc/tugra and the docker daemon, so a failure of the
#     move itself is reported (MOVE: ...) but only a move that is STARVED by the migration (stuck behind it) fails the lab.
#     Pool separation is shown directly: the summary records how many parts the move committed WHILE the migration pool was
#     answering `busy` (the move draws from MOVE_MAX_CONCURRENT_RELAYS, which is free). Set L8_MOVE=0 to skip it.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
trap 'lab_tap_stop; "$LAB_SELF_DIR/hub.sh" reset-extra >/dev/null 2>&1 || true' EXIT

MIB="${L8_MIB:-512}"
N="${L8_MIGRATORS:-2}"
SEATS="${L8_SEATS:-1}"
case "$N" in 2 | 3 | 4) ;; *) lab_die "L8_MIGRATORS must be 2, 3 or 4" ;; esac
[ "$N" -gt "$SEATS" ] || lab_die "L8_MIGRATORS ($N) must exceed L8_SEATS ($SEATS), or no migrator is ever told busy"
"$LAB_SELF_DIR/hub.sh" restart "MIGRATION_RELAY_CONCURRENCY=$SEATS" MOVE_MAX_CONCURRENT_RELAYS=1

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
# migrators 3 and 4: their own source container, volume and op (op.m3.env, op.m4.env)
n=3
while [ "$n" -le "$N" ]; do
  docker rm -f "labsrc$n" >/dev/null 2>&1 || true
  docker volume rm -f "lab-src$n" >/dev/null 2>&1 || true
  docker volume create "lab-src$n" >/dev/null
  docker create --name "labsrc$n" -v "lab-src$n:/var/www/data" alpine:3.21 sleep 86400 >/dev/null
  lab_seed op --name "lab-l8-m$n-$(date +%s)" --source "labsrc$n" >"$LAB_DIR/op.m$n.env"
  "$LAB_SELF_DIR/fixture.sh" "lab-src$n" "$MIB" random
  n=$((n + 1))
done

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
lab_tap_start
lab_run_bg m1 --hub "$LAB_TAP_URL" --arms all --part-mib 128
t0=$(date +%s)
# m2 only once m1 has passed its startup (helper reaping) and committed a part, so it contends for the seat while m1 streams
lab_wait_part m1 0
LAB_OP=second lab_run_bg m2 --hub "$LAB_TAP_URL" --arms all --part-mib 128
# migrators 3 and 4, each once the one before it is streaming (reapStaleHelpers is not run-scoped, see the runbook)
n=3
while [ "$n" -le "$N" ]; do
  lab_wait_part "m$((n - 1))" 0
  LAB_OP="m$n" lab_run_bg "m$n" --hub "$LAB_TAP_URL" --arms all --part-mib 128
  n=$((n + 1))
done

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
      move_parts_during=0 # max parts the move had committed while a migration was still running
      busy_during=0       # busy answers the migrators had received by then
      while :; do
        mview="$(lab_api GET "/apps/$APP_ID/moves/$MOVE_ID")"
        mphase="$(node -e 'console.log(JSON.parse(process.argv[1]).phase)' "$mview")"
        if [ ! -f "$LAB_DIR/run.m1.rc" ] || [ ! -f "$LAB_DIR/run.m2.rc" ]; then
          mp="$(node -e 'try{console.log((JSON.parse(process.argv[1]).volumes||[]).reduce((n,v)=>n+(Number(v.partsDone)||0),0))}catch{console.log(0)}' "$mview")"
          [ "$mp" -le "$move_parts_during" ] || { move_parts_during="$mp"; busy_during="$(lab_tap_busy)"; }
        fi
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

tags=(m1 m2); n=3; while [ "$n" -le "$N" ]; do tags+=("m$n"); n=$((n + 1)); done
rcs=""
for t in "${tags[@]}"; do rcs="$rcs $(lab_run_wait "$t" 1800)"; done
t1=$(( $(date +%s) - t0 ))
lab_log "migrations finished in ${t1} s: exits${rcs}; move: $MOVE_OK"
for t in "${tags[@]}"; do
  rc="$(cat "$LAB_DIR/run.$t.rc")"
  [ "$rc" = 0 ] || { tail -30 "$LAB_DIR/run.$t.log" >&2; lab_die "migration $t exit $rc"; }
done
lab_expect_item m1 volume-applied
(lab_op_load second; lab_expect_item m2 volume-applied)
n=3; while [ "$n" -le "$N" ]; do (lab_op_load "m$n"; lab_expect_item "m$n" volume-applied); n=$((n + 1)); done
busy_total="$(lab_tap_busy)"
lab_log "the hub answered busy $busy_total time(s) to the $N migrators (migration relay pool of $SEATS seat(s))"
lab_check "the migration seat pool was contended (the migrators saw busy at least once): without that L8 proves nothing" test "$busy_total" -ge 1
for t in "${tags[@]}"; do
  lab_check "no part failed ($t): busy is waited out, never counted" bash -c "! grep -q -E 'part-failed|ErrPartFailed|could not be delivered' $LAB_DIR/run.$t.log"
done
case "$MOVE_OK" in STUCK-*) lab_die "the app move never progressed while migrations held the migration seat: $MOVE_OK (starvation across pools)" ;; esac
lab_no_leftovers
lab_compare
(lab_op_load second; SRC_VOLUME=lab-src2 lab_compare)
n=3; while [ "$n" -le "$N" ]; do (lab_op_load "m$n"; SRC_VOLUME="lab-src$n" lab_compare); n=$((n + 1)); done
if [ "$MOVE_OK" != skipped ] && [ "$MOVE_OK" != setup-failed ]; then
  if [ "${move_parts_during:-0}" -ge 1 ] && [ "${busy_during:-0}" -ge 1 ]; then
    lab_log "pool separation shown: the move had committed $move_parts_during part(s) while the migrators had already been told busy $busy_during time(s)"
    echo "L8_SEPARATION=shown move_parts=$move_parts_during busy=$busy_during" >>"$LAB_DIR/l8.summary"
  else
    lab_log "pool separation NOT shown by this run (the move committed ${move_parts_during:-0} part(s) during the migrations, busy answers by then ${busy_during:-0}): inconclusive, see the move log"
    echo "L8_SEPARATION=inconclusive move_parts=${move_parts_during:-0} busy=${busy_during:-0}" >>"$LAB_DIR/l8.summary"
  fi
fi
echo "L8_MIGRATORS=$N L8_SEATS=$SEATS L8_MOVE=$MOVE_OK busy=$busy_total" >>"$LAB_DIR/l8.summary"
lab_pass "L8 relay seats (move leg: $MOVE_OK)"
