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

# lab_stream_refused <tag>: true when the run's log or JSON carries the hub's PostgreSQL 18 destination refusal (the text of
# vx-dest-gate.ts DUMP_DEST_PG_LAYOUT_TEXT). A caller decides on THIS, never on the image's major: once the gate is lifted the refusal
# is gone and the same leg runs without an edit.
lab_stream_refused() {
  grep -q -E "PostgreSQL 18 or newer" "$LAB_DIR/run.$1.log" "$LAB_DIR/run.$1.json" 2>/dev/null
}

# lab_stream_note_refusal <tag>: when the run's log or JSON carries the hub's PostgreSQL 18 destination refusal, name it for what it is:
# a product gate, not a harness failure. Prints nothing otherwise. A refused run ends with a non-zero migrator exit before any part
# moves, so every caller that dies on a non-zero exit calls this first (lab_stream_fail does).
lab_stream_note_refusal() {
  local tag="$1"
  if lab_stream_refused "$tag"; then
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

# lab_dest_survives_recreate <container> <user> <db> <table> <rows> [db-id]: does what a destination database holds outlive its container?
# The hub recreates a database by running its provision script again (databases.service.ts provision: `docker rm -f` + `docker run` over
# the named volume), which is what every settings change, PITR switch and host reboot with a recreate does. After that the table must be
# there with every row. Returns non-zero and names the product defect when it is not: this is not specific to a streamed restore, every
# PostgreSQL 18+ database Tugra provisions is affected (databases/database-script.ts mounts the volume at ENGINES.POSTGRES.dataDir,
# /var/lib/postgresql/data, and sets no PGDATA, while the 18 image keeps its cluster under /var/lib/postgresql/<major>/docker, outside that
# mount, in an anonymous volume that is orphaned by the recreate). A caller that wants to keep gathering evidence decides when to die.
lab_dest_survives_recreate() {
  local c="$1" u="$2" d="$3" t="$4" want="$5" id="${6:-$DB_ID}" got
  lab_api POST "/databases/$id/provision" >/dev/null || { lab_log "the hub's provision route failed while recreating $c"; return 1; }
  lab_wait 300 "the recreated database to be RUNNING" bash -c "[ \"\$(node $LAB_SELF_DIR/seed.mjs db-status $id | awk '{print \$1}')\" = RUNNING ]"
  lab_wait 120 "the recreated database to accept connections" docker exec "$c" pg_isready -U "$u"
  got="$(lab_pg_q "$c" "$u" "$d" "select count(*) from $t" 2>/dev/null || echo lost)"
  if [ "$got" = "$want" ]; then
    lab_log "ok: the database holds all $want rows of $t after the hub recreated its container"
    return 0
  fi
  lab_log "PRODUCT FINDING: after the hub recreated the destination container ($c) $t reads '$got', not $want: the data did not persist in the named volume (databases/database-script.ts mounts it at ENGINES.POSTGRES.dataDir /var/lib/postgresql/data with no PGDATA; a PostgreSQL 18 or newer image keeps its cluster under /var/lib/postgresql/<major>/docker, an anonymous volume that the recreate orphans). Every PostgreSQL 18+ database Tugra provisions is affected, restored or fresh"
  return 1
}
