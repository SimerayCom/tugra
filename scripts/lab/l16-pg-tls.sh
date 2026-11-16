#!/usr/bin/env bash
# L16: PostgreSQL with TLS, one run per image (a CI matrix):
#   L16_IMAGE=postgres:16-alpine | postgres:17-alpine | postgres:18-alpine | pgvector/pgvector:pg17
# A source database whose clients say sslmode=require needs a destination that speaks TLS (Database.ssl, R22: the importer sets it from the
# source URL; the hub starts the server with ssl=on and a self-signed pair generated once on the host, databases/database-script.ts).
#   A. a fresh destination with ssl=true, provisioned through the hub's own route: `ssl` is on, a client with sslmode=require connects
#      from INSIDE the container and from a SECOND container across the docker network, pg_stat_ssl says the session is encrypted, and
#      the data written over it reads back. (`sslmode=verify-ca` needs a CA the client trusts and stays a manual step: it must fail.)
#      A pgvector image also creates its extension and answers a nearest-neighbour query over TLS.
#   B. the data arrives over the streamed dump lane into that TLS destination and is read back over TLS (the strict fingerprint of
#      integrity.sh equal). PostgreSQL 18 skips B: the hub refuses a streamed dump into a PostgreSQL 18 destination today (see L15), and the
#      skip is recorded in l16.summary, not hidden.
set -euo pipefail
# shellcheck source=fleet.sh
. "$(dirname "${BASH_SOURCE[0]}")/fleet.sh"
# shellcheck source=stream.sh
. "$(dirname "${BASH_SOURCE[0]}")/stream.sh"

IMAGE="${L16_IMAGE:?set L16_IMAGE, e.g. postgres:17-alpine}"
MAJOR="$(fleet_pg_major "$IMAGE")"
[ -n "$MAJOR" ] || lab_die "cannot read the PostgreSQL major from $IMAGE"
MIB="${L16_MIB:-64}"
VEC_ARG=""
case "$IMAGE" in pgvector/*) VEC_ARG=vector ;; esac
export SRC_VOLUME=lab-fleet-l16

lab_guard_destructive
fleet_cleanup
: >"$LAB_DIR/l16.summary"
echo "L16_IMAGE=$IMAGE L16_MAJOR=$MAJOR" >>"$LAB_DIR/l16.summary"
lab_check "the agent can make the self-signed pair (openssl in the agent that runs the provision script)" docker exec "${LAB_AGENT:-lab-agent}" sh -c 'command -v openssl'

# ---- A. a fresh TLS destination ------------------------------------------------------------------------------------------------------
LAB_SKIP_SOURCE=1 lab_scenario_begin "l16a-$MAJOR" --kind db --engine POSTGRES --version "$MAJOR" --image "$IMAGE" --data-mode dump --ssl
lab_api POST "/databases/$DB_ID/provision" >/dev/null
lab_wait 300 "the TLS destination database to be RUNNING" bash -c "[ \"\$(node $LAB_SELF_DIR/seed.mjs db-status $DB_ID | awk '{print \$1}')\" = RUNNING ]"
CTR="tugra_db_$DB_ID"
U="$(lab_ctr_env "$CTR" POSTGRES_USER)"; D="$(lab_ctr_env "$CTR" POSTGRES_DB)"; PGPW="$(lab_ctr_env "$CTR" POSTGRES_PASSWORD)"
lab_wait 120 "the TLS destination to accept connections" docker exec "$CTR" pg_isready -U "$U"
lab_check "the server reports ssl = on" test "$(lab_pg_q "$CTR" "$U" "$D" 'show ssl')" = on
lab_check "the self-signed pair is on the host, key 0600, directory 0700" bash -c "[ \"\$(docker exec ${LAB_AGENT:-lab-agent} stat -c '%a' /etc/tugra/dbssl/$DB_ID/server.key)\" = 600 ] && [ \"\$(docker exec ${LAB_AGENT:-lab-agent} stat -c '%a' /etc/tugra/dbssl/$DB_ID)\" = 700 ]"
export LAB_PG_TLS=1
lab_check "a client with sslmode=require connects from inside the container, and the session is encrypted" test "$(lab_pg_q "$CTR" "$U" "$D" 'select ssl from pg_stat_ssl where pid = pg_backend_pid()')" = t
lab_pg_q "$CTR" "$U" "$D" "create table tls_t as select g as id, md5(g::text) as m from generate_series(1, 100000) g" >/dev/null
lab_check "rows written over TLS read back" test "$(lab_pg_q "$CTR" "$U" "$D" 'select count(*) from tls_t')" = 100000
unset LAB_PG_TLS
# a second container on the destination's own docker network, the way an application container reaches it
NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$CTR")"
IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CTR")"
[ -n "$NET" ] && [ -n "$IP" ] || lab_die "cannot read the network address of $CTR"
client() { docker run --rm --network "$NET" -e "PGPASSWORD=$PGPW" "$@"; } # <sslmode> <sql>
tls_client() { client -e "PGSSLMODE=$1" "$IMAGE" psql -h "$IP" -U "$U" -d "$D" -At -v ON_ERROR_STOP=1 -c "$2"; }
lab_check "a client container reaches it with sslmode=require and the session is encrypted" test "$(tls_client require 'select ssl from pg_stat_ssl where pid = pg_backend_pid()')" = t
lab_check "the encrypted session negotiated a TLS version" test -n "$(tls_client require 'select version from pg_stat_ssl where pid = pg_backend_pid()')"
verify_ca_refused() { ! tls_client verify-ca 'select 1' >/dev/null 2>&1; }
lab_check "sslmode=verify-ca is refused (the pair is self-signed: a CA the client trusts stays a manual step)" verify_ca_refused
if [ "$VEC_ARG" = vector ]; then
  lab_check "the pgvector extension is created over TLS" test "$(tls_client require "create extension if not exists vector; select extversion from pg_extension where extname = 'vector'" | tail -1)" != ""
  tls_client require "create table tls_v (id int primary key, e vector(3)); insert into tls_v select g, ('[' || g || ',' || (g % 7) || ',' || (g % 13) || ']')::vector from generate_series(1, 500) g" >/dev/null
  lab_check "a nearest-neighbour query answers over TLS" test -n "$(tls_client require "select id from tls_v order by e <-> '[5,5,5]' limit 1")"
fi
echo "L16_FRESH_TLS=ok" >>"$LAB_DIR/l16.summary"
lab_log "A: ok"

# ---- B. the dump arrives over the streamed lane into a TLS destination --------------------------------------------------------------
if [ "$MAJOR" -ge 18 ]; then
  echo "L16_RESTORE=skipped-pg18-destination-refused" >>"$LAB_DIR/l16.summary"
  lab_log "B: skipped on PostgreSQL 18: the hub refuses a streamed dump into a PostgreSQL 18 destination (L15 reports it as a product finding)"
  lab_pass "L16 $IMAGE: TLS destination (fresh), the streamed restore is skipped for 18"
  exit 0
fi
SRC="$(fleet_uuid)"
LAB_SKIP_SOURCE=1 lab_scenario_begin "l16b-$MAJOR" --kind db --engine POSTGRES --version "$MAJOR" --image "$IMAGE" --source "$SRC" --data-mode stream --ssl
fleet_pg_source "$SRC" "$IMAGE" "$SRC_VOLUME"
fleet_pg_load_ticks "$SRC" "$MIB"
lab_pg_integrity_seed "$SRC" tugra postgres "$VEC_ARG"
lab_pg_fingerprint "$SRC" tugra postgres ticks "$VEC_ARG" >"$LAB_DIR/l16.fp.src"
lab_stream_plan plan
lab_run copy --arms volumes
[ "$LAB_RC" = 0 ] || lab_stream_fail copy "migrator exit $LAB_RC"
lab_stream_expect_applied copy
lab_stream_transfer_done
lab_stream_dest
U="$(lab_ctr_env "$DST_CTR" POSTGRES_USER)"; D="$(lab_ctr_env "$DST_CTR" POSTGRES_DB)"
lab_wait 120 "the TLS destination to accept connections" docker exec "$DST_CTR" pg_isready -U "$U"
export LAB_PG_TLS=1
lab_check "the restored database is served over TLS (sslmode=require, encrypted session)" test "$(lab_pg_q "$DST_CTR" "$U" "$D" 'select ssl from pg_stat_ssl where pid = pg_backend_pid()')" = t
lab_pg_fingerprint "$DST_CTR" "$U" "$D" ticks "$VEC_ARG" >"$LAB_DIR/l16.fp.dst"
unset LAB_PG_TLS
lab_fingerprint_compare l16 "$LAB_DIR/l16.fp.src" "$LAB_DIR/l16.fp.dst" L16
echo "L16_RESTORE=ok" >>"$LAB_DIR/l16.summary"
lab_pass "L16 $IMAGE: TLS destination, from inside and from a client container, and the streamed restore read back over TLS"
