#!/usr/bin/env bash
# L9: the largest database of the real estate. A RUNNING, uuid-named PostgreSQL whose data is a multi-GB
# append-only time-series table (L9_GIB, default 4; the real one is about 31 GB, see the runbook for the larger runner), copied with
# --stop-source. One run per image (a CI matrix):
#   L9_IMAGE=postgres:17-alpine  the physical path: the migrator stops ONLY the source, the gates pass, the copy applies, the
#                                database the hub starts holds the frozen row count and pg_total_relation_size
#   L9_IMAGE=postgres:18-alpine  the layout gate refuses (and the migrator RESTARTS the source it stopped), and the logical dump the
#                                gate leaves is over the hub's 256 MiB artifact cap: `dump-too-big`. That is the fleet's finding: the
#                                biggest database has no automatic lane on PostgreSQL 18 (see the runbook)
# L9_RATE=<MB/s> sends the physical copy through the throttle proxy (the "L1c" run of the big database on a slow link). The copy time is
# recorded in $LAB_DIR/l9.summary.
set -euo pipefail
# shellcheck source=fleet.sh
. "$(dirname "${BASH_SOURCE[0]}")/fleet.sh"

IMAGE="${L9_IMAGE:?set L9_IMAGE, e.g. postgres:17-alpine}"
MAJOR="$(fleet_pg_major "$IMAGE")"
[ -n "$MAJOR" ] || lab_die "cannot read the PostgreSQL major from $IMAGE (set L6_MAJOR)"
MIB=$(( ${L9_GIB:-4} * 1024 ))
LAYOUT_TEXT="PostgreSQL 18 data layout is not supported by Tugra database volumes yet"
export SRC_VOLUME=lab-fleet-pg
trap lab_proxy_stop EXIT

lab_guard_destructive
fleet_cleanup
SRC="$(fleet_uuid)"
LAB_SKIP_SOURCE=1 lab_scenario_begin "l9-$MAJOR" --kind db --image "$IMAGE" --version "$MAJOR" --source "$SRC"
docker volume rm -f "$SRC_VOLUME" >/dev/null 2>&1 || true

# the source host: the database plus other running containers the run must leave alone
NEIGHBOR_A="$(fleet_uuid)"; NEIGHBOR_B="$(fleet_uuid)"
fleet_redis "$NEIGHBOR_A"; fleet_redis "$NEIGHBOR_B"
fleet_pg_source "$SRC" "$IMAGE" "$SRC_VOLUME"
fleet_pg_load_ticks "$SRC" "$MIB"
SRC_COUNT="$(fleet_pg_sql "$SRC" 'select count(*) from ticks')"
SRC_SIZE="$(fleet_pg_sql "$SRC" "select pg_total_relation_size('ticks')")"
lab_log "source $SRC: $SRC_COUNT rows, $SRC_SIZE bytes (frozen before the stop)"
lab_check "the source holds at least the requested size" test "$SRC_SIZE" -ge $(( MIB * 1048576 ))
lab_check "the source is a RUNNING container with a 24 character name" bash -c "[ ${#SRC} = 24 ] && docker inspect -f '{{.State.Running}}' $SRC | grep -qx true"
OTHERS_BEFORE="$(fleet_snapshot_others "$SRC")"
: >"$LAB_DIR/l9.summary"
echo "L9_IMAGE=$IMAGE L9_MIB=$MIB L9_SRC_BYTES=$SRC_SIZE L9_SRC_ROWS=$SRC_COUNT" >>"$LAB_DIR/l9.summary"

# a running source is never stopped without --stop-source; with it, a dry run only says it would
lab_run dry --arms all --dry-run
lab_expect_item dry volume-skipped-running
lab_check "the dry run left the source running" fleet_running "$SRC"
lab_run plan --arms all --dry-run --stop-source
lab_log "dry run with --stop-source: state $(lab_item plan state) reason $(lab_item plan reason) disk $(lab_item plan disk) pgMajor $(lab_item plan pgMajor) pgLayout $(lab_item plan pgLayout) rawBytes $(lab_item plan rawBytes)"
lab_check "a dry run never stops the source" fleet_running "$SRC"
lab_check "the inventory counts the whole data directory (at least the table)" test "$(lab_item plan rawBytes)" -ge "$SRC_SIZE"
if [ "$MAJOR" -lt 18 ]; then lab_expect_item plan planned would-stop-source; fi

hubargs=()
if [ -n "${L9_RATE:-}" ]; then lab_proxy_start "$L9_RATE"; hubargs=(--hub "$LAB_PROXY_URL"); fi

if [ "$MAJOR" -ge 18 ]; then
  # 18: the layout gate refuses AFTER the migrator stopped the source; the source must be running again
  lab_run gate ${hubargs[@]+"${hubargs[@]}"} --arms all --stop-source
  lab_expect_item gate failed "$LAYOUT_TEXT"
  lab_check "the source the migrator stopped for the refused copy is running again" fleet_running "$SRC"
  lab_check "no transfer was started" test "$(lab_transfer | awk '{print $1}')" = NONE
  # the lane the gate leaves is the logical dump, capped at the hub's artifact size (256 MiB compressed)
  lab_seed op --name "lab-logical-$(date +%s)" --source "$SRC" --kind db --image "$IMAGE" --version "$MAJOR" --engine POSTGRES --data-mode dump >"$LAB_DIR/op.logical.env"
  LAB_OP=logical lab_run logical --arms databases
  if [ "$MIB" -ge 1024 ]; then
    (lab_op_load logical; lab_expect_item logical failed dump-too-big)
    echo "L9_LOGICAL=dump-too-big (the biggest database has no automatic lane on PostgreSQL 18)" >>"$LAB_DIR/l9.summary"
  else
    lab_log "skip: $MIB MiB compresses under the 256 MiB artifact cap, no dump-too-big to show"
  fi
  lab_check "the logical attempt left the source running" fleet_running "$SRC"
  lab_check "nothing else on the host changed" test "$OTHERS_BEFORE" = "$(fleet_snapshot_others "$SRC")"
  lab_pass "L9 $IMAGE: layout gate refuses, the source is restarted, the logical lane is over the cap"
  exit 0
fi

# 16 / 17: the physical copy, freezing the source with --stop-source
t0=$(date +%s)
lab_run copy ${hubargs[@]+"${hubargs[@]}"} --arms all --stop-source
secs=$(( $(date +%s) - t0 ))
[ "$LAB_RC" = 0 ] || { tail -40 "$LAB_DIR/run.copy.log" >&2; lab_die "migrator exit $LAB_RC"; }
lab_expect_item copy volume-applied
echo "L9_COPY_SECONDS=$secs L9_PARTS=$(lab_item copy parts)" >>"$LAB_DIR/l9.summary"
lab_log "L9 copy of $(( SRC_SIZE / 1048576 )) MiB took ${secs} s (stop, stream, apply, start): $(( SRC_SIZE / 1048576 / (secs > 0 ? secs : 1) )) MiB/s"
read -r state _ <<<"$(lab_transfer)"
lab_check "the hub transfer is DONE" test "$state" = DONE
lab_no_leftovers
lab_check "the migrator stopped the source (and only the source)" bash -c "! docker inspect -f '{{.State.Running}}' $SRC | grep -qx true"
lab_check "no other container on the host was stopped, started or removed (bar the database the hub started)" test "$OTHERS_BEFORE" = "$(fleet_snapshot_others "$SRC" "tugra_db_$DB_ID")"
lab_log "the source stopped with exit code $(docker inspect -f '{{.State.ExitCode}}' "$SRC") (0 = a clean shutdown: no WAL replay is expected on the target)"

lab_wait 300 "the destination database to be RUNNING" bash -c "[ \"\$(node $LAB_SELF_DIR/seed.mjs db-status $DB_ID | awk '{print \$1}')\" = RUNNING ]"
CTR="tugra_db_$DB_ID"
lab_wait 120 "the destination postgres to accept connections" docker exec "$CTR" pg_isready
DST_COUNT="$(docker exec "$CTR" psql -U tugra -d postgres -At -c 'select count(*) from ticks')"
DST_SIZE="$(docker exec "$CTR" psql -U tugra -d postgres -At -c "select pg_total_relation_size('ticks')")"
lab_log "target: $DST_COUNT rows, $DST_SIZE bytes"
lab_check "the row count equals the source ($SRC_COUNT)" test "$DST_COUNT" = "$SRC_COUNT"
lab_check "pg_total_relation_size equals the source ($SRC_SIZE)" test "$DST_SIZE" = "$SRC_SIZE"
lab_pass "L9 $IMAGE: $(( SRC_SIZE / 1048576 )) MiB time-series copied in ${secs} s, rows and size equal"
