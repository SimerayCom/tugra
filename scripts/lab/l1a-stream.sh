#!/usr/bin/env bash
# L1a: a large volume streamed end to end through the real chain
#   migrator -> HTTP -> hub relay -> signed WS command -> target agent curl -> /etc/tugra/app-moves -> alpine apply.
# L1A_MIB (default 2048) incompressible MiB; parts of 128 MiB (the hub policy), so ~16 parts at the default.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MIB="${L1A_MIB:-2048}"
lab_scenario_begin l1a
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" "$MIB" random

lab_run main --arms all --part-mib 128
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.main.log" >&2; lab_die "migrator exit $LAB_RC"; }
lab_expect_item main volume-applied
parts="$(lab_item main parts)"
want=$(( MIB / 128 ))
lab_check "about $want parts were sent (got $parts)" test "$parts" -ge "$want"
lab_check "the migrator logged a rate for every part" test "$(grep -c -E '^ *part [0-9]+ ' "$LAB_DIR/run.main.log")" -ge "$want"

read -r state partsDone err <<<"$(lab_transfer)"
lab_check "the hub transfer row is DONE (got $state $err)" test "$state" = DONE
lab_no_leftovers
lab_source_untouched
lab_check "the destination volume exists" docker volume inspect "$DEST_VOLUME"
lab_compare
lab_pass "L1a streamed ${MIB} MiB, $parts parts"
