#!/usr/bin/env bash
# The streamed dump lane (the guided run's largeDbMode "stream-logical") as the lab drives it. Sourced, never executed.
#
# A database on the lane is a migrator row `volume:_:<source>:dump` (seed.mjs op --data-mode stream puts it there, the way DATA_SEED
# does through BulkOperation.meta.vxStream). The migrator's volume arm runs the pinned dump recipe inside the RUNNING source (the source is
# never stopped), cuts its stdout into parts, relays them to the target agent, and the hub restores them there through the engine's own
# client. The hub starts the destination database as part of that restore; the scenario reads it afterwards.
# shellcheck shell=bash

STREAM_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=integrity.sh
. "$STREAM_SELF_DIR/integrity.sh"

# lab_stream_plan <tag> [--hub URL] [migrator args]: the read-only plan of the op's streamed row, with the measurement the hub chooses a lane
# from (`--measure-dbs --measure-dump`: catalog size and the counted dump). Nothing is stopped, sent or restored. migrate.sh reads
# `--hub` only in front of the other flags, so the caller's arguments come first.
lab_stream_plan() {
  local tag="$1"; shift
  lab_run "$tag" "$@" --arms volumes --dry-run --measure-dbs --measure-dump
  [ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.$tag.log" >&2; lab_die "the streamed lane's dry run exited $LAB_RC"; }
  lab_expect_item "$tag" planned would-stream-dump
}

# lab_stream_note_refusal <tag>: when the run's log or JSON carries the hub's PostgreSQL 18 destination refusal, name it for what it is:
# a product gate, not a harness failure. Prints nothing otherwise. A refused run ends with a non-zero migrator exit before any part
# moves, so every caller that dies on a non-zero exit calls this first (lab_stream_fail does).
lab_stream_note_refusal() {
  local tag="$1"
  if grep -q -E "PostgreSQL 18 or newer" "$LAB_DIR/run.$tag.log" "$LAB_DIR/run.$tag.json" 2>/dev/null; then
    lab_log "PRODUCT FINDING: the hub refuses a streamed dump into a PostgreSQL 18 destination (importer/volume-stream/vx-dest-gate.ts dumpDestLayout, called from vx.service.ts begin and vx-apply.service.ts runDumpApply): Tugra mounts the database volume at the pre-18 data path, so the restored cluster would sit outside the named volume"
  fi
}

# lab_stream_fail <tag> <message>: a streamed run that went wrong. Shows the end of its log, names a destination refusal, then dies.
lab_stream_fail() {
  local tag="$1"; shift
  tail -40 "$LAB_DIR/run.$tag.log" >&2 || true
  lab_stream_note_refusal "$tag"
  lab_die "$*"
}

# lab_stream_expect_applied <tag>: the run's item is `volume-applied`; when it is not, the log is shown and a PostgreSQL 18 destination
# refusal is named for what it is.
lab_stream_expect_applied() {
  local tag="$1"
  if [ "$(lab_item "$tag" state)" != volume-applied ]; then
    tail -30 "$LAB_DIR/run.$tag.log" >&2 || true
    lab_stream_note_refusal "$tag"
  fi
  lab_expect_item "$tag" volume-applied
}

# lab_stream_dest: wait for the destination database the hub started, and set DST_CTR to its container.
lab_stream_dest() {
  lab_wait 300 "the destination database to be RUNNING" bash -c "[ \"\$(node $LAB_SELF_DIR/seed.mjs db-status $DB_ID | awk '{print \$1}')\" = RUNNING ]"
  DST_CTR="tugra_db_$DB_ID"
  export DST_CTR
}

# lab_stream_transfer_done [op-id]: the hub's transfer row of the op (default $OP_ID) is DONE.
lab_stream_transfer_done() {
  local state
  read -r state _ <<<"$(lab_transfer "${1:-$OP_ID}")"
  lab_check "the hub transfer is DONE" test "$state" = DONE
}

# lab_stream_parts_left: how many staged parts remain on the target after the restore (recorded, not asserted).
lab_stream_parts_left() { lab_agent_exec sh -c 'find /etc/tugra/app-moves -name "p.*" 2>/dev/null | wc -l' | tr -d ' '; }
