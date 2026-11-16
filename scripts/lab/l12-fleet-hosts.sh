#!/usr/bin/env bash
# L12: what a real source host looks like to the migrator. The first lab source was one STOPPED container named `labsrc`; here the
# sources are RUNNING containers named the way Coolify names them, on a host that also runs things the import never lists:
#   A  an application `<24-char uuid>-<13 digits>` (the sourceRef is the uuid), running, owners 999/70/65534/1000 in its volume:
#      a plain dry run is `volume-skipped-running`, a dry run with --stop-source only says `would-stop-source`, and the real run with
#      --stop-source stops ONLY that container, applies the volume (identical) and leaves it stopped
#   B  two deploys of one application (`<uuid>-<digits>` twice): `ambiguous`, nothing is stopped
#   C  an exited container with a restart history (a crashed API that never came back): copied without stopping or starting anything
#   D  a crash-looping container (`restart: always`, exits after a second): `volume-skipped-running` without --stop-source, applied
#      with it, and it stays stopped (the stop is the user's, the restart policy does not undo it)
#   E  redis:7.2 with a password on its command line, plain and with a custom conf file: the dry run discovers both, DBSIZE is unchanged
#   F  Meilisearch pinned to an old version and `latest`: a volume copy of the pinned one opens on the pinned image; whether `latest`
#      opens it is RECORDED (version drift between instances), not a gate (L12_MEILI=0 skips F)
# Around all of it: 13+1 redis, an orphan PostgreSQL 17 the import does not list (the "unlisted DB" of the real estate), orphan
# volumes no container uses, and unrelated application containers. Every case asserts that nothing else on the host changed.
set -euo pipefail
# shellcheck source=fleet.sh
. "$(dirname "${BASH_SOURCE[0]}")/fleet.sh"

lab_guard_destructive
fleet_cleanup
: >"$LAB_DIR/l12.summary"

# ---- the host ------------------------------------------------------------------------------------------------------------------
lab_log "building the host: neighbours, 14 redis, an unlisted PostgreSQL, orphan volumes"
NEIGHBORS=()
for i in 1 2 3; do
  n="$(fleet_uuid)-$(fleet_stamp)"; fleet_volume "lab-neighbor-$i"
  fleet_run --name "$n" -v "lab-neighbor-$i:/data" alpine:3.21 sleep 86400
  NEIGHBORS+=("$n")
done
CONF="$LAB_DIR/redis-custom.conf"
printf 'maxmemory 64mb\nmaxmemory-policy allkeys-lru\nsave ""\n' >"$CONF"
REDIS_PLAIN="$(fleet_uuid)"; REDIS_CONF="$(fleet_uuid)"
fleet_redis "$REDIS_PLAIN"; fleet_redis "$REDIS_CONF" "$CONF"
for i in $(seq 1 12); do fleet_redis "$(fleet_uuid)"; done
UNLISTED="$(fleet_uuid)"
fleet_pg_source "$UNLISTED" postgres:17-alpine lab-unlisted-pg
fleet_pg_sql "$UNLISTED" "create table t as select g from generate_series(1, 100000) g" >/dev/null
fleet_orphan_volumes 3 20
for c in "$REDIS_PLAIN" "$REDIS_CONF"; do
  lab_wait 30 "redis $c" fleet_redis_cli "$c" ping
  i=1; while [ "$i" -le 100 ]; do fleet_redis_cli "$c" set "k$i" "v$i" >/dev/null; i=$((i + 1)); done
done
lab_check "the redis with a custom conf holds its 100 keys" test "$(fleet_redis_cli "$REDIS_CONF" dbsize)" = 100
lab_check "the unlisted PostgreSQL is running and holds rows" test "$(fleet_pg_sql "$UNLISTED" 'select count(*) from t')" = 100000
echo "L12_HOST_CONTAINERS=$(docker ps -q | wc -l | tr -d ' ') L12_UNLISTED_DB=$UNLISTED L12_ORPHAN_VOLUMES=3" >>"$LAB_DIR/l12.summary"

# case_untouched <own container names...>: nothing but the case's own containers changed since BASE
case_untouched() { lab_check "nothing else on the host was stopped, started or removed" test "$BASE" = "$(fleet_snapshot_others "$@")"; }
new_op() { # <case> <ref> : a fresh application op (volume at /var/www/data) for a source ref, without the lab's own labsrc
  LAB_SKIP_SOURCE=1 lab_scenario_begin "l12-$1" --source "$2"
}

# ---- A: a running application container, uuid-<digits> -----------------------------------------------------------------------------
REF_A="$(fleet_uuid)"; NAME_A="$REF_A-$(fleet_stamp)"; export SRC_VOLUME=lab-fleet-app-a
new_op a "$REF_A"
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" 128 random
BASE="$(fleet_snapshot_others)"
fleet_run --name "$NAME_A" -v "$SRC_VOLUME:/var/www/data" alpine:3.21 sleep 86400
lab_check "the source is a running container named <24 chars>-<13 digits>" bash -c "[[ $NAME_A =~ ^[a-z0-9]{24}-[0-9]{13}\$ ]] && docker inspect -f '{{.State.Running}}' $NAME_A | grep -qx true"
lab_run a-dry --arms all --dry-run
lab_expect_item a-dry volume-skipped-running
lab_check "the dry run left it running" fleet_running "$NAME_A"
lab_run a-plan --arms all --dry-run --stop-source
lab_expect_item a-plan planned would-stop-source
lab_check "a dry run with --stop-source still did not stop it" fleet_running "$NAME_A"
lab_run a-copy --arms all --stop-source --part-mib 128
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.a-copy.log" >&2; lab_die "migrator exit $LAB_RC"; }
lab_expect_item a-copy volume-applied
lab_check "the migrator stopped the source" bash -c "! docker inspect -f '{{.State.Running}}' $NAME_A | grep -qx true"
case_untouched "$NAME_A"
lab_no_leftovers
"$LAB_SELF_DIR/compare.sh" "$SRC_VOLUME" "$DEST_VOLUME"
lab_log "A: ok"

# ---- B: two deploys of one application ---------------------------------------------------------------------------------------------
REF_B="$(fleet_uuid)"; export SRC_VOLUME=lab-fleet-app-b
new_op b "$REF_B"
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" 16 random
BASE="$(fleet_snapshot_others)"
NB1="$REF_B-1700000000001"; NB2="$REF_B-1700000000002"
fleet_run --name "$NB1" -v "$SRC_VOLUME:/var/www/data" alpine:3.21 sleep 86400
fleet_run --name "$NB2" -v "$SRC_VOLUME:/var/www/data" alpine:3.21 sleep 86400
lab_run b --arms all --stop-source
lab_expect_item b failed ambiguous
lab_check "neither deploy was stopped" bash -c "docker inspect -f '{{.State.Running}}' $NB1 | grep -qx true && docker inspect -f '{{.State.Running}}' $NB2 | grep -qx true"
case_untouched "$NB1" "$NB2"
lab_log "B: ok"

# ---- C: an exited container with a restart history ---------------------------------------------------------------------------------
REF_C="$(fleet_uuid)"; NAME_C="$REF_C-$(fleet_stamp)"; export SRC_VOLUME=lab-fleet-app-c
new_op c "$REF_C"
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" 16 random
BASE="$(fleet_snapshot_others)"
fleet_run --name "$NAME_C" --restart always -v "$SRC_VOLUME:/var/www/data" alpine:3.21 sh -c 'exit 1'
lab_wait 60 "the crashing container to be restarted a few times" bash -c "[ \"\$(docker inspect -f '{{.RestartCount}}' $NAME_C)\" -ge 3 ]"
docker update --restart no "$NAME_C" >/dev/null
docker stop -t 1 "$NAME_C" >/dev/null 2>&1 || true
lab_wait 20 "the container to be exited" bash -c "[ \"\$(docker inspect -f '{{.State.Running}}' $NAME_C)\" = false ]"
RC_BEFORE="$(docker inspect -f '{{.RestartCount}}' "$NAME_C")"
lab_run c --arms all
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.c.log" >&2; lab_die "migrator exit $LAB_RC"; }
lab_expect_item c volume-applied
lab_check "the exited container was neither started nor restarted (restart count $RC_BEFORE)" test "$(docker inspect -f '{{.RestartCount}}|{{.State.Running}}' "$NAME_C")" = "$RC_BEFORE|false"
case_untouched "$NAME_C"
"$LAB_SELF_DIR/compare.sh" "$SRC_VOLUME" "$DEST_VOLUME"
lab_log "C: ok"

# ---- D: a crash-looping container --------------------------------------------------------------------------------------------------
REF_D="$(fleet_uuid)"; NAME_D="$REF_D-$(fleet_stamp)"; export SRC_VOLUME=lab-fleet-app-d
new_op d "$REF_D"
"$LAB_SELF_DIR/fixture.sh" "$SRC_VOLUME" 16 random
BASE="$(fleet_snapshot_others)"
fleet_run --name "$NAME_D" --restart always -v "$SRC_VOLUME:/var/www/data" alpine:3.21 sh -c 'sleep 1; exit 1'
lab_wait 30 "the container to be crash-looping" bash -c "[ \"\$(docker inspect -f '{{.RestartCount}}' $NAME_D)\" -ge 1 ]"
lab_run d-dry --arms all --dry-run
lab_expect_item d-dry volume-skipped-running
lab_run d-copy --arms all --stop-source
[ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.d-copy.log" >&2; lab_die "migrator exit $LAB_RC"; }
lab_expect_item d-copy volume-applied
sleep 6
lab_check "the stopped crash-looping container stays stopped (the restart policy does not undo the stop)" bash -c "[ \"\$(docker inspect -f '{{.State.Running}}' $NAME_D)\" = false ]"
case_untouched "$NAME_D"
"$LAB_SELF_DIR/compare.sh" "$SRC_VOLUME" "$DEST_VOLUME"
lab_log "D: ok"

# ---- E: redis with the password on the command line --------------------------------------------------------------------------------
BASE="$(fleet_snapshot_others)"
for pair in "plain:$REDIS_PLAIN" "conf:$REDIS_CONF"; do
  tag="${pair%%:*}"; ref="${pair#*:}"
  lab_seed op --name "lab-redis-$tag-$(date +%s)" --source "$ref" --kind db --engine REDIS --version 7 --data-mode dump >"$LAB_DIR/op.redis-$tag.env"
  LAB_OP="redis-$tag" lab_run "redis-$tag" --arms databases --dry-run
  (lab_op_load "redis-$tag"; lab_expect_item "redis-$tag" planned)
  lab_check "redis $tag still holds its 100 keys after the dry run" test "$(fleet_redis_cli "$ref" dbsize)" = 100
done
case_untouched
lab_log "E: ok"

# ---- F: Meilisearch, pinned old and latest -----------------------------------------------------------------------------------------
if [ "${L12_MEILI:-1}" = 1 ]; then
  KEY=lab-meili-key-0123456789
  meili() { curl -fsS -H "Authorization: Bearer $KEY" "${@:3}" "http://127.0.0.1:$1$2"; } # <port> <path> [curl args]
  meili_run() { # <name> <image> <volume> <port>
    fleet_run --name "$1" -p "127.0.0.1:$4:7700" -e "MEILI_MASTER_KEY=$KEY" -e MEILI_NO_ANALYTICS=true -v "$3:/meili_data" "$2"
    lab_wait 90 "meilisearch $1 to be healthy" curl -fsS "http://127.0.0.1:$4/health"
  }
  REF_F="$(fleet_uuid)"; NAME_F="$REF_F-$(fleet_stamp)"; export SRC_VOLUME=lab-fleet-meili
  LAB_SKIP_SOURCE=1 lab_scenario_begin l12-meili --source "$REF_F" --volume data --path /meili_data
  fleet_volume "$SRC_VOLUME"
  BASE="$(fleet_snapshot_others)"
  meili_run "$NAME_F" "$FLEET_MEILI_OLD" "$SRC_VOLUME" 7701
  node -e 'console.log(JSON.stringify(Array.from({length:500},(_,i)=>({id:i+1,title:"document "+(i+1),body:"lorem ipsum ".repeat(20)}))))' >"$LAB_DIR/meili-docs.json"
  meili 7701 /indexes/items/documents -X POST -H 'Content-Type: application/json' --data @"$LAB_DIR/meili-docs.json" >/dev/null
  lab_wait 120 "500 documents to be indexed" bash -c "[ \"\$(curl -fsS -H 'Authorization: Bearer $KEY' http://127.0.0.1:7701/indexes/items/stats | node $LAB_SELF_DIR/jget.mjs numberOfDocuments)\" = 500 ]"
  lab_run f --arms all --stop-source
  [ "$LAB_RC" = 0 ] || { tail -30 "$LAB_DIR/run.f.log" >&2; lab_die "migrator exit $LAB_RC"; }
  lab_expect_item f volume-applied
  docker rm -f "$NAME_F" >/dev/null
  meili_run lab-meili-dst-old "$FLEET_MEILI_OLD" "$DEST_VOLUME" 7702
  lab_wait 60 "the copied index to be served by the pinned image" bash -c "[ \"\$(curl -fsS -H 'Authorization: Bearer $KEY' http://127.0.0.1:7702/indexes/items/stats | node $LAB_SELF_DIR/jget.mjs numberOfDocuments)\" = 500 ]"
  lab_log "F: the pinned version serves the copied data (500 documents)"
  # latest on a COPY of the copied volume: whether a newer image opens an older database is the version-drift question
  fleet_volume lab-meili-newcopy
  docker stop -t 10 lab-meili-dst-old >/dev/null
  docker run --rm -v "$DEST_VOLUME":/from:ro -v lab-meili-newcopy:/to "$(lab_helper_image)" sh -c 'cp -a /from/. /to/'
  if docker pull -q "$FLEET_MEILI_NEW" >/dev/null 2>&1; then
    fleet_run --name lab-meili-dst-new -p 127.0.0.1:7703:7700 -e "MEILI_MASTER_KEY=$KEY" -e MEILI_NO_ANALYTICS=true -v lab-meili-newcopy:/meili_data "$FLEET_MEILI_NEW"
    opens=no
    for _ in $(seq 1 60); do
      if curl -fsS "http://127.0.0.1:7703/health" >/dev/null 2>&1; then opens=yes; break; fi
      fleet_running lab-meili-dst-new || break
      sleep 1
    done
    if [ "$opens" = yes ]; then
      lab_log "F: $FLEET_MEILI_NEW opened the older database: $(meili 7703 /indexes/items/stats | node "$LAB_SELF_DIR/jget.mjs" numberOfDocuments 2>/dev/null || echo '?') documents"
      echo "L12_MEILI_LATEST_OPENS=yes" >>"$LAB_DIR/l12.summary"
    else
      echo "L12_MEILI_LATEST_OPENS=no" >>"$LAB_DIR/l12.summary"
      docker logs --tail 5 lab-meili-dst-new >&2 2>&1 || true
    fi
  else
    echo "L12_MEILI_LATEST_OPENS=not-pullable" >>"$LAB_DIR/l12.summary"
  fi
  lab_log "F (observational): $(grep L12_MEILI_LATEST_OPENS "$LAB_DIR/l12.summary")"
fi
lab_pass "L12 fleet-shaped source hosts"
