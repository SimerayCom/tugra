#!/usr/bin/env bash
# L6: the PostgreSQL physical-copy gate against a REAL cluster. One run per image (a CI matrix):
#   L6_IMAGE=postgres:16-alpine        L6_IMAGE=pgvector/pgvector:pg17        L6_IMAGE=postgres:18-alpine
# 16 and 17 mount PGDATA at /var/lib/postgresql/data: the gates pass, the copy applies, postmaster.pid is excluded, the
# database starts on the target after WAL replay (the source is SIGKILLed: no checkpoint) and the row count and
# pg_total_relation_size equal the frozen source values. 18 keeps PGDATA one level down (/var/lib/postgresql/18/docker): the
# `layout` gate must refuse with the exact text. On 16 the negative gates run too: running source, Alpine vs Debian image,
# major mismatch, a started destination.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

IMAGE="${L6_IMAGE:?set L6_IMAGE, e.g. postgres:16-alpine}"
case "$IMAGE" in
  postgres:16* | pgvector/pgvector:pg16*) MAJOR=16 ;;
  postgres:17* | pgvector/pgvector:pg17*) MAJOR=17 ;;
  postgres:18* | pgvector/pgvector:pg18*) MAJOR=18 ;;
  *) MAJOR="${L6_MAJOR:-}" ;;
esac
[ -n "$MAJOR" ] || lab_die "cannot read the PostgreSQL major from $IMAGE (set L6_MAJOR)"
ROWS="${L6_ROWS:-500000}"
if [ "$MAJOR" -ge 18 ]; then MOUNT=/var/lib/postgresql; else MOUNT=/var/lib/postgresql/data; fi
LAYOUT_TEXT="PostgreSQL 18 data layout is not supported by Tugra database volumes yet"
export SRC_VOLUME=lab-pgsrc

psql_src() { docker exec labsrc psql -U tugra -d postgres -At -c "$1"; }

# ---- the source: a real cluster with ~200 MiB of rows --------------------------------------------------------------------
LAB_SKIP_SOURCE=1 lab_scenario_begin "l6-$MAJOR" --kind db --image "$IMAGE" --version "$MAJOR"
docker rm -f labsrc >/dev/null 2>&1 || true
docker volume rm -f "$SRC_VOLUME" >/dev/null 2>&1 || true
# the same superuser name the Tugra database container is started with (POSTGRES_USER=tugra), so a copied cluster fits it
docker run -d --name labsrc -e POSTGRES_USER=tugra -e POSTGRES_PASSWORD=lab -v "$SRC_VOLUME:$MOUNT" "$IMAGE" >/dev/null
lab_wait 120 "the source postgres to accept connections" docker exec labsrc pg_isready -U tugra
sleep 3 # the image's init phase restarts the server once; wait for the final one
lab_wait 60 "the source postgres after its init restart" docker exec labsrc pg_isready -U tugra
psql_src "create table lab_t as select g as id, md5(g::text) as m, repeat(md5(g::text), 10) as pad from generate_series(1, $ROWS) g; create index lab_t_m on lab_t (m);" >/dev/null
SRC_COUNT="$(psql_src 'select count(*) from lab_t')"
SRC_SIZE="$(psql_src "select pg_total_relation_size('lab_t')")"
lab_log "source: $SRC_COUNT rows, $SRC_SIZE bytes (frozen before the unclean stop)"
lab_check "the source holds the rows" test "$SRC_COUNT" = "$ROWS"

# negative 1 (16 only): a RUNNING source is refused, never stopped without --stop-source
if [ "$MAJOR" = 16 ]; then
  lab_run neg-running --arms all --dry-run
  lab_expect_item neg-running volume-skipped-running
  lab_check "the running source was left running" test "$(docker inspect -f '{{.State.Running}}' labsrc)" = true
fi

# the unclean stop: SIGKILL, exit 137, no checkpoint (the target must replay WAL)
docker kill labsrc >/dev/null
lab_check "the source exited 137" test "$(docker inspect -f '{{.State.ExitCode}}' labsrc)" = 137

neg() { # <name> <expected reason substring> <seed args...>: a gate that must refuse, on a fresh op
  local name="$1" why="$2"; shift 2
  lab_seed op --name "lab-$name-$(date +%s)" --source labsrc --kind db "$@" >"$LAB_DIR/op.$name.env"
  LAB_OP="$name" lab_run "$name" --arms all
  (lab_op_load "$name"; lab_expect_item "$name" failed "$why")
}

if [ "$MAJOR" = 16 ]; then
  # negative 2: Alpine source against a Debian target image
  neg image "a physical copy needs the same image" --image "postgres:16" --version 16
  # negative 3: a major mismatch
  neg major "differs from the Tugra database version" --image "$IMAGE" --version 17
  # negative 4: a started destination (status != NEW)
  lab_seed op --name "lab-started-$(date +%s)" --source labsrc --kind db --image "$IMAGE" --version "$MAJOR" >"$LAB_DIR/op.started.env"
  (lab_op_load started; lab_seed db-set "$DB_ID" RUNNING >/dev/null)
  LAB_OP=started lab_run started --arms all
  (lab_op_load started; lab_expect_item started failed dest-dirty) # the migrator maps the hub's "destination was started" 409 to dest-dirty
fi

if [ "$MAJOR" -ge 18 ]; then
  # 18: the layout gate refuses; the database stays on the logical dump path and the destination is untouched
  lab_run gate --arms all
  lab_op_load main
  lab_expect_item gate failed "$LAYOUT_TEXT"
  vols="$(lab_api GET "/import/operations/$OP_ID/volumes")"
  lab_check "the layout gate failed with the exact text" node -e '
    const g=(JSON.parse(process.argv[1]).volumes[0].gates||[]).find(x=>x.id==="layout");
    process.exit(g && g.status==="fail" && g.text===process.argv[2] ? 0 : 1)' "$vols" "$LAYOUT_TEXT"
  lab_check "no transfer was started" test "$(lab_transfer | awk '{print $1}')" = NONE
  lab_pass "L6 $IMAGE: the layout gate refuses PostgreSQL 18"
  exit 0
fi

# ---- 16 / 17: the copy -------------------------------------------------------------------------------------------------------
lab_op_load main
lab_run copy --arms all
[ "$LAB_RC" = 0 ] || { tail -40 "$LAB_DIR/run.copy.log" >&2; lab_die "migrator exit $LAB_RC"; }
lab_expect_item copy volume-applied
read -r state _ <<<"$(lab_transfer)"
lab_check "the hub transfer is DONE" test "$state" = DONE
lab_no_leftovers
COMPARE_EXCLUDE=postmaster.pid lab_compare
lab_check "postmaster.pid was not copied" bash -c "! docker run --rm -v $DEST_VOLUME:/data:ro $(lab_helper_image) test -e /data/postmaster.pid"

# start the database on the target
lab_api POST "/databases/$DB_ID/provision" >/dev/null
lab_wait 180 "the destination database to be RUNNING" bash -c "[ \"\$(node $LAB_SELF_DIR/seed.mjs db-status $DB_ID | awk '{print \$1}')\" = RUNNING ]"
CTR="tugra_db_$DB_ID"
lab_wait 120 "the destination postgres to accept connections" docker exec "$CTR" pg_isready
lab_check "WAL replay ran on the target (the source was SIGKILLed)" bash -c "docker logs $CTR 2>&1 | grep -qi -E 'not properly shut down|automatic recovery in progress|redo starts'"
DST_COUNT="$(docker exec "$CTR" psql -U tugra -d postgres -At -c 'select count(*) from lab_t')"
DST_SIZE="$(docker exec "$CTR" psql -U tugra -d postgres -At -c "select pg_total_relation_size('lab_t')")"
lab_log "target: $DST_COUNT rows, $DST_SIZE bytes"
lab_check "the row count equals the source ($SRC_COUNT)" test "$DST_COUNT" = "$SRC_COUNT"
lab_check "pg_total_relation_size equals the source ($SRC_SIZE)" test "$DST_SIZE" = "$SRC_SIZE"
lab_pass "L6 $IMAGE: gates, copy, WAL replay, rows and size"
