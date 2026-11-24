/**
 * The in-container scripts of the engines whose client takes the password on the command line (MongoDB, ClickHouse), rebuilt so the
 * password is never on ANY argv: not the host's `docker exec` client, not the process inside the container (both are readable
 * from the host's process list).
 *
 * How: the password rides the environment as `TUGRA_DB_PW` (`docker exec -e TUGRA_DB_PW`, the value is read from the caller's own
 * environment), and the script writes it into a client config file (`mongodump --config`, `clickhouse-client --config-file`)
 * created with mode 0600 in the container's tmpfs (`/dev/shm`, else `/tmp`), removed on every exit path. The shell only ever
 * expands it as a builtin (`printf`), and escapes it for the file format through a pipe (`sed` reads it from stdin).
 *
 * Every body is ONE line, contains no single quote (so it can sit inside `sh -c '...'` of a recipe), and takes its non-secret
 * inputs as positional parameters: `$1` user, `$2` database (ClickHouse) or mode (stats). The Go migrator
 * (`agent/internal/migrate/safebodies.go`) carries a byte-identical copy of every constant; both sides are pinned to
 * `test/fixtures/safe-db-scripts.json` (a hub test fails when any copy drifts).
 */

/** The environment variable that carries the database password into the container. */
export const DB_PW_ENV = "TUGRA_DB_PW";

/** The password goes through a config file, so a control character (newline, NUL...) cannot be carried faithfully: refuse it. */
export function assertPasswordForConfigFile(pw: string): string {
  if (typeof pw !== "string" || pw.length === 0 || pw.length > 256 || /[\u0000-\u001f\u007f]/.test(pw)) throw new Error("the database password cannot be carried through a config file");
  return pw;
}

/** The config file of the in-container client; `rmExtra` is an additional path (a staged archive) removed on exit. */
const cfgPrelude = (rmExtra: boolean): string =>
  String.raw`umask 077; d=/dev/shm; [ -w "$d" ] || d=/tmp; f=$(mktemp "$d/tugra-dbcfg.XXXXXX") || exit 1; ` +
  (rmExtra ? String.raw`trap "rm -f \"$f\" \"$z\"" EXIT; ` : String.raw`trap "rm -f \"$f\"" EXIT; `) +
  String.raw`trap "exit 1" HUP INT TERM; `;

// ───────────────────────────── MongoDB ─────────────────────────────

/**
 * mongodump / mongorestore read `password:` from a YAML file: a double-quoted scalar, so `\` and `"` are the only characters to escape.
 * A pipeline at the top level, NOT `$(...)` inside double quotes: shells disagree about backslashes in a nested quote (dash 0.5.11 and a
 * posix-mode bash drop one), a plain pipeline is the same everywhere.
 */
const MONGO_YAML = String.raw`{ printf "password: \""; printf "%s" "$TUGRA_DB_PW" | sed "s/[\\\\\"]/\\\\&/g" | tr -d "\n"; printf "\"\n"; } > "$f" || exit 1; `;
const mongoTool = (tool: "mongodump" | "mongorestore"): string => `${tool} --help 2>&1 | grep -q -- --config || { echo "tugra: ${tool} has no --config" >&2; exit 1; }; `;

/** `$1` user. The whole instance as one archive on stdout (the archive carries its own namespaces). Authenticates against `admin`. */
export const MONGO_DUMP_BODY = cfgPrelude(false) + mongoTool("mongodump") + MONGO_YAML + String.raw`mongodump --config "$f" --username "$1" --authenticationDatabase admin --archive`;

/** `$1` user. The archive on stdin; a foreign dump's `admin.*` is never restored (it would replace the target's own root user). */
export const MONGO_RESTORE_BODY = cfgPrelude(false) + mongoTool("mongorestore") + MONGO_YAML + String.raw`mongorestore --config "$f" --username "$1" --authenticationDatabase admin --archive --drop --nsExclude "admin.*"`;

/**
 * `$1` user, `$2` mode (`exact` | `estimate`), `$3` threshold (integer), `$4` the JavaScript to run (a constant below). The shell is
 * `mongosh`, else the legacy `mongo`; the JavaScript reads the password from the environment itself (`process.env`, `_getEnv`).
 */
export const MONGO_SHELL_BODY = String.raw`m=mongosh; command -v mongosh >/dev/null 2>&1 || m=mongo; "$m" --quiet --norc --eval "var U=\"$1\",M=\"$2\",B=$3; $4"`;

const MONGO_AUTH_JS = String.raw`var env=function(n){return typeof process!=="undefined"?process.env[n]:_getEnv(n)};var a=db.getSiblingDB("admin");a.auth(U,env("TUGRA_DB_PW"));`;

/**
 * One line per collection of every user database: `<db>.<collection><TAB><documents><TAB><estimated 0|1>`. `exact` counts every
 * collection; `estimate` takes the metadata count for collections at or above the threshold (flagged estimated). Views and `system.*`
 * are not data. A name with a control character is reported uncounted (-1) under a sanitised name.
 */
export const MONGO_STATS_JS =
  MONGO_AUTH_JS +
  String.raw`a.adminCommand({listDatabases:1,nameOnly:true}).databases.map(function(d){return d.name}).filter(function(n){return["admin","local","config"].indexOf(n)<0}).sort().forEach(function(n){var d=db.getSiblingDB(n);d.getCollectionInfos({type:"collection"},true).map(function(i){return i.name}).filter(function(c){return c.indexOf("system.")!==0}).sort().forEach(function(c){var k=d.getCollection(c);var nm=n+"."+c;if(/[\u0000-\u001f\u007f]/.test(nm)){print(nm.replace(/[\u0000-\u001f\u007f]/g,"?")+"\t-1\t0");return}var e=k.estimatedDocumentCount?k.estimatedDocumentCount():k.count();if(M==="estimate"&&e>=B){print(nm+"\t"+e+"\t1");return}var r;try{r=k.countDocuments?k.countDocuments({}):k.count()}catch(x){r=-1}print(nm+"\t"+r+"\t0")})})`;

/** The on-disk size of every database of the instance, in bytes (one integer). */
export const MONGO_SIZE_JS = MONGO_AUTH_JS + String.raw`print(String(a.adminCommand({listDatabases:1}).totalSize))`;

// ───────────────────────────── ClickHouse ─────────────────────────────

/** A single quote inside a ClickHouse statement: the shell variable `q` the client prelude defines (a body has no quote of its own). */
const Q = "${q}";
const CH_BACKUPS_DIR = "/var/lib/clickhouse/backups";

/**
 * `clickhouse-client --config-file` takes `<user>` and `<password>`; both are XML-escaped through a pipe. The client function `c`
 * never reads the script's stdin (`</dev/null`: the restore body feeds the archive on it). `umask 022` after the file is written, so
 * a staged archive is readable by the server user (uid 101), which is not root. `$q` is a single quote (a body has none of its own).
 */
const chClient = String.raw`q=$(printf "\047"); x() { sed -e "s/&/\\&amp;/g" -e "s/</\\&lt;/g" -e "s/>/\\&gt;/g"; }; { printf "<clickhouse><user>"; printf "%s" "$1" | x; printf "</user><password>"; printf "%s" "$TUGRA_DB_PW" | x; printf "</password></clickhouse>\n"; } > "$f" || exit 1; umask 022; c() { clickhouse-client --config-file "$f" --host 127.0.0.1 --port 9000 "$@" </dev/null; }; `;
/** The server accepts connections only seconds after the container is running: poll `SELECT 1`. */
const chWait = String.raw`i=0; until c --query "SELECT 1" >/dev/null 2>&1; do i=$((i+1)); [ $i -ge 30 ] && { echo "tugra: clickhouse not ready" >&2; exit 1; }; sleep 2; done; `;
/** `docker exec` is root; the server is not: the backups directory must belong to it. */
const chDir = `mkdir -p ${CH_BACKUPS_DIR}; chown clickhouse:clickhouse ${CH_BACKUPS_DIR} 2>/dev/null || true; `;

/** The staged archive path is set BEFORE the trap names it. */
function chBody(zip: string | null, tail: string): string {
  const head = String.raw`umask 077; d=/dev/shm; [ -w "$d" ] || d=/tmp; f=$(mktemp "$d/tugra-dbcfg.XXXXXX") || exit 1; `;
  const z = zip ? `z=${zip}; ` : "";
  const trap = zip ? String.raw`trap "rm -f \"$f\" \"$z\"" EXIT; ` : String.raw`trap "rm -f \"$f\"" EXIT; `;
  return head + z + trap + String.raw`trap "exit 1" HUP INT TERM; ` + chClient + chWait + tail;
}
const CH_DUMP_ZIP = `${CH_BACKUPS_DIR}/tugra_backup.zip`;
const CH_RESTORE_ZIP = `${CH_BACKUPS_DIR}/tugra_restore.zip`;

/** `$1` user, `$2` database. `BACKUP DATABASE` to a file the server writes, streamed out on stdout and removed on every exit. */
export const CH_DUMP_BODY = chBody(CH_DUMP_ZIP, chDir + String.raw`rm -f "$z"; c --query "BACKUP DATABASE \"$2\" TO File(${Q}$z${Q})" >/dev/null && cat "$z"; rc=$?; exit $rc`);

/**
 * `$1` user, `$2` the destination database, the backup on stdin. The backup is a file for the server (`RESTORE` cannot read a pipe),
 * so it lands in the backups directory first. The database the backup holds is read from its own entry names (`metadata/<db>.sql`),
 * so the destination may be named differently from the source. Stage-then-swap: restored under a temporary name, then the real
 * database is dropped and the temporary one renamed: a corrupt archive never destroys the live database.
 */
export const CH_RESTORE_BODY = chBody(
  CH_RESTORE_ZIP,
  chDir +
    String.raw`rm -f "$z"; cat > "$z" || exit 1; s=$(LC_ALL=C grep -a -o -m1 "metadata/[A-Za-z0-9_]*\\.sql" "$z" | head -n1 | sed -e "s#^metadata/##" -e "s#\\.sql\$##"); [ -n "$s" ] || { echo "tugra: not a clickhouse backup" >&2; exit 1; }; t="$2__tugra_restore_tmp"; c --query "DROP DATABASE IF EXISTS \"$t\" SYNC" 2>/dev/null; c --query "RESTORE DATABASE \"$s\" AS \"$t\" FROM File(${Q}$z${Q})" >/dev/null && c --query "DROP DATABASE IF EXISTS \"$2\" SYNC" && c --query "RENAME DATABASE \"$t\" TO \"$2\""; rc=$?; exit $rc`,
);

/**
 * `$1` user, `$2` database, `$3` mode, `$4` threshold. One line per table (views and dictionaries are not data):
 * `<table><TAB><rows><TAB><estimated 0|1>`. A name that is not a plain identifier is reported uncounted (-1), never interpolated.
 */
export const CH_STATS_BODY = chBody(
  null,
  String.raw`L=$(c --query "SELECT name, total_rows FROM system.tables WHERE database = ${Q}$2${Q} AND NOT is_temporary AND engine NOT LIKE ${Q}%View${Q} AND engine != ${Q}Dictionary${Q} ORDER BY name" --format TSV) || exit 1; [ -n "$L" ] || exit 0; T=$(printf "\t"); printf "%s\n" "$L" | while IFS="$T" read -r t est; do case "$t" in ""|*[!A-Za-z0-9_]*) printf "%s\t-1\t0\n" "$t"; continue;; esac; case "$est" in ""|*[!0-9]*) est=0;; esac; if [ "$3" = estimate ] && [ "$est" -ge "$4" ]; then printf "%s\t%s\t1\n" "$t" "$est"; continue; fi; n=$(c --query "SELECT count() FROM \"$2\".\"$t\"") || { printf "%s\t-1\t0\n" "$t"; continue; }; printf "%s\t%s\t0\n" "$t" "$n"; done`,
);

/** `$1` user, `$2` database. The database's active data parts in bytes (one integer). */
export const CH_SIZE_BODY = chBody(null, String.raw`c --query "SELECT toString(sum(bytes_on_disk)) FROM system.parts WHERE database = ${Q}$2${Q} AND active"`);

/** Every constant of this module, by the key the shared fixture carries. */
export const SAFE_DB_SCRIPTS = {
  mongoDump: MONGO_DUMP_BODY,
  mongoRestore: MONGO_RESTORE_BODY,
  mongoShell: MONGO_SHELL_BODY,
  mongoStatsJs: MONGO_STATS_JS,
  mongoSizeJs: MONGO_SIZE_JS,
  chDump: CH_DUMP_BODY,
  chRestore: CH_RESTORE_BODY,
  chStats: CH_STATS_BODY,
  chSize: CH_SIZE_BODY,
} as const;

/** ClickHouse restore: a database name that sits inside a `.zip` entry name unescaped (letters, digits, underscore). */
export const CH_PLAIN_DB_RE = /^[A-Za-z0-9_]{1,63}$/;

// ───────────────────────────── host-side builders ─────────────────────────────

const shq = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`;
const CTR_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** The same word a user may be (the migrator validates the source's with the identical expression). */
export const DB_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@+-]{0,79}$/;

function assertCommon(container: string, user: string, password: string): void {
  if (!CTR_RE.test(container)) throw new Error("invalid container");
  if (!DB_USER_RE.test(user)) throw new Error("invalid database user");
  assertPasswordForConfigFile(password);
}

/** The password reaches `docker exec` through the CALLER's environment (`NAME=value docker exec -e NAME`): not on the docker client's argv. */
const withPw = (password: string): string => `${DB_PW_ENV}=${shq(password)}`;

/** `ping` as the admin user: the readiness probe of a freshly provisioned MongoDB, with the password off every argv. */
export const MONGO_PING_JS = MONGO_AUTH_JS + String.raw`a.runCommand({ping:1})`;

/** The restore of a (foreign) MongoDB archive: a readiness wait (the root user is created seconds after the container runs), then the archive piped in. */
export function mongoImportRestoreLines(container: string, user: string, password: string, decoded: string): string[] {
  assertCommon(container, user, password);
  const ready =
    `i=0; until ${withPw(password)} docker exec -e ${DB_PW_ENV} ${container} sh -c ${shq(MONGO_SHELL_BODY)} tugra-ready ${shq(user)} exact 1 ${shq(MONGO_PING_JS)} >/dev/null 2>&1; ` +
    `do i=$((i+1)); [ $i -ge 60 ] && { echo "tugra: mongo not ready" >&2; exit 1; }; sleep 1; done`;
  return [ready, `${decoded} | ${withPw(password)} docker exec -i -e ${DB_PW_ENV} ${container} sh -c ${shq(MONGO_RESTORE_BODY)} tugra-mongo ${shq(user)}`];
}

/** The restore of a ClickHouse backup archive (stage-then-swap): the in-container body waits for the server itself. */
export function clickhouseImportRestoreLines(container: string, user: string, password: string, database: string, decoded: string): string[] {
  assertCommon(container, user, password);
  if (!CH_PLAIN_DB_RE.test(database)) throw new Error("the ClickHouse database name must be letters, digits and underscores");
  return [`${decoded} | ${withPw(password)} docker exec -i -e ${DB_PW_ENV} ${container} sh -c ${shq(CH_RESTORE_BODY)} tugra-clickhouse ${shq(user)} ${shq(database)}`];
}

/** The statistics command of one TARGET database (Mongo: all user databases of the instance; ClickHouse: its database). */
export function safeStatsCommand(engine: "MONGO" | "CLICKHOUSE", container: string, user: string, password: string, database: string, mode: "exact" | "estimate", below: number): string {
  assertCommon(container, user, password);
  if (!Number.isInteger(below) || below < 1 || below > 1_000_000_000_000) throw new Error("invalid threshold");
  if (engine === "MONGO") return `${withPw(password)} docker exec -e ${DB_PW_ENV} ${container} sh -c ${shq(MONGO_SHELL_BODY)} tugra-verify ${shq(user)} ${mode} ${below} ${shq(MONGO_STATS_JS)}`;
  if (!CH_PLAIN_DB_RE.test(database)) throw new Error("invalid database identifier");
  return `${withPw(password)} docker exec -e ${DB_PW_ENV} ${container} sh -c ${shq(CH_STATS_BODY)} tugra-verify ${shq(user)} ${shq(database)} ${mode} ${below}`;
}
