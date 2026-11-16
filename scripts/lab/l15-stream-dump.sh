#!/usr/bin/env bash
# L15: the streamed dump lane (the guided run's largeDbMode "stream-logical") against a REAL database, one run per image (a CI matrix):
#   L15_IMAGE=postgres:17-alpine | pgvector/pgvector:pg17 | postgres:18-alpine | mariadb:11
# The databases of the fleet that have no automatic lane under the default `refuse` (a 31 GB time-series PostgreSQL 18, a 1.8 GB MariaDB)
# are moved by this lane: the pinned dump recipe runs inside the RUNNING, uuid-named source (it is never stopped), its stdout is cut into
# parts, relayed to the target agent and restored there through the engine's own client, with no size cap. The scenario:
#   1. a source with about L15_MIB of data plus the objects a row count cannot see (integrity.sh: sequences, collation, an extension
#      for pgvector, roles and grants for PostgreSQL, users, grants and a routine for MariaDB), fingerprinted before anything moves
#   2. the migrator's measuring dry run plans the streamed row (`would-stream-dump`) and leaves the source running
#   3. THE HUB IS KILLED (SIGKILL) while the dump is in flight, with the migrator behind a throttled link so that is a window and not
#      a race; the migrator rides the outage and the run ends `volume-applied` with no operator action
#   4. the destination the hub started holds the same data (and, for PostgreSQL, still holds it after the hub recreated its container): the strict fingerprint (rows and a checksum over every column, extensions,
#      sequences' last_value, collation, AUTO_INCREMENT) is equal. Roles/users, ownership, grants and routines are compared too and
#      RECORDED as a finding where the lane drops them (the dump runs with --no-owner --no-acl / without --routines); L_INTEGRITY_ACCESS=
#      require makes that a failure.
# A PostgreSQL 18 destination is refused by the hub today (vx-dest-gate.ts dumpDestLayout): the 18 leg fails with that named as a PRODUCT
# FINDING until the destination can keep the cluster, it is not worked around here. The underlying defect is wider than a streamed
# restore: every PostgreSQL 18+ database Tugra provisions keeps its cluster outside its named volume (L16 leg A shows it on a fresh one).
set -euo pipefail
# shellcheck source=fleet.sh
. "$(dirname "${BASH_SOURCE[0]}")/fleet.sh"
# shellcheck source=stream.sh
. "$(dirname "${BASH_SOURCE[0]}")/stream.sh"

IMAGE="${L15_IMAGE:?set L15_IMAGE, e.g. postgres:17-alpine}"
MIB="${L15_MIB:-384}"
RATE="${L15_RATE:-3}"
PW=lab-mariadb-pw-0123456789
export SRC_VOLUME=lab-fleet-l15
trap 'lab_proxy_stop; "$LAB_SELF_DIR/hub.sh" reset-extra >/dev/null 2>&1 || true' EXIT

case "$IMAGE" in
  postgres:* | pgvector/*)
    ENGINE=POSTGRES
    VERSION="$(fleet_pg_major "$IMAGE")"
    [ -n "$VERSION" ] || lab_die "cannot read the PostgreSQL major from $IMAGE"
    ;;
  mariadb:*)
    ENGINE=MARIADB
    VERSION="${IMAGE#mariadb:}"; VERSION="${VERSION%%[!0-9]*}"
    [ -n "$VERSION" ] || lab_die "cannot read the MariaDB major from $IMAGE"
    export FLEET_MARIADB_IMAGE="$IMAGE"
    ;;
  *) lab_die "L15_IMAGE must be a postgres, pgvector or mariadb image (got $IMAGE)" ;;
esac
VEC_ARG=""
case "$IMAGE" in pgvector/*) VEC_ARG=vector ;; esac

lab_guard_destructive
fleet_cleanup
# 32 MiB parts and a stale window that outlives the planned outage (the same reasoning as L2-A: the boot sweep must not declare the run
# dead because the hub was down, which is not what this scenario asks)
"$LAB_SELF_DIR/hub.sh" restart MIGRATION_VX_PART_MIB=32 MIGRATION_VX_STALE_MS=300000
SRC="$(fleet_uuid)"
SEED_ARGS=()
# the destination PostgreSQL runs the source's image (the restore client must be at least the dump's major); a MariaDB destination is
# the default image of its version
[ "$ENGINE" != POSTGRES ] || SEED_ARGS=(--image "$IMAGE")
LAB_SKIP_SOURCE=1 lab_scenario_begin "l15-$ENGINE-$VERSION" --kind db --engine "$ENGINE" --version "$VERSION" --source "$SRC" --data-mode stream ${SEED_ARGS[@]+"${SEED_ARGS[@]}"}
docker volume rm -f "$SRC_VOLUME" >/dev/null 2>&1 || true
: >"$LAB_DIR/l15.summary"
echo "L15_IMAGE=$IMAGE L15_ENGINE=$ENGINE L15_MIB=$MIB" >>"$LAB_DIR/l15.summary"

# ---- 1. the source -------------------------------------------------------------------------------------------------------------------
NEIGHBOR="$(fleet_uuid)"; fleet_redis "$NEIGHBOR"
if [ "$ENGINE" = POSTGRES ]; then
  fleet_pg_source "$SRC" "$IMAGE" "$SRC_VOLUME"
  fleet_pg_load_ticks "$SRC" "$MIB"
  lab_pg_integrity_seed "$SRC" tugra postgres "$VEC_ARG"
  lab_pg_fingerprint "$SRC" tugra postgres ticks "$VEC_ARG" >"$LAB_DIR/l15.fp.src"
  SRC_ROWS="$(fleet_pg_sql "$SRC" 'select count(*) from ticks')"
else
  fleet_mariadb_source "$SRC" "$SRC_VOLUME" "$PW"
  fleet_mariadb_load "$SRC" "$PW" "$MIB"
  lab_maria_integrity_seed "$SRC" "$PW" fleetdb
  lab_maria_fingerprint "$SRC" "$PW" fleetdb >"$LAB_DIR/l15.fp.src"
  SRC_ROWS="$(fleet_mariadb_sql "$SRC" "$PW" 'select count(*) from blobs')"
fi
lab_log "source $SRC ($IMAGE): $SRC_ROWS rows, $(wc -l <"$LAB_DIR/l15.fp.src" | tr -d ' ') integrity facts"
lab_check "the source is a RUNNING container with a 24 character name" bash -c "[ ${#SRC} = 24 ] && docker inspect -f '{{.State.Running}}' $SRC | grep -qx true"
OTHERS_BEFORE="$(fleet_snapshot_others "$SRC")"
SRC_STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$SRC")"

# ---- 2. the plan ---------------------------------------------------------------------------------------------------------------------
lab_stream_plan plan --part-mib 32
lab_check "the dry run left the source running" fleet_running "$SRC"
lab_log "plan: raw $(lab_item plan rawBytes) B, disk $(lab_item plan disk)"

# ---- 3. the copy, with the hub killed in flight --------------------------------------------------------------------------------------
lab_proxy_start "$RATE"
t0=$(date +%s)
lab_run_bg stream --hub "$LAB_PROXY_URL" --arms volumes --part-mib 32 --hub-outage-wait 10m
dump_in_flight_or_done() { [ "$(lab_last_part stream)" -ge 1 ] || [ -f "$LAB_DIR/run.stream.rc" ]; }
lab_wait 900 "the first dumped parts" dump_in_flight_or_done
if [ -f "$LAB_DIR/run.stream.rc" ]; then
  early_rc="$(cat "$LAB_DIR/run.stream.rc")"
  lab_stream_note_refusal stream
  # a run that ended with no committed part was refused or failed at the start (a destination gate answers before any byte moves):
  # that is a result of the lane, not a dump that was too small for the link
  if [ "$(lab_last_part stream)" -lt 1 ]; then
    lab_stream_fail stream "the streamed run ended before any part was committed (migrator exit $early_rc): it was refused or failed at the start"
  fi
  # a run that committed parts and then FAILED is a failure of the lane (a hub 5xx, a dump error), never a small dataset
  if [ "$early_rc" != 0 ]; then
    lab_stream_fail stream "the streamed run failed after part $(lab_last_part stream) with migrator exit $early_rc, before the hub could be killed"
  fi
  # only a clean exit 0 is the whole dump fitting before the hub could be killed: the data was too small for the link, not a product result
  tail -30 "$LAB_DIR/run.stream.log" >&2
  lab_die "the dump finished before the hub could be killed in flight (raise L15_MIB or lower L15_RATE; the migrator exited 0)"
fi
lab_log "the dump is in flight (part $(lab_last_part stream) committed): killing the hub"
# the outage must be a real one: the run is still going at the moment of the kill (no exit code yet) and its last committed part is noted,
# so that parts committed AFTER the restart prove the migrator rode the outage with work still in flight
[ ! -f "$LAB_DIR/run.stream.rc" ] || lab_die "the dump finished just before the hub could be killed (raise L15_MIB or lower L15_RATE)"
PART_AT_KILL="$(lab_last_part stream)"
"$LAB_SELF_DIR/hub.sh" kill
sleep 15
"$LAB_SELF_DIR/hub.sh" start
echo "L15_HUB_RESTARTS=1 L15_PART_AT_KILL=$PART_AT_KILL" >>"$LAB_DIR/l15.summary"
rc="$(lab_run_wait stream 3600)"
secs=$(( $(date +%s) - t0 ))
lab_proxy_stop
lab_stream_expect_applied stream
[ "$rc" = 0 ] || lab_stream_fail stream "migrator exit $rc"
lab_check "the migrator committed parts AFTER the hub came back (the dump was in flight during the outage: last part before the kill $PART_AT_KILL, after $(lab_last_part stream))" test "$(lab_last_part stream)" -gt "$PART_AT_KILL"
lab_log "the dump rode the hub outage and was applied: $(lab_item stream parts) parts, $(lab_item stream rawBytes) raw B, ${secs} s"
echo "L15_COPY_SECONDS=$secs L15_PARTS=$(lab_item stream parts) L15_RAW_BYTES=$(lab_item stream rawBytes)" >>"$LAB_DIR/l15.summary"
lab_stream_transfer_done
src_untouched() { fleet_running "$SRC" && [ "$(docker inspect -f '{{.State.StartedAt}}' "$SRC")" = "$SRC_STARTED" ]; }
no_helpers_left() { [ -z "$(docker ps -aq --filter label=tugra.vx=1)" ] && [ -z "$(lab_migrator_containers)" ]; }
lab_check "the source was never stopped or restarted by the dump" src_untouched
lab_check "no migrator or tar helper container is left behind" no_helpers_left
lab_stream_dest
echo "L15_STAGED_PARTS_AFTER=$(lab_stream_parts_left)" >>"$LAB_DIR/l15.summary"
lab_check "no other container on the host was stopped, started or removed (bar the database the hub started)" test "$OTHERS_BEFORE" = "$(fleet_snapshot_others "$SRC" "$DST_CTR")"

# ---- 4. the destination --------------------------------------------------------------------------------------------------------------
if [ "$ENGINE" = POSTGRES ]; then
  DU="$(lab_ctr_env "$DST_CTR" POSTGRES_USER)"; DD="$(lab_ctr_env "$DST_CTR" POSTGRES_DB)"
  lab_wait 120 "the destination postgres to accept connections" docker exec "$DST_CTR" pg_isready -U "$DU"
  DST_ROWS="$(lab_pg_q "$DST_CTR" "$DU" "$DD" 'select count(*) from ticks')"
  lab_check "the row count equals the source ($SRC_ROWS)" test "$DST_ROWS" = "$SRC_ROWS"
  lab_pg_fingerprint "$DST_CTR" "$DU" "$DD" ticks "$VEC_ARG" >"$LAB_DIR/l15.fp.dst"
  lab_fingerprint_compare l15 "$LAB_DIR/l15.fp.src" "$LAB_DIR/l15.fp.dst" L15
  # the restored rows live in the destination's named volume: recreate its container through the hub and count again
  lab_dest_survives_recreate "$DST_CTR" "$DU" "$DD" ticks "$SRC_ROWS" || lab_die "the restored database did not survive a recreate of its container (PRODUCT FINDING above)"
else
  DPW="$(lab_ctr_env "$DST_CTR" MARIADB_ROOT_PASSWORD)"; DD="$(lab_ctr_env "$DST_CTR" MARIADB_DATABASE)"
  lab_wait 120 "the destination mariadb to accept connections" docker exec -e "MYSQL_PWD=$DPW" "$DST_CTR" mariadb-admin -uroot ping
  DST_ROWS="$(lab_maria_q "$DST_CTR" "$DPW" "$DD" 'select count(*) from blobs')"
  lab_check "the row count equals the source ($SRC_ROWS)" test "$DST_ROWS" = "$SRC_ROWS"
  lab_maria_fingerprint "$DST_CTR" "$DPW" "$DD" >"$LAB_DIR/l15.fp.dst"
  lab_fingerprint_compare l15 "$LAB_DIR/l15.fp.src" "$LAB_DIR/l15.fp.dst" L15
fi
lab_pass "L15 $IMAGE: streamed dump, hub killed mid-dump, rows and checksums, sequences, collation, extensions equal"
