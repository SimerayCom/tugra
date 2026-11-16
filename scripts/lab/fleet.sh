#!/usr/bin/env bash
# Fleet-shaped fixtures for the migration lab. Sourced, never executed (see docs/runbooks/migration-lab.md, "Fleet-shaped lab").
#
# The first lab fixture was one STOPPED container with 256 MiB to 6 GiB of urandom data. A real estate looks different: sources
# are RUNNING containers whose names are 24-character uuids (databases) or `<uuid>-<13 digits>` (applications), the databases
# are multi-GB time-series tables and over-the-logical-cap MariaDBs, object storage keeps many buckets on a host bind mount that
# docker's own volume accounting cannot see, and a host also carries containers and volumes the import never lists. Everything here
# is GENERATED at run time on the runner (nothing big lives in git) and uses neutral invented names.
#
# Everything this file creates carries the docker label `tugra.lab.fleet=1`, so `fleet_cleanup` (and down.sh) remove exactly that and
# nothing else on the host.
# shellcheck shell=bash

FLEET_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$FLEET_SELF_DIR/lib.sh"

: "${FLEET_LABEL:=tugra.lab.fleet=1}"
: "${FLEET_NET:=lab-fleet-net}"
: "${FLEET_PG_BATCH_ROWS:=1000000}"
: "${FLEET_REDIS_IMAGE:=redis:7.2-alpine}"
: "${FLEET_MARIADB_IMAGE:=mariadb:11}"
: "${FLEET_MINIO_IMAGE:=minio/minio:RELEASE.2025-04-22T22-12-26Z}"
: "${FLEET_MC_IMAGE:=minio/mc:latest}"
: "${FLEET_MEILI_OLD:=getmeili/meilisearch:v1.31.0}"
: "${FLEET_MEILI_NEW:=getmeili/meilisearch:latest}"
# MinIO bucket size classes (MiB) of the real object store: 12 buckets, the biggest 3.9 GB. FLEET_MINIO_DIV scales them down for a
# runner (default 4, about 2.1 GiB in total); FLEET_MINIO_DIV=1 is the real shape.
: "${FLEET_MINIO_BUCKETS:=3900 1900 1400 534 296 188 107 80 24 20 12 8}"
: "${FLEET_MINIO_DIV:=4}"
FLEET_MINIO_USER=labadmin
FLEET_MINIO_PASS=lab-secret-0123456789
FLEET_REDIS_PASS=lab-redis-0123456789

# ---- names ---------------------------------------------------------------------------------------------------------------------

# fleet_uuid: a Coolify-style resource name, 24 lowercase alphanumerics starting with a letter. A database container carries exactly
# this name; an application container is `<uuid>-<fleet_stamp>`.
fleet_uuid() { printf 'l%s' "$(openssl rand -hex 12 | cut -c1-23)"; }
# fleet_stamp: a 13 digit deploy timestamp (milliseconds), the suffix Coolify puts on an application container.
fleet_stamp() { printf '%s000' "$(date +%s)"; }

# fleet_run <docker run args...>: a labelled detached container.
fleet_run() { docker run -d --label "$FLEET_LABEL" "$@" >/dev/null; }
fleet_volume() { docker volume create --label "$FLEET_LABEL" "$1" >/dev/null; }
fleet_net_up() { docker network inspect "$FLEET_NET" >/dev/null 2>&1 || docker network create --label "$FLEET_LABEL" "$FLEET_NET" >/dev/null; }

# fleet_running <container>: true while docker reports it running.
fleet_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo missing)" = true ]; }

# ---- host bind mounts ----------------------------------------------------------------------------------------------------------

# fleet_bind_root: where bind-mounted data lives. The real estate keeps object storage on an attached volume mounted under /mnt,
# so the default is /mnt/tugra-lab-binds (a GitHub runner has a separate /mnt disk, which also keeps the root disk free). The path
# must be a plain one: the migrator refuses an unsafe or system path even with --allow-bind.
fleet_bind_root() {
  local root="${FLEET_BIND_ROOT:-/mnt/tugra-lab-binds}"
  if [ ! -d "$root" ]; then
    mkdir -p "$root" 2>/dev/null || { sudo -n mkdir -p "$root" 2>/dev/null && sudo -n chown "$(id -u):$(id -g)" "$root" 2>/dev/null; } || root="$LAB_DIR/binds"
    mkdir -p "$root"
  fi
  printf '%s' "$root"
}

# fleet_bind_dir <name>: a fresh empty bind directory below fleet_bind_root.
fleet_bind_dir() {
  local d; d="$(fleet_bind_root)/$1"
  docker run --rm -v "$(dirname "$d")":/b "$(lab_helper_image)" sh -c 'rm -rf "/b/$1" && mkdir -p "/b/$1"' _ "$1"
  printf '%s' "$d"
}

# fleet_bytes_on_disk <dir>: apparent bytes below a directory, read through a container so root-owned files do not hide.
fleet_bytes_on_disk() {
  docker run --rm -v "$1":/b:ro "$(lab_helper_image)" sh -c 'find /b -type f -exec stat -c %s {} + | awk "{s+=\$1} END{print s+0}"' | tr -d ' \n'; echo
}

# fleet_local_volumes_bytes: what `docker system df` reports for "Local Volumes" (the inventory the docker CLI offers).
fleet_local_volumes_bytes() {
  local size
  size="$(docker system df --format '{{.Type}}|{{.Size}}' | awk -F'|' '$1=="Local Volumes"{print $2}')"
  [ -n "$size" ] || { echo 0; return; }
  node "$LAB_SELF_DIR/units.mjs" parse "$size" 2>/dev/null || echo 0
}

# ---- PostgreSQL: a big append-only time-series table -------------------------------------------------------------------------------

# fleet_pg_major <image> -> 16 | 17 | 18 (empty when unknown).
fleet_pg_major() {
  case "$1" in
    postgres:16* | pgvector/pgvector:pg16*) echo 16 ;;
    postgres:17* | pgvector/pgvector:pg17*) echo 17 ;;
    postgres:18* | pgvector/pgvector:pg18*) echo 18 ;;
    *) echo "${L6_MAJOR:-}" ;;
  esac
}
# fleet_pg_mount <image>: where the image keeps its volume. 16 and 17 mount PGDATA itself; 18 keeps PGDATA one level down.
fleet_pg_mount() { if [ "$(fleet_pg_major "$1")" -ge 18 ] 2>/dev/null; then echo /var/lib/postgresql; else echo /var/lib/postgresql/data; fi; }

fleet_pg_sql() { docker exec "$1" psql -U tugra -d postgres -At -v ON_ERROR_STOP=1 -c "$2"; }

# fleet_pg_wait <container>: accepting connections after the image's init phase (which restarts the server once).
fleet_pg_wait() {
  lab_wait 120 "postgres in $1 to accept connections" docker exec "$1" pg_isready -U tugra
  sleep 3
  lab_wait 60 "postgres in $1 after its init restart" docker exec "$1" pg_isready -U tugra
}

# fleet_pg_source <container> <image> <volume>: a RUNNING PostgreSQL with the superuser name the Tugra database container uses
# (POSTGRES_USER=tugra), its data on a labelled volume mounted where the image keeps it. POSTGRES_DB=postgres: the migrator's logical
# dump reads the one database name from the container environment, and that is the database the fixture fills.
fleet_pg_source() {
  local name="$1" image="$2" vol="$3"
  fleet_volume "$vol"
  fleet_run --name "$name" -e POSTGRES_USER=tugra -e POSTGRES_PASSWORD=lab -e POSTGRES_DB=postgres -v "$vol:$(fleet_pg_mount "$image")" "$image"
  fleet_pg_wait "$name"
}

# fleet_pg_load_ticks <container> <MiB>: an append-only tick table (a monotonic timestamp, a symbol, two prices, a venue and a
# 128 byte payload, about 190 bytes a row) grown in batches until pg_total_relation_size reaches the target. Heap pages like these
# compress, unlike urandom, which is the point of the L7 and L9 cases. A BRIN index on the timestamp, as an append-only table has.
# The size must stay FROZEN once the loader returns (L9 compares pg_total_relation_size of source and copy): autovacuum is off for the
# table and its toast table and the BRIN index does not autosummarize, and one explicit VACUUM at the end creates the _vm/_fsm forks
# and summarises the BRIN ranges, so nothing background-driven can change a fork between the reading and the stop.
fleet_pg_load_ticks() {
  local c="$1" want="$2" k=0 n="$FLEET_PG_BATCH_ROWS" mib
  fleet_pg_sql "$c" "create table if not exists ticks (ts timestamptz not null, sym int not null, bid bigint not null, ask bigint not null, venue text not null, pad text not null) with (autovacuum_enabled = false, toast.autovacuum_enabled = false); create index if not exists ticks_ts_brin on ticks using brin (ts) with (autosummarize = off)" >/dev/null
  while :; do
    mib="$(fleet_pg_sql "$c" "select pg_total_relation_size('ticks') / 1048576")"
    [ "$mib" -lt "$want" ] || break
    fleet_pg_sql "$c" "insert into ticks select timestamptz '2026-01-01 00:00:00+00' + (g * interval '1 millisecond'), (g % 500)::int, (random() * 1000000)::bigint, (random() * 1000000)::bigint, 'v' || (g % 7), repeat(md5(g::text), 4) from generate_series($((k * n + 1)), $(((k + 1) * n))) g" >/dev/null
    k=$((k + 1))
    [ $((k % 5)) -ne 0 ] || lab_log "fixture: ticks at ${mib} MiB of ${want} MiB"
  done
  fleet_pg_sql "$c" "vacuum (analyze) ticks" >/dev/null
  fleet_pg_sql "$c" "checkpoint" >/dev/null
  lab_log "fixture: ticks is $(fleet_pg_sql "$c" "select pg_total_relation_size('ticks') / 1048576") MiB, $(fleet_pg_sql "$c" 'select count(*) from ticks') rows"
}

# ---- MariaDB -------------------------------------------------------------------------------------------------------------------

fleet_mariadb_sql() { docker exec -e "MYSQL_PWD=$2" "$1" mariadb -uroot -N -B fleetdb -e "$3"; }

# fleet_mariadb_source <container> <volume> <password>: a RUNNING mariadb with the environment the migrator's credential
# discovery reads (MARIADB_ROOT_PASSWORD plus the one database it dumps), data on a labelled volume.
fleet_mariadb_source() {
  local name="$1" vol="$2" pw="$3"
  fleet_volume "$vol"
  fleet_run --name "$name" -e "MARIADB_ROOT_PASSWORD=$pw" -e MARIADB_DATABASE=fleetdb -e MARIADB_USER=fleet -e "MARIADB_PASSWORD=$pw" -v "$vol:/var/lib/mysql" "$FLEET_MARIADB_IMAGE"
  lab_wait 180 "mariadb in $name" docker exec -e "MYSQL_PWD=$pw" "$name" mariadb-admin -uroot ping
  sleep 2
  lab_wait 60 "mariadb in $name after its init restart" docker exec -e "MYSQL_PWD=$pw" "$name" mariadb-admin -uroot ping
}

# fleet_mariadb_load <container> <password> <MiB>: about MiB of incompressible text (1 KiB of sha2 hex per row; a logical dump of
# it is about the same size, and gzip takes it to about half), loaded in batches of 50000 rows.
fleet_mariadb_load() {
  local c="$1" pw="$2" want="$3" rows=0 target
  fleet_mariadb_sql "$c" "$pw" "create table if not exists blobs (id int auto_increment primary key, v text not null) engine=InnoDB" >/dev/null
  target=$((want * 1024))
  while [ "$rows" -lt "$target" ]; do
    fleet_mariadb_sql "$c" "$pw" "insert into blobs (v) select concat(sha2(rand(), 512), sha2(rand(), 512), sha2(rand(), 512), sha2(rand(), 512), sha2(rand(), 512), sha2(rand(), 512), sha2(rand(), 512), sha2(rand(), 512)) from seq_1_to_50000" >/dev/null
    rows=$((rows + 50000))
    [ $((rows % 500000)) -ne 0 ] || lab_log "fixture: mariadb at $((rows / 1024)) MiB of ${want} MiB"
  done
  lab_log "fixture: mariadb blobs holds $(fleet_mariadb_sql "$c" "$pw" 'select count(*) from blobs') rows"
}

# ---- MinIO: many buckets on a bind mount -----------------------------------------------------------------------------------------

# fleet_mc <args...>: the mc client on the fleet network. FLEET_MC_SRC / FLEET_MC_DST name the MinIO containers behind the aliases
# `src` and `dst`; /stage is the read-only object staging directory.
fleet_mc() {
  mkdir -p "${FLEET_MC_STAGE:-$LAB_DIR/minio-stage}" # docker would otherwise create the missing mount source as root
  docker run --rm --network "$FLEET_NET" --label "$FLEET_LABEL" -v "${FLEET_MC_STAGE:-$LAB_DIR/minio-stage}":/stage:ro \
    -e "MC_HOST_src=http://${FLEET_MINIO_USER}:${FLEET_MINIO_PASS}@${FLEET_MC_SRC:-none}:9000" \
    -e "MC_HOST_dst=http://${FLEET_MINIO_USER}:${FLEET_MINIO_PASS}@${FLEET_MC_DST:-none}:9000" \
    "$FLEET_MC_IMAGE" "$@"
}

# fleet_minio_run <container> <data-mount-source>: a RUNNING single-drive MinIO, its /data a bind mount (a host path) or a volume.
fleet_minio_run() {
  fleet_net_up
  fleet_run --name "$1" --network "$FLEET_NET" -e "MINIO_ROOT_USER=$FLEET_MINIO_USER" -e "MINIO_ROOT_PASSWORD=$FLEET_MINIO_PASS" \
    -v "$2:/data" "$FLEET_MINIO_IMAGE" server /data --console-address :9001
  FLEET_MC_SRC="$1" lab_wait 90 "MinIO $1 to answer" fleet_mc ls src
}

# fleet_minio_plan: "<bucket> <objects>" for each bucket size class (FLEET_MINIO_BUCKETS scaled by FLEET_MINIO_DIV, at least 1 MiB), in
# objects of 32 MiB. Pure: the fill below and the harness self-test read the same numbers.
fleet_minio_plan() {
  local idx=0 real mib
  for real in $FLEET_MINIO_BUCKETS; do
    mib=$((real / FLEET_MINIO_DIV)); [ "$mib" -ge 1 ] || mib=1
    printf 'bk-%02d %s\n' "$idx" $(((mib + 31) / 32))
    idx=$((idx + 1))
  done
}

# fleet_minio_fill <container>: the 12 bucket size classes of the real object store (scaled by FLEET_MINIO_DIV) of incompressible
# 32 MiB objects. One random object is hard-linked under many names, so the staging directory costs 32 MiB, MinIO stores every key
# as its own object. Writes "<buckets> <objects> <bytes>" to $LAB_DIR/minio.expected and "<bucket> <objects>" per bucket to
# $LAB_DIR/minio.buckets.
fleet_minio_fill() {
  local c="$1" stage="$LAB_DIR/minio-stage" b objs i buckets=0 total_objs=0
  rm -rf "$stage"; mkdir -p "$stage"; : >"$LAB_DIR/minio.buckets"
  dd if=/dev/urandom of="$stage/.obj" bs=1048576 count=32 2>/dev/null
  export FLEET_MC_SRC="$c" FLEET_MC_STAGE="$stage"
  while read -r b objs; do
    mkdir "$stage/$b"
    i=1; while [ "$i" -le "$objs" ]; do ln "$stage/.obj" "$stage/$b/o-$i"; i=$((i + 1)); done
    fleet_mc mb --ignore-existing "src/$b" >/dev/null
    fleet_mc cp --recursive "/stage/$b/" "src/$b/" >/dev/null
    echo "$b $objs" >>"$LAB_DIR/minio.buckets"
    total_objs=$((total_objs + objs)); buckets=$((buckets + 1))
  done < <(fleet_minio_plan)
  echo "$buckets $total_objs $((total_objs * 33554432))" >"$LAB_DIR/minio.expected"
  lab_log "fixture: MinIO $c holds $buckets buckets, $total_objs objects, $((total_objs * 32)) MiB"
}

# ---- Redis, orphans -------------------------------------------------------------------------------------------------------------

# fleet_redis <container> [conf-file]: a RUNNING redis 7.2 with a password on its command line (as a Coolify standalone redis
# starts), optionally with a custom conf file mounted as the real one's `redis_conf` is. Its data is on a labelled volume.
fleet_redis() {
  local name="$1" conf="${2:-}"
  fleet_volume "lab-data-$name"
  if [ -n "$conf" ]; then
    fleet_run --name "$name" -v "lab-data-$name:/data" -v "$conf:/usr/local/etc/redis/redis.conf:ro" "$FLEET_REDIS_IMAGE" \
      redis-server /usr/local/etc/redis/redis.conf --requirepass "$FLEET_REDIS_PASS" --appendonly yes
  else
    fleet_run --name "$name" -v "lab-data-$name:/data" "$FLEET_REDIS_IMAGE" redis-server --requirepass "$FLEET_REDIS_PASS" --appendonly yes
  fi
}
fleet_redis_cli() { docker exec "$1" redis-cli --no-auth-warning -a "$FLEET_REDIS_PASS" "${@:2}"; }

# fleet_orphan_volumes <count> <MiB>: docker volumes no container uses (LINKS 0), as the leftovers of removed WordPress services.
fleet_orphan_volumes() {
  local i=1
  while [ "$i" -le "$1" ]; do
    fleet_volume "lab-orphan-wp-$i"
    docker run --rm -v "lab-orphan-wp-$i":/data "$(lab_helper_image)" sh -c 'dd if=/dev/urandom of=/data/wp.bin bs=1048576 count="$1" 2>/dev/null; mkdir -p /data/wp-content; echo x > /data/wp-content/index.php; chown -R 33:33 /data' _ "$2"
    i=$((i + 1))
  done
}

# ---- teardown ------------------------------------------------------------------------------------------------------------------

# fleet_cleanup: remove every container, volume and the network the fleet fixtures created (the label), the MinIO staging
# directory and the bind directories. Never touches anything without the label.
fleet_cleanup() {
  local c v
  for c in $(docker ps -aq --filter "label=$FLEET_LABEL" 2>/dev/null); do docker rm -f -v "$c" >/dev/null 2>&1 || true; done
  # the labelled volumes, and the unlabelled source volumes fixture.sh creates for the fleet scenarios (named lab-fleet-*)
  for v in $(docker volume ls -q --filter "label=$FLEET_LABEL" 2>/dev/null) $(docker volume ls -q --filter "name=lab-fleet-" 2>/dev/null); do docker volume rm -f "$v" >/dev/null 2>&1 || true; done
  docker network rm "$FLEET_NET" >/dev/null 2>&1 || true
  rm -rf "$LAB_DIR/minio-stage" "$LAB_DIR/minio.expected" "$LAB_DIR/minio.buckets" 2>/dev/null || true
  local root="${FLEET_BIND_ROOT:-/mnt/tugra-lab-binds}"
  [ -d "$root" ] && docker run --rm -v "$root":/b "$(lab_helper_image)" sh -c 'rm -rf /b/* /b/.[!.]* 2>/dev/null; true' >/dev/null 2>&1 || true
  [ ! -d "$LAB_DIR/binds" ] || docker run --rm -v "$LAB_DIR/binds":/b "$(lab_helper_image)" sh -c 'rm -rf /b/* /b/.[!.]* 2>/dev/null; true' >/dev/null 2>&1 || true
}

# fleet_snapshot_others <name-to-exclude...>: "name state" of every container except the named ones and the migrator's own, sorted.
# Two reads around a run show nothing else on the host was stopped, started or removed.
fleet_snapshot_others() {
  local ex="|$(printf '%s|' "$@")"
  docker ps -a --format '{{.Names}} {{.State}}' | grep -v -E '^tugra-migrator-' | while read -r n s; do
    case "$ex" in *"|$n|"*) continue ;; esac
    echo "$n $s"
  done | sort
}
