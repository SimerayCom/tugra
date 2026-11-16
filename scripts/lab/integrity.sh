#!/usr/bin/env bash
# Data-integrity fixtures and fingerprints for the migration lab. Sourced, never executed.
#
# Row counts prove that rows arrived; they do not prove that the database means the same thing on the target. A fingerprint is a few
# lines of `label=value`, read with the SAME queries from the source and from the destination, then compared:
#
#   strict    rows (count plus a checksum over every column of every row), extensions (pgvector), sequences' last_value, the
#             collation of the database and of a column with an explicit collation, MariaDB's AUTO_INCREMENT and charsets.
#             A difference is a failed scenario: the data does not mean the same thing on the target.
#   access    PostgreSQL roles, table ownership and ACLs; MariaDB users, schema grants and stored routines. A physical copy
#             carries the whole cluster, so the L6 and L9 copies compare these strictly. The logical and streamed dump lanes run
#             `pg_dump --no-owner --no-acl` and a `mariadb-dump` without --routines (agent/internal/migrate/recipe.go): they do not
#             carry roles, ownership, grants, users or routines. The lab RECORDS that as a finding (`FINDING` lines and
#             `*_ACCESS=dropped` in the scenario summary) and only fails on it when L_INTEGRITY_ACCESS=require.
#
# The checks never read the host's files. The queries run through `docker exec` inside the database containers.
# shellcheck shell=bash

INTEGRITY_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$INTEGRITY_SELF_DIR/lib.sh"

: "${L_INTEGRITY_ACCESS:=report}" # report | require

# lab_ctr_env <container> <VAR>: one environment variable of a container (the credentials the hub gave a destination database).
lab_ctr_env() { docker exec "$1" printenv "$2"; }

# ---- PostgreSQL --------------------------------------------------------------------------------------------------------------------

# lab_pg_q <container> <user> <db> <sql>: one statement, unaligned and tuples-only, stop on the first error. LAB_PG_TLS=1 connects over TCP
# on the container's loopback with sslmode=require (a destination that serves TLS), instead of the local socket.
lab_pg_q() {
  local env=() host=()
  if [ -n "${LAB_PG_TLS:-}" ]; then env=(-e PGSSLMODE=require); host=(-h 127.0.0.1); fi
  docker exec -i ${env[@]+"${env[@]}"} "$1" psql ${host[@]+"${host[@]}"} -U "$2" -d "$3" -At -v ON_ERROR_STOP=1 -c "$4"
}

# lab_pg_integrity_seed <container> <user> <db> [vector]: the objects a row count cannot see, in the database the fixture fills.
# lab_own: a table owned by a login role, selectable by a second role (ownership and an ACL). lab_seq and lab_ser: sequences whose
# last_value is not 1 (a restore that forgets setval hands out duplicate keys). lab_coll: a column with an explicit collation.
lab_pg_integrity_seed() {
  local c="$1" u="$2" d="$3" vec="${4:-}"
  lab_pg_q "$c" "$u" "$d" "create role lab_app login password 'lab-app-pw'; create role lab_ro nologin" >/dev/null
  lab_pg_q "$c" "$u" "$d" "create table lab_own (id int primary key, note text not null); insert into lab_own select g, md5(g::text) from generate_series(1, 1000) g; alter table lab_own owner to lab_app; grant select on lab_own to lab_ro" >/dev/null
  lab_pg_q "$c" "$u" "$d" "create sequence lab_seq start 1000 increment 7; select setval('lab_seq', 7777)" >/dev/null
  lab_pg_q "$c" "$u" "$d" "create table lab_ser (id serial primary key, v text not null); insert into lab_ser (v) select md5(g::text) from generate_series(1, 250) g" >/dev/null
  lab_pg_q "$c" "$u" "$d" "create table lab_coll (w text collate \"C\" not null); create index lab_coll_w on lab_coll (w); insert into lab_coll values ('b'), ('B'), ('a'), ('A'), ('z'), ('Z'), ('_')" >/dev/null
  if [ "$vec" = vector ]; then
    lab_pg_q "$c" "$u" "$d" "create extension if not exists vector; create table lab_v (id int primary key, e vector(3)); insert into lab_v select g, ('[' || g || ',' || (g % 7) || ',' || (g % 13) || ']')::vector from generate_series(1, 2000) g; create index lab_v_e on lab_v using hnsw (e vector_l2_ops)" >/dev/null
  fi
}

# lab_pg_fingerprint <container> <user> <db> <table> [vector]: the lines of both groups, `strict.<label>=<value>` and
# `access.<label>=<value>`, sorted. <table> is the big table: rows are counted and checksummed over every column.
lab_pg_fingerprint() {
  local c="$1" u="$2" d="$3" t="$4" vec="${5:-}" sql
  sql="select 'strict.rows=' || count(*) || ':' || coalesce(sum(hashtextextended(x::text, 0)), 0) from $t x
union all select 'strict.lab_own=' || count(*) || ':' || coalesce(sum(hashtextextended(x::text, 0)), 0) from lab_own x
union all select 'strict.lab_ser=' || count(*) || ':' || coalesce(sum(hashtextextended(x::text, 0)), 0) from lab_ser x
union all select 'strict.extensions=' || coalesce(string_agg(extname || '@' || extversion, ',' order by extname), '') from pg_extension where extname <> 'plpgsql'
union all select 'strict.seq.' || sequencename || '=' || coalesce(last_value::text, 'unused') from pg_sequences where sequencename in ('lab_seq', 'lab_ser_id_seq')
union all select 'strict.collation.db=' || datcollate || '/' || datctype || '/' || pg_encoding_to_char(encoding) from pg_database where datname = current_database()
union all select 'strict.collation.column=' || string_agg(w, ',' order by w) from lab_coll
union all select 'strict.collation.attr=' || (select c.collname from pg_attribute a join pg_collation c on c.oid = a.attcollation where a.attrelid = 'lab_coll'::regclass and a.attname = 'w')
union all select 'access.roles=' || coalesce(string_agg(rolname || ':' || rolcanlogin::text, ',' order by rolname), '') from pg_roles where rolname in ('lab_app', 'lab_ro')
union all select 'access.owner=' || tableowner from pg_tables where tablename = 'lab_own'
union all select 'access.acl=' || coalesce(relacl::text, 'none') from pg_class where relname = 'lab_own'"
  if [ "$vec" = vector ]; then
    sql="$sql
union all select 'strict.vector=' || count(*) || ':' || coalesce(sum(hashtextextended(x::text, 0)), 0) from lab_v x
union all select 'strict.vector.index=' || count(*) from pg_indexes where indexname = 'lab_v_e' and indexdef like '%hnsw%'"
  fi
  lab_pg_q "$c" "$u" "$d" "$sql" | sort
}

# ---- MariaDB -----------------------------------------------------------------------------------------------------------------------

# lab_maria_q <container> <password> <db> <sql>: as root, one statement, tab separated without a header.
lab_maria_q() { docker exec -i -e "MYSQL_PWD=$2" "$1" mariadb -uroot -N -B "$3" -e "$4"; }

# lab_maria_integrity_seed <container> <password> <db>: a user with a schema grant, a stored function and a column with an explicit
# collation next to the big table (`blobs`).
lab_maria_integrity_seed() {
  local c="$1" pw="$2" d="$3"
  lab_maria_q "$c" "$pw" "$d" "create user 'lab_u'@'%' identified by 'lab-u-pw'; grant select, insert on \`$d\`.* to 'lab_u'@'%'; create user 'lab_ro'@'%' identified by 'lab-ro-pw'; grant select on \`$d\`.* to 'lab_ro'@'%'" >/dev/null
  lab_maria_q "$c" "$pw" "$d" "create table lab_coll (w varchar(20) character set latin1 collate latin1_bin not null primary key) engine=InnoDB; insert into lab_coll values ('b'), ('B'), ('a'), ('A'), ('z'), ('Z'), ('_')" >/dev/null
  lab_maria_q "$c" "$pw" "$d" "create table lab_ser (id int auto_increment primary key, v varchar(40) not null) auto_increment=1000 engine=InnoDB; insert into lab_ser (v) select md5(seq) from seq_1_to_250" >/dev/null
  lab_maria_q "$c" "$pw" "$d" "create function lab_fn(a int) returns int deterministic return a * 3" >/dev/null
}

# lab_maria_fingerprint <container> <password> <db>: `strict.*` and `access.*` lines, sorted.
lab_maria_fingerprint() {
  local c="$1" pw="$2" d="$3" sql
  sql="select concat('strict.rows=', count(*), ':', coalesce(sum(crc32(v)), 0), ':', coalesce(sum(id), 0)) from blobs
union all select concat('strict.lab_ser=', count(*), ':', coalesce(sum(crc32(v)), 0)) from lab_ser
union all select concat('strict.lab_coll=', group_concat(w order by w separator ',')) from lab_coll
union all select concat('strict.autoinc.', table_name, '=', coalesce(auto_increment, 0)) from information_schema.tables where table_schema = database() and table_name in ('blobs', 'lab_ser')
union all select concat('strict.collation.db=', default_character_set_name, '/', default_collation_name) from information_schema.schemata where schema_name = database()
union all select concat('strict.collation.table.', table_name, '=', table_collation) from information_schema.tables where table_schema = database() and table_name in ('blobs', 'lab_coll')
union all select concat('access.users=', coalesce(group_concat(user order by user separator ','), '')) from mysql.user where user in ('lab_u', 'lab_ro')
union all select concat('access.grants=', coalesce(group_concat(concat(grantee, ':', privilege_type) order by grantee, privilege_type separator ','), '')) from information_schema.schema_privileges where table_schema = database() and grantee like '%lab\\_%'
union all select concat('access.routines=', coalesce(group_concat(routine_name order by routine_name separator ','), '')) from information_schema.routines where routine_schema = database()"
  lab_maria_q "$c" "$pw" "$d" "$sql" | sort
}

# ---- comparing ---------------------------------------------------------------------------------------------------------------------

# lab_fingerprint_compare <label> <source-file> <destination-file> <summary-key> [strict-access]: every `strict.` line must be equal.
# The `access.` lines are compared too: strict-access (a physical copy) fails on a difference, otherwise the difference is recorded
# as a FINDING in the log and as <summary-key>_ACCESS=dropped in the scenario's summary, $LAB_DIR/<label up to the first dash>.summary (or `carried` when nothing differs), and
# fails only when L_INTEGRITY_ACCESS=require.
lab_fingerprint_compare() {
  local label="$1" src="$2" dst="$3" key="$4" strict_access="${5:-}" line sum
  sum="$LAB_DIR/${label%%-*}.summary" # l10-under and l10-stream both record into l10.summary
  local srcs="$LAB_DIR/$label.fp.strict.src" dsts="$LAB_DIR/$label.fp.strict.dst"
  grep '^strict\.' "$src" >"$srcs" || true
  grep '^strict\.' "$dst" >"$dsts" || true
  [ -s "$srcs" ] || lab_die "$label: the source fingerprint is empty"
  if ! diff -u "$srcs" "$dsts" >"$LAB_DIR/$label.fp.strict.diff"; then
    cat "$LAB_DIR/$label.fp.strict.diff" >&2
    lab_die "$label: the destination does not mean the same as the source (strict fingerprint differs, see above)"
  fi
  lab_log "ok: $label strict fingerprint equal ($(wc -l <"$srcs" | tr -d ' ') facts: rows and checksums, extensions, sequences, collation)"
  local sa="$LAB_DIR/$label.fp.access.src" da="$LAB_DIR/$label.fp.access.dst"
  grep '^access\.' "$src" >"$sa" || true
  grep '^access\.' "$dst" >"$da" || true
  if diff -u "$sa" "$da" >"$LAB_DIR/$label.fp.access.diff"; then
    lab_log "ok: $label roles/users, ownership and grants are carried"
    echo "${key}_ACCESS=carried" >>"$sum"
    return 0
  fi
  while read -r line; do lab_log "  access: $line"; done <"$LAB_DIR/$label.fp.access.diff"
  echo "${key}_ACCESS=dropped" >>"$sum"
  if [ -n "$strict_access" ] || [ "$L_INTEGRITY_ACCESS" = require ]; then
    lab_die "$label: roles/users, ownership, grants or routines were not carried to the destination (diff above)"
  fi
  lab_log "FINDING $label: the destination dropped roles/users, ownership, grants or routines (see the access diff); the streamed dump runs without ownership, ACL or routine options. Set L_INTEGRITY_ACCESS=require to make this a failure."
}
