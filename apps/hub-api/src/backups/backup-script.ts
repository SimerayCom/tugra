/**
 * Pure builders for the shell scripts the agent runs to dump / restore a managed
 * database to/from a backup destination (the server's own disk, or an S3 bucket).
 *
 * Every engine dumps to stdout, then a uniform pipeline applies: gzip → optional
 * gpg (AES-256 symmetric) → sink (a local file, or `mc pipe` to S3). The dump is
 * never returned through the agent exec channel (which caps output at 64KB) — it
 * streams straight to the destination; only a small size line comes back.
 */

import {
  dbContainerName,
  type DbCredentials,
  type DbEngine,
  type DbSpec,
} from "../databases/database-script";
import {
  mcHostEnv,
  mcTarget,
  MC_ALIAS,
  MC_INSTALL,
  type DestinationSpec,
  type S3Config,
} from "./destination";

export const BACKUP_DIR = "/etc/tugra/backups";

const EXT: Record<DbEngine, string> = {
  POSTGRES: "dump", // pg_dump custom format (-Fc) → restore via pg_restore --clean
  MYSQL: "sql",
  MARIADB: "sql",
  REDIS: "rdb",
  KEYDB: "rdb",
  MONGO: "archive",
  DRAGONFLY: "rdb", // Dragonfly SAVE RDB → single-file RDB snapshot
  CLICKHOUSE: "zip", // ClickHouse BACKUP … TO File('.zip') → single archive
  LIBSQL: "db", // unused — libSQL has no dump/restore pipeline (supportsBackup=false)
};

export function backupDir(dbId: string): string {
  return `${BACKUP_DIR}/${dbId}`;
}

export function backupPath(dbId: string, filename: string): string {
  return `${backupDir(dbId)}/${filename}`;
}

/** Final filename including the pipeline suffixes (.gz always, .gpg if encrypted). */
export function backupFilename(engine: DbEngine, ts: string, dest: DestinationSpec): string {
  let f = `${ts}.${EXT[engine]}.gz`;
  if (dest.encryption.enabled) f += ".gpg";
  return f;
}

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Engine-specific command that writes the raw dump of `name` (a DB container) to stdout. Exported +
 *  parameterized on (engine, container, creds) so BOTH Tugra's own backups and the importer's SSH data-plane
 *  share one source of truth — a dump therefore always matches what Tugra restores. */
export function dumpDbToStdout(engine: DbEngine, name: string, creds: DbCredentials): string {
  const { username, password, database } = creds;
  switch (engine) {
    case "POSTGRES":
      // -Fc custom format (enables pg_restore --clean/--if-exists on restore);
      // -Z0 leave compression to the shared `| gzip` stage; --no-owner/--no-acl
      // for portable restore into a differently-owned database.
      return `docker exec -e PGPASSWORD=${shq(password)} ${name} pg_dump -Fc -Z0 --no-owner --no-acl -U ${shq(username)} ${shq(database)}`;
    case "MYSQL":
      // --single-transaction: consistent InnoDB snapshot without locking tables;
      // --quick: stream rows (don't buffer whole tables in RAM); --no-tablespaces:
      // avoid needing PROCESS privilege. --protocol=TCP -h127.0.0.1: force a TCP
      // connection — the default is a unix socket whose path differs across images
      // (e.g. /run/mysqld vs /var/run/mysqld) and is often absent inside the
      // container, which made the client connect to the wrong/missing socket and
      // the dump fail with an empty/garbage result.
      return `docker exec -e MYSQL_PWD=${shq(password)} ${name} mysqldump --single-transaction --quick --no-tablespaces -u${shq(username)} --protocol=TCP -h127.0.0.1 ${shq(database)}`;
    case "MARIADB":
      return `docker exec -e MYSQL_PWD=${shq(password)} ${name} mariadb-dump --single-transaction --quick -u${shq(username)} --protocol=TCP -h127.0.0.1 ${shq(database)}`;
    case "MONGO":
      return `docker exec ${name} mongodump --username ${shq(username)} --password ${shq(password)} --authenticationDatabase admin --archive`;
    case "REDIS":
    case "KEYDB": {
      // redis-cli/keydb-cli exit 0 even on NOAUTH / WRONGPASS, so the old `SAVE >/dev/null 2>&1 && cat`
      // chain silently `cat`s a STALE /data/dump.rdb when the password is wrong — staging a bogus dump that
      // looks successful. Capture SAVE's reply and read the file ONLY when it is exactly "OK" (the Dragonfly
      // pattern). Password via the REDISCLI_AUTH env so it never lands on the cli's argv (visible in host `ps`).
      const cli = engine === "KEYDB" ? "keydb-cli" : "redis-cli";
      return `docker exec -e ${shq(`REDISCLI_AUTH=${password}`)} ${name} sh -c ${shq(
        `r=$(${cli} --no-auth-warning SAVE 2>&1); if [ "$r" = OK ]; then cat /data/dump.rdb; else echo "${engine} SAVE failed: $r" >&2; exit 1; fi`,
      )}`;
    }
    case "DRAGONFLY":
      // Redis-wire compatible. `SAVE RDB <base>` forces a SINGLE-file RDB snapshot (default is the
      // multi-file DFS format). We do NOT use redis-cli's `-e` here: the version bundled in the Dragonfly
      // image exits 0 even on a command error with `-e`, so it can't be trusted to signal a failed SAVE.
      // Instead capture the reply and require it to be exactly "OK" — only then is the snapshot read. Password
      // via REDISCLI_AUTH env so it never hits redis-cli's argv. rc-preserving: cleanup rm never masks the exit.
      return `docker exec -e ${shq(`REDISCLI_AUTH=${password}`)} ${name} sh -c ${shq(
        'rm -f /data/tugra_backup.rdb; r=$(redis-cli --no-auth-warning SAVE RDB tugra_backup 2>&1); if [ "$r" = OK ]; then cat /data/tugra_backup.rdb; rc=0; else echo "dragonfly SAVE failed: $r" >&2; rc=1; fi; rm -f /data/tugra_backup.rdb; exit $rc',
      )}`;
    case "CLICKHOUSE": {
      // `BACKUP … TO File('.zip')` (File backend). Written under /var/lib/clickhouse/backups — the default
      // `backups.allowed_path` (File() paths are allow-list-gated). Identifier is DOUBLE-QUOTE quoted (\"…\"),
      // NOT backtick — backticks inside the double-quoted --query would trigger shell command substitution in
      // the container's `sh -c`. We pass explicit --host/--port/--user/--password (the user/password come from
      // the container's own CLICKHOUSE_USER/CLICKHOUSE_PASSWORD env — never on our argv): the default client
      // connects as `default` with no password, which has no grant on the managed DB, so the dump failed.
      // CH_WAIT polls `SELECT 1` because clickhouse-server accepts connections only seconds after the container
      // reports running — an un-waited BACKUP raced the server startup and errored "Connection refused".
      // chown: `docker exec` runs as root, so a root-created backups dir is unwritable by the clickhouse
      // user (uid 101) the server runs as → BACKUP failed "Cannot open …zip.lock: Permission denied". Hand
      // the dir to clickhouse (idempotent — also heals a dir left root-owned by an earlier broken run).
      const chCli = `clickhouse-client --host 127.0.0.1 --port 9000 --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"`;
      const chWait = `i=0; until ${chCli} --query "SELECT 1" >/dev/null 2>&1; do i=$((i+1)); [ $i -ge 30 ] && { echo "tugra: clickhouse not ready" >&2; exit 1; }; sleep 2; done;`;
      const chDir = "mkdir -p /var/lib/clickhouse/backups; chown clickhouse:clickhouse /var/lib/clickhouse/backups 2>/dev/null || true;";
      return `docker exec ${name} sh -c ${shq(
        `${chWait} ${chDir} ${chCli} --query "BACKUP DATABASE \\"${database}\\" TO File('/var/lib/clickhouse/backups/tugra_backup.zip')" >/dev/null && cat /var/lib/clickhouse/backups/tugra_backup.zip; rc=$?; rm -f /var/lib/clickhouse/backups/tugra_backup.zip; exit $rc`,
      )}`;
    }
    case "LIBSQL":
      throw new Error("backup not supported for libsql"); // unreachable — gated by supportsBackup()
  }
}

/** A managed Tugra database's dump command — the DbSpec-shaped wrapper over {@link dumpDbToStdout}. */
function dumpToStdout(db: DbSpec): string {
  return dumpDbToStdout(db.engine, dbContainerName(db), db.credentials);
}

/**
 * A command that BLOCKS until the engine actually accepts connections, or null if the engine needs none
 * (or embeds its own wait). A container reports "running" seconds before the server is ready to serve — a
 * backup fired right after provision, or a restore into a just-created container (clone / migration), would
 * otherwise race the startup and fail. Run as its own line before the dump/restore so a never-ready server
 * fails loud. MySQL/MariaDB: poll `SELECT 1` on the target DB over TCP (also waits for the DB to be created
 * by first-boot init). ClickHouse embeds its own SELECT 1 wait inside the dump/restore command, so it
 * returns null here.
 */
export function readinessPrelude(engine: DbEngine, name: string, creds: DbCredentials): string | null {
  const { username, password, database } = creds;
  switch (engine) {
    case "MYSQL":
    case "MARIADB": {
      const client = engine === "MARIADB" ? "mariadb" : "mysql";
      const u = shqInner(username);
      const db = shqInner(database);
      const wait =
        `i=0; until ${client} -u${u} --protocol=TCP -h127.0.0.1 -e "SELECT 1" ${db} >/dev/null 2>&1; ` +
        `do i=$((i+1)); [ $i -ge 60 ] && { echo "tugra: ${client} not ready" >&2; exit 1; }; sleep 1; done`;
      return `docker exec -e MYSQL_PWD=${shq(password)} ${name} sh -c ${shq(wait)}`;
    }
    default:
      return null;
  }
}

// Quote a value that is embedded inside an already single-quoted `sh -c` string.
function shqInner(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

function gpgEncrypt(dest: DestinationSpec): string {
  return `gpg --batch --yes --passphrase ${shq(dest.encryption.key)} --symmetric --cipher-algo AES256`;
}

function gpgDecrypt(dest: DestinationSpec): string {
  return `gpg --batch --yes --passphrase ${shq(dest.encryption.key)} --decrypt`;
}

export function buildBackupScript(db: DbSpec, filename: string, dest: DestinationSpec): string {
  const lines = ["set -e", "set -o pipefail"];
  const prelude = readinessPrelude(db.engine, dbContainerName(db), db.credentials);
  if (prelude) lines.push(prelude);
  const pipe = [dumpToStdout(db), "gzip"];
  if (dest.encryption.enabled) pipe.push(gpgEncrypt(dest));

  if (dest.type === "S3" && dest.s3) {
    lines.push(MC_INSTALL);
    const target = mcTarget(dest.s3, db.id, filename);
    // bash -o pipefail (NOT plain `sh -c`): the inner shell must fail the whole command when the DUMP
    // stage fails — otherwise `mc pipe` still exits 0 after uploading a truncated/empty object and the
    // backup is recorded SUCCESS (silent data loss). The outer script's pipefail does not reach this subshell.
    lines.push(`${mcHostEnv(dest.s3)} bash -o pipefail -c ${shq(`${pipe.join(" | ")} | mc pipe ${target}`)}`);
    // size of the uploaded object
    lines.push(`${mcHostEnv(dest.s3)} mc stat --json ${target}`);
  } else {
    const dir = backupDir(db.id);
    const file = backupPath(db.id, filename);
    lines.push(`mkdir -p ${dir}`);
    lines.push(`${pipe.join(" | ")} > ${file}`);
    lines.push(`stat -c %s ${file}`);
  }
  return lines.join("\n");
}

export function buildRestoreScript(
  db: DbSpec,
  filename: string,
  dest: DestinationSpec,
  // The id the backup is STORED under (S3 object prefix / local path). Defaults to the target db's id for a
  // same-database restore, but for a cross-database restore ("restore-to" / clone) the backup lives under the
  // SOURCE db's id while `db` is the TARGET we load into — so the two differ and the caller passes the source.
  storageDbId: string = db.id,
): string {
  // source → [gpg -d] → gunzip → engine restore. Source is a stored backup
  // (S3 object or local file); the pipeline + engine handling is shared.
  const source =
    dest.type === "S3" && dest.s3
      ? `${mcHostEnv(dest.s3)} mc cat ${mcTarget(dest.s3, storageDbId, filename)}`
      : `cat ${backupPath(storageDbId, filename)}`;
  // Postgres backups written before the custom-format switch are plain SQL
  // (`.sql.gz`); newer ones are `.dump.gz`. Both are OUR dumps of a single DB,
  // so the plain path can safely run atomically (--single-transaction).
  const pgMode: PgMode = filename.includes(".dump") ? "custom" : "sql-atomic";
  return restorePipeline(db, source, dest, true, pgMode);
}

/**
 * Import an external dump straight from a URL into the DB (migrate-in). Reuses
 * the same decode + engine-restore pipeline; only the source differs (`curl`).
 */
export function buildImportScript(
  db: DbSpec,
  url: string,
  opts: { encrypted: boolean; key: string; gzip: boolean; pgFormat?: "custom" | "sql" },
): string {
  const dest: DestinationSpec = { type: "LOCAL", encryption: { enabled: opts.encrypted, key: opts.key } };
  // (Postgres only.) `pgFormat` is an EXPLICIT override for a foreign dump whose extension lies — e.g.
  // Coolify names its custom-format Postgres dumps `.dmp`, which the extension sniff below would misread as
  // plain SQL and feed to psql, failing on the binary archive. When `pgFormat` is unset we fall back to the
  // sniff: a `.dump[.gz][.gpg]` object is a CUSTOM-format archive → pg_restore (so a URL exported from
  // another Tugra backup imports cleanly); anything else is plain SQL fed to psql (sql-loose: fail-loud but
  // not forced-atomic, since an external dump's transaction structure is unknown). Match the URL PATH only
  // (end-anchored) — a `.dump`-like tail in a query param must NOT flip the mode. Unparseable URL → sql-loose.
  let pgMode: PgMode;
  if (opts.pgFormat === "custom") {
    pgMode = "custom";
  } else if (opts.pgFormat === "sql") {
    pgMode = "sql-loose";
  } else {
    pgMode = "sql-loose";
    try {
      if (/\.dump(\.gz)?(\.gpg)?$/i.test(new URL(url).pathname)) pgMode = "custom";
    } catch {
      /* not a parseable URL — leave sql-loose (psql fail-loud) */
    }
  }
  return restorePipeline(db, `curl -fsSL ${shq(url)}`, dest, opts.gzip, pgMode, { importMode: true });
}

// custom = pg_restore of a custom-format archive; sql-atomic = our own plain
// dump (safe to wrap in one transaction); sql-loose = external SQL of unknown
// transaction structure (fail-loud, but not forced-atomic).
type PgMode = "custom" | "sql-atomic" | "sql-loose";

/** Shared: pipe an arbitrary source command through optional gpg/gunzip into the engine's restore client.
 *  `importMode` loads a FOREIGN dump (migrate-in / URL import) rather than one of Tugra's own backups, so it
 *  hardens two engines against another installation's artifacts — see the per-engine notes below. It defaults
 *  to false so Tugra's own backup/clone restores stay byte-identical. */
function restorePipeline(db: DbSpec, sourceCmd: string, dest: DestinationSpec, gzip: boolean, pgMode: PgMode = "sql-atomic", opts: { importMode?: boolean } = {}): string {
  const name = dbContainerName(db);
  const { username, password, database } = db.credentials;

  const decode = [sourceCmd];
  if (dest.encryption.enabled) decode.push(gpgDecrypt(dest));
  if (gzip) decode.push("gunzip");

  const lines = ["set -e", "set -o pipefail"];
  switch (db.engine) {
    case "POSTGRES": {
      const pg =
        pgMode === "custom"
          ? // custom-format archive → pg_restore. --clean --if-exists makes it
            // idempotent on a populated DB; --single-transaction wraps the whole
            // restore in ONE transaction (implies --exit-on-error) so a mid-way
            // failure rolls back — no half-dropped, data-losing database.
            `pg_restore --no-owner --clean --if-exists --single-transaction -U ${shq(username)} -d ${shq(database)}`
          : pgMode === "sql-atomic"
            ? // our own plain-SQL dump → psql, fail-loud + all-or-nothing.
              `psql -v ON_ERROR_STOP=1 --single-transaction -U ${shq(username)} -d ${shq(database)}`
            : // external SQL (import) → fail-loud only; its own transaction
              // structure may forbid a single wrapping transaction.
              `psql -v ON_ERROR_STOP=1 -U ${shq(username)} -d ${shq(database)}`;
      lines.push(`${decode.join(" | ")} | docker exec -i -e PGPASSWORD=${shq(password)} ${name} ${pg}`);
      break;
    }
    case "MYSQL":
    case "MARIADB": {
      // Wait for the server to accept connections before piping the dump in (a restore into a freshly
      // created container — clone / migration — otherwise races startup). --protocol=TCP -h127.0.0.1:
      // force TCP — the default unix-socket path differs across images and is usually absent inside the
      // container, which broke the restore client's connect.
      const prelude = readinessPrelude(db.engine, name, db.credentials);
      if (prelude) lines.push(prelude);
      const client = db.engine === "MARIADB" ? "mariadb" : "mysql";
      // Importing a foreign dump: load as root (the target's ROOT password == creds.password, set at provision
      // via credentialEnv) so DEFINER/SQL-SECURITY and privilege gaps in another installation's views, triggers
      // and routines don't abort the restore. Tugra's own restores stay as the app user (byte-identical).
      const restoreUser = opts.importMode ? "root" : username;
      lines.push(`${decode.join(" | ")} | docker exec -i -e MYSQL_PWD=${shq(password)} ${name} ${client} -u${shq(restoreUser)} --protocol=TCP -h127.0.0.1 ${shq(database)}`);
      break;
    }
    case "MONGO": {
      // Importing a foreign dump: a full-instance `mongodump --archive` carries admin.system.users /
      // admin.system.version. Under `--drop` those would overwrite the target's own Tugra root user and lock
      // out the stored credentials, so exclude the admin namespaces on import. Tugra's own clone keeps them.
      const nsExclude = opts.importMode ? " --nsExclude 'admin.*'" : "";
      lines.push(`${decode.join(" | ")} | docker exec -i ${name} mongorestore --username ${shq(username)} --password ${shq(password)} --authenticationDatabase admin --archive --drop${nsExclude}`);
      break;
    }
    case "REDIS":
    case "KEYDB": {
      // A graceful `docker restart` sends SIGTERM, which makes redis/keydb SAVE its CURRENT (just-wiped)
      // dataset to /data/dump.rdb on shutdown — clobbering the file we copied in, so the restore silently
      // produced an empty DB. Fix: validate the RDB signature, then `docker kill` (SIGKILL → no shutdown
      // save) while the container is stopped, copy the dump in, `docker start` (boots and loads dump.rdb),
      // and wait for PONG so a failed boot surfaces instead of looking like success.
      const cli = db.engine === "KEYDB" ? "keydb-cli" : "redis-cli";
      const tmp = `/tmp/${name}.rdb`;
      lines.push(`trap 'rm -f ${tmp}' EXIT`);
      lines.push(`${decode.join(" | ")} > ${tmp}`);
      lines.push(`head -c5 ${tmp} | grep -q REDIS`);
      lines.push(`docker kill ${name} >/dev/null 2>&1 || true`);
      lines.push(`docker cp ${tmp} ${name}:/data/dump.rdb`);
      lines.push(`docker start ${name}`);
      lines.push(
        `ok=0; for i in $(seq 1 60); do if docker exec ${name} sh -c ${shq(`${cli} -a ${shqInner(password)} --no-auth-warning PING 2>&1`)} | grep -q PONG; then ok=1; break; fi; sleep 1; done; [ "$ok" = 1 ] || { echo "${db.engine} did not become ready after restore" >&2; exit 1; }`,
      );
      break;
    }
    case "DRAGONFLY": {
      // DFLY LOAD does FlushAll-then-load, so VALIDATE the RDB signature FIRST — an obviously corrupt/wrong
      // file must not wipe the live dataset before we even try to load it. We do NOT rely on redis-cli's `-e`
      // (the Dragonfly-bundled build can exit 0 even on error); instead capture the DFLY LOAD reply and
      // require it to be exactly "OK", so a failed load surfaces as a non-zero exit rather than silent success.
      const inner =
        "cat > /data/tugra_restore.rdb && head -c5 /data/tugra_restore.rdb | grep -q REDIS || " +
        '{ rm -f /data/tugra_restore.rdb; echo "tugra: bad rdb signature" >&2; exit 1; }; ' +
        "r=$(redis-cli --no-auth-warning DFLY LOAD /data/tugra_restore.rdb 2>&1); rm -f /data/tugra_restore.rdb; " +
        '[ "$r" = OK ] || { echo "dragonfly DFLY LOAD failed: $r" >&2; exit 1; }';
      lines.push(`${decode.join(" | ")} | docker exec -i -e ${shq(`REDISCLI_AUTH=${password}`)} ${name} sh -c ${shq(inner)}`);
      break;
    }
    case "CLICKHOUSE": {
      // Restore to a TEMP database, then DROP the real one and RENAME temp→real — so a corrupt/rejected backup
      // never destroys the live DB before the restore is known good (stage-then-swap). A prior-run temp is
      // cleared up front; on failure the data survives in EITHER the real DB or the temp (never both dropped).
      // Identifiers are DOUBLE-QUOTE quoted (\"…\") — backticks in the double-quoted --query would trigger shell
      // command substitution. Explicit --host/--port/--user/--password (user/password from the container's own
      // CLICKHOUSE_USER/CLICKHOUSE_PASSWORD env) + a SELECT 1 readiness wait — same reasons as the dump path.
      const tmpDb = `${database}__tugra_restore_tmp`;
      const zip = "/var/lib/clickhouse/backups/tugra_restore.zip";
      const chCli = `clickhouse-client --host 127.0.0.1 --port 9000 --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"`;
      const chWait = `i=0; until ${chCli} --query "SELECT 1" >/dev/null 2>&1; do i=$((i+1)); [ $i -ge 30 ] && { echo "tugra: clickhouse not ready" >&2; exit 1; }; sleep 2; done;`;
      // chown the backups dir to the clickhouse user (docker exec is root; the server runs as uid 101 and
      // must create its .lock / read the staged zip) — see the dump path.
      const chDir = "mkdir -p /var/lib/clickhouse/backups; chown clickhouse:clickhouse /var/lib/clickhouse/backups 2>/dev/null || true;";
      const inner =
        `${chWait} ${chDir} ` +
        `${chCli} --query "DROP DATABASE IF EXISTS \\"${tmpDb}\\" SYNC" 2>/dev/null; ` +
        `cat > ${zip} && ` +
        `${chCli} --query "RESTORE DATABASE \\"${database}\\" AS \\"${tmpDb}\\" FROM File('${zip}')" >/dev/null && ` +
        `${chCli} --query "DROP DATABASE IF EXISTS \\"${database}\\" SYNC" && ` +
        `${chCli} --query "RENAME DATABASE \\"${tmpDb}\\" TO \\"${database}\\""; ` +
        `rc=$?; rm -f ${zip}; exit $rc`;
      lines.push(`${decode.join(" | ")} | docker exec -i ${name} sh -c ${shq(inner)}`);
      break;
    }
    case "LIBSQL":
      throw new Error("restore not supported for libsql"); // unreachable — gated by supportsBackup()
  }
  return lines.join("\n");
}

export function buildDeleteBackupScript(
  dbId: string,
  filename: string,
  dest: DestinationSpec,
): string {
  if (dest.type === "S3" && dest.s3) {
    return `${mcHostEnv(dest.s3)} mc rm ${mcTarget(dest.s3, dbId, filename)} 2>/dev/null || true`;
  }
  return `rm -f ${backupPath(dbId, filename)} 2>/dev/null || true`;
}

/**
 * Presigned download URL for an existing S3 database backup, so it can be pulled by import-from-URL
 * on another server (migration). `expire` is an mc duration string like "24h". S3-only — a LOCAL
 * backup has no presignable object (the caller guards `dest.type === "S3"` first).
 */
export function buildBackupExportUrlScript(dbId: string, filename: string, dest: DestinationSpec, expire: string): string {
  if (dest.type !== "S3" || !dest.s3) throw new Error("export URL requires an S3 destination");
  const target = mcTarget(dest.s3, dbId, filename);
  return [MC_INSTALL, `${mcHostEnv(dest.s3)} mc share download --expire ${shq(expire)} --json ${shq(target)}`].join("\n");
}

/** Reachability/credentials check for an S3 destination: `mc ls <alias>/<bucket>`. Exit 0 = OK. */
export function buildDestinationTestScript(s3: S3Config): string {
  return [MC_INSTALL, `${mcHostEnv(s3)} mc ls ${MC_ALIAS}/${s3.bucket}`].join("\n");
}

/**
 * Redact customer row data from a restore command's error output before we
 * persist it. pg_restore/psql/mysql echo the offending VALUES in their errors
 * (Postgres `DETAIL: Failing row contains (...)`, `Key (col)=(value)`,
 * `STATEMENT: INSERT ...`; MySQL `Duplicate entry '...'`). We keep the last 2KB
 * and the diagnostic scaffolding (error class, constraint/relation names) but
 * strip the value-bearing fragments so tenant data never lands in the hub DB.
 */
export function scrubRestoreOutput(output: string): string {
  const redactLine = /^(\s*)(DETAIL|CONTEXT|HINT|STATEMENT|QUERY|LINE \d+)\s*:.*/i;
  return output
    .slice(-2000)
    .split("\n")
    .map((line) => {
      if (redactLine.test(line)) return line.replace(redactLine, "$1$2: <redacted>");
      return line
        .replace(/Key \(([^)]*)\)=\([^)]*\)/g, "Key ($1)=(<redacted>)")
        .replace(/Failing row contains \([^)]*\)/g, "Failing row contains (<redacted>)")
        .replace(/Duplicate entry '[^']*'/g, "Duplicate entry '<redacted>'");
    })
    .join("\n");
}
