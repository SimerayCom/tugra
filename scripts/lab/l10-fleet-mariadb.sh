#!/usr/bin/env bash
# L10: MariaDB against the logical-dump cap. The real estate has a 1.8 GB mariadb:11 and several that sit just under the cap by
# VOLUME size; only the DUMP size decides (the hub's artifact cap is 256 MiB of gzip), and MariaDB has no physical lane at all.
# A RUNNING, uuid-named mariadb:11 on the logical arm (--arms databases, which never stops the source). Under the DEFAULT policy
# (largeDbMode `refuse`) the artifact route is all there is; the owner's `stream-logical` policy puts the same database on the streamed
# dump lane, which has no cap:
#   1. a small database (L10_UNDER_MIB, default 120): a dry run plans it; with --max-gz-bytes 32 MiB the dump aborts as
#      `dump-too-big`; with the default cap the dump and the upload go through (the item reports the uploaded bytes). The restore
#      leg restores into the destination database the hub starts, and the rows and the strict fingerprint (integrity.sh) are compared.
#   2. the real size (L10_OVER_MIB, default 1800): the dump is over the cap under the DEFAULT policy: `dump-too-big`, nothing uploaded,
#      the source untouched and still running (a fresh op: the first one is already restored).
#   3. the same database on the streamed lane (`--data-mode stream`, what largeDbMode stream-logical does): the dump is relayed in parts,
#      restored on the target, and the destination holds the same rows and the same strict fingerprint (L10_STREAM=0 skips this leg).
#      MariaDB users, schema grants and stored routines are compared too and recorded as a finding where the dump drops them.
set -euo pipefail
# shellcheck source=fleet.sh
. "$(dirname "${BASH_SOURCE[0]}")/fleet.sh"
# shellcheck source=stream.sh
. "$(dirname "${BASH_SOURCE[0]}")/stream.sh"

UNDER="${L10_UNDER_MIB:-120}"
OVER="${L10_OVER_MIB:-1800}"
PW=lab-mariadb-pw-0123456789
export SRC_VOLUME=lab-fleet-maria

lab_guard_destructive
fleet_cleanup
SRC="$(fleet_uuid)"
LAB_SKIP_SOURCE=1 lab_scenario_begin l10 --kind db --engine MARIADB --version 11 --source "$SRC"
docker volume rm -f "$SRC_VOLUME" >/dev/null 2>&1 || true
: >"$LAB_DIR/l10.summary"

fleet_mariadb_source "$SRC" "$SRC_VOLUME" "$PW"
fleet_mariadb_load "$SRC" "$PW" "$UNDER"
lab_maria_integrity_seed "$SRC" "$PW" fleetdb
lab_maria_fingerprint "$SRC" "$PW" fleetdb >"$LAB_DIR/l10.fp.src1"
lab_check "the source is a RUNNING container with a 24 character name" bash -c "[ ${#SRC} = 24 ] && docker inspect -f '{{.State.Running}}' $SRC | grep -qx true"

lab_run dry --arms databases --dry-run
[ "$LAB_RC" = 0 ] || { tail -20 "$LAB_DIR/run.dry.log" >&2; lab_die "dry run exit $LAB_RC"; }
lab_expect_item dry planned
lab_check "the dry run left the source running" fleet_running "$SRC"

# the cap is on the dump, not on the volume: the same data is over a 32 MiB cap and under the default one
lab_run capped --arms databases --max-gz-bytes 33554432
lab_expect_item capped failed dump-too-big
lab_check "nothing was uploaded for the capped run" test -z "$(lab_item capped bytes)"
lab_run under --arms databases
lab_log "the ${UNDER} MiB database under the default cap: state $(lab_item under state) reason $(lab_item under reason) uploaded $(lab_item under bytes) B"
lab_check "the dump of ${UNDER} MiB fits the default cap and was uploaded" test "$(lab_item under bytes)" -gt 0
[ "$(lab_item under reason)" != dump-too-big ] || lab_die "a ${UNDER} MiB database is not over the 256 MiB cap"
echo "L10_UNDER_MIB=$UNDER L10_UNDER_STATE=$(lab_item under state) L10_UNDER_UPLOADED=$(lab_item under bytes)" >>"$LAB_DIR/l10.summary"
lab_expect_item under restored
# the artifact route's restore into the database the hub started: the same rows, the same strict fingerprint
dest_fingerprint() { # <op name> <output file>
  (
    lab_op_load "$1"
    lab_stream_dest
    dpw="$(lab_ctr_env "$DST_CTR" MARIADB_ROOT_PASSWORD)"; dd="$(lab_ctr_env "$DST_CTR" MARIADB_DATABASE)"
    lab_wait 120 "the destination mariadb to accept connections" docker exec -e "MYSQL_PWD=$dpw" "$DST_CTR" mariadb-admin -uroot ping
    lab_maria_fingerprint "$DST_CTR" "$dpw" "$dd" >"$2"
  )
}
dest_fingerprint main "$LAB_DIR/l10.fp.dst1"
lab_fingerprint_compare l10-under "$LAB_DIR/l10.fp.src1" "$LAB_DIR/l10.fp.dst1" L10_UNDER

# the real size: grow the same database to the 1.8 GB class and dump it under the DEFAULT policy, on a fresh op (the first is restored)
fleet_mariadb_load "$SRC" "$PW" "$OVER"
lab_maria_fingerprint "$SRC" "$PW" fleetdb >"$LAB_DIR/l10.fp.src2"
lab_seed op --name "lab-over-$(date +%s)" --source "$SRC" --kind db --engine MARIADB --version 11 --data-mode dump >"$LAB_DIR/op.over.env"
t0=$(date +%s)
LAB_OP=over lab_run over --arms databases
secs=$(( $(date +%s) - t0 ))
(lab_op_load over; lab_expect_item over failed dump-too-big)
(lab_op_load over; lab_check "nothing was uploaded for the over-cap run" test -z "$(lab_item over bytes)")
lab_check "the over-cap attempt left the source running" fleet_running "$SRC"
lab_log "the ${OVER} MiB database was refused as dump-too-big after ${secs} s (the artifact route under the default refuse policy)"
echo "L10_OVER_MIB=$OVER L10_OVER=dump-too-big L10_OVER_SECONDS=$secs" >>"$LAB_DIR/l10.summary"

# the same database on the streamed lane: no cap, the source never stopped
if [ "${L10_STREAM:-1}" = 1 ]; then
  SRC_STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$SRC")"
  lab_seed op --name "lab-stream-$(date +%s)" --source "$SRC" --kind db --engine MARIADB --version 11 --data-mode stream >"$LAB_DIR/op.stream.env"
  (
    lab_op_load stream
    LAB_OP=stream lab_stream_plan splan
    t1=$(date +%s)
    LAB_OP=stream lab_run stream --arms volumes
    secs1=$(( $(date +%s) - t1 ))
    [ "$LAB_RC" = 0 ] || { tail -40 "$LAB_DIR/run.stream.log" >&2; lab_die "streamed lane: migrator exit $LAB_RC"; }
    lab_stream_expect_applied stream
    echo "L10_STREAM_SECONDS=$secs1 L10_STREAM_PARTS=$(lab_item stream parts) L10_STREAM_RAW_BYTES=$(lab_item stream rawBytes)" >>"$LAB_DIR/l10.summary"
    lab_stream_transfer_done "$OP_ID"
  )
  dest_fingerprint stream "$LAB_DIR/l10.fp.dst2"
  lab_fingerprint_compare l10-stream "$LAB_DIR/l10.fp.src2" "$LAB_DIR/l10.fp.dst2" L10_STREAM
  lab_check "the streamed dump never stopped or restarted the source" test "$(docker inspect -f '{{.State.StartedAt}}' "$SRC")" = "$SRC_STARTED"
  lab_check "the source is still running after the streamed dump" fleet_running "$SRC"
fi
lab_pass "L10 mariadb: the artifact route is capped by the dump size (${OVER} MiB is over it), the streamed lane carries it"
