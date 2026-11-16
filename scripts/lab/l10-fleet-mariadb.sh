#!/usr/bin/env bash
# L10: MariaDB against the logical-dump cap. The real estate has a 1.8 GB mariadb:11 and several that sit just under the cap by
# VOLUME size; only the DUMP size decides (the hub's artifact cap is 256 MiB of gzip), and MariaDB has no physical lane at all.
# A RUNNING, uuid-named mariadb:11 on the logical arm (--arms databases, which never stops the source):
#   1. a small database (L10_UNDER_MIB, default 120): a dry run plans it; with --max-gz-bytes 32 MiB the dump aborts as
#      `dump-too-big`; with the default cap the dump and the upload go through (the item reports the uploaded bytes). The restore
#      leg needs a provisioned target database, which the lab seeds without a container, so it is not asserted.
#   2. the real size (L10_OVER_MIB, default 1800): the dump is over the cap under the DEFAULT cap: `dump-too-big`, nothing uploaded,
#      the source untouched and still running. That is the fleet's finding: its 1.8 GB MariaDB has no automatic lane (the runbook).
set -euo pipefail
# shellcheck source=fleet.sh
. "$(dirname "${BASH_SOURCE[0]}")/fleet.sh"

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

# the real size: grow the same database to the 1.8 GB class and dump it under the default cap
fleet_mariadb_load "$SRC" "$PW" "$OVER"
t0=$(date +%s)
lab_run over --arms databases
secs=$(( $(date +%s) - t0 ))
lab_expect_item over failed dump-too-big
lab_check "nothing was uploaded for the over-cap run" test -z "$(lab_item over bytes)"
lab_check "the over-cap attempt left the source running" fleet_running "$SRC"
lab_log "the ${OVER} MiB database was refused as dump-too-big after ${secs} s"
echo "L10_OVER_MIB=$OVER L10_OVER=dump-too-big L10_OVER_SECONDS=$secs" >>"$LAB_DIR/l10.summary"
lab_pass "L10 mariadb: the dump size decides, ${OVER} MiB has no automatic lane"
