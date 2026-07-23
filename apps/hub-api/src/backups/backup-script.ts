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
  type DbEngine,
  type DbSpec,
} from "../databases/database-script";
import {
  mcHostEnv,
  mcTarget,
  MC_ALIAS,
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

const MC_INSTALL =
  "command -v mc >/dev/null 2>&1 || { curl -sSL https://dl.min.io/client/mc/release/linux-amd64/mc -o /usr/local/bin/mc && chmod +x /usr/local/bin/mc; }";

/** Engine-specific command that writes the raw dump to stdout. */
function dumpToStdout(db: DbSpec): string {
  const name = dbContainerName(db);
  const { username, password, database } = db.credentials;
  switch (db.engine) {
    case "POSTGRES":
      // -Fc custom format (enables pg_restore --clean/--if-exists on restore);
      // -Z0 leave compression to the shared `| gzip` stage; --no-owner/--no-acl
      // for portable restore into a differently-owned database.
      return `docker exec -e PGPASSWORD=${shq(password)} ${name} pg_dump -Fc -Z0 --no-owner --no-acl -U ${shq(username)} ${shq(database)}`;
    case "MYSQL":
      // --single-transaction: consistent InnoDB snapshot without locking tables;
      // --quick: stream rows (don't buffer whole tables in RAM); --no-tablespaces:
      // avoid needing PROCESS privilege.
      return `docker exec -e MYSQL_PWD=${shq(password)} ${name} mysqldump --single-transaction --quick --no-tablespaces -u${shq(username)} ${shq(database)}`;
    case "MARIADB":
      return `docker exec -e MYSQL_PWD=${shq(password)} ${name} mariadb-dump --single-transaction --quick -u${shq(username)} ${shq(database)}`;
    case "MONGO":
      return `docker exec ${name} mongodump --username ${shq(username)} --password ${shq(password)} --authenticationDatabase admin --archive`;
    case "REDIS":
      return `docker exec ${name} sh -c ${shq(`redis-cli -a ${shqInner(password)} --no-auth-warning SAVE >/dev/null 2>&1 && cat /data/dump.rdb`)}`;
    case "KEYDB":
      return `docker exec ${name} sh -c ${shq(`keydb-cli -a ${shqInner(password)} --no-auth-warning SAVE >/dev/null 2>&1 && cat /data/dump.rdb`)}`;
    case "DRAGONFLY":
      // Redis-wire compatible. `SAVE RDB <base>` forces a SINGLE-file RDB snapshot (default is the
      // multi-file DFS format). `-e` makes redis-cli exit non-zero on a command-level -ERR (by default it
      // exits 0 and only PRINTS the error → a failed SAVE would be masked as success). Password via
      // REDISCLI_AUTH env so it never hits redis-cli's argv. rc-preserving: cleanup rm never masks the exit.
      return `docker exec -e ${shq(`REDISCLI_AUTH=${password}`)} ${name} sh -c ${shq(
        "rm -f /data/tugra_backup.rdb; redis-cli -e --no-auth-warning SAVE RDB tugra_backup >/dev/null && cat /data/tugra_backup.rdb; rc=$?; rm -f /data/tugra_backup.rdb; exit $rc",
      )}`;
    case "CLICKHOUSE":
      // `BACKUP … TO File('.zip')` (File backend). Written under /var/lib/clickhouse/backups — the default
      // `backups.allowed_path` (File() paths are allow-list-gated). Identifier is DOUBLE-QUOTE quoted (\"…\"),
      // NOT backtick — backticks inside the double-quoted --query would trigger shell command substitution in
      // the container's `sh -c`. clickhouse-client reads auth from the container env (no password on argv).
      return `docker exec ${name} sh -c ${shq(
        `mkdir -p /var/lib/clickhouse/backups; clickhouse-client --query "BACKUP DATABASE \\"${database}\\" TO File('/var/lib/clickhouse/backups/tugra_backup.zip')" >/dev/null && cat /var/lib/clickhouse/backups/tugra_backup.zip; rc=$?; rm -f /var/lib/clickhouse/backups/tugra_backup.zip; exit $rc`,
      )}`;
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
  const pipe = [dumpToStdout(db), "gzip"];
  if (dest.encryption.enabled) pipe.push(gpgEncrypt(dest));

  if (dest.type === "S3" && dest.s3) {
    lines.push(MC_INSTALL);
    const target = mcTarget(dest.s3, db.id, filename);
    lines.push(`${mcHostEnv(dest.s3)} sh -c ${shq(`${pipe.join(" | ")} | mc pipe ${target}`)}`);
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

export function buildRestoreScript(db: DbSpec, filename: string, dest: DestinationSpec): string {
  // source → [gpg -d] → gunzip → engine restore. Source is a stored backup
  // (S3 object or local file); the pipeline + engine handling is shared.
  const source =
    dest.type === "S3" && dest.s3
      ? `${mcHostEnv(dest.s3)} mc cat ${mcTarget(dest.s3, db.id, filename)}`
      : `cat ${backupPath(db.id, filename)}`;
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
  opts: { encrypted: boolean; key: string; gzip: boolean },
): string {
  const dest: DestinationSpec = { type: "LOCAL", encryption: { enabled: opts.encrypted, key: opts.key } };
  // An external dump's format AND transaction structure are unknown — it may
  // carry its own BEGIN/COMMIT or a CREATE DATABASE that can't run inside one
  // transaction. Fail loud (ON_ERROR_STOP) but don't force whole-file atomicity.
  return restorePipeline(db, `curl -fsSL ${shq(url)}`, dest, opts.gzip, "sql-loose");
}

// custom = pg_restore of a custom-format archive; sql-atomic = our own plain
// dump (safe to wrap in one transaction); sql-loose = external SQL of unknown
// transaction structure (fail-loud, but not forced-atomic).
type PgMode = "custom" | "sql-atomic" | "sql-loose";

/** Shared: pipe an arbitrary source command through optional gpg/gunzip into the engine's restore client. */
function restorePipeline(db: DbSpec, sourceCmd: string, dest: DestinationSpec, gzip: boolean, pgMode: PgMode = "sql-atomic"): string {
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
      lines.push(`${decode.join(" | ")} | docker exec -i -e MYSQL_PWD=${shq(password)} ${name} mysql -u${shq(username)} ${shq(database)}`);
      break;
    case "MARIADB":
      lines.push(`${decode.join(" | ")} | docker exec -i -e MYSQL_PWD=${shq(password)} ${name} mariadb -u${shq(username)} ${shq(database)}`);
      break;
    case "MONGO":
      lines.push(`${decode.join(" | ")} | docker exec -i ${name} mongorestore --username ${shq(username)} --password ${shq(password)} --authenticationDatabase admin --archive --drop`);
      break;
    case "REDIS":
    case "KEYDB":
      lines.push(`${decode.join(" | ")} > /tmp/${name}.rdb`);
      lines.push(`docker cp /tmp/${name}.rdb ${name}:/data/dump.rdb`);
      lines.push(`docker restart ${name}`);
      lines.push(`rm -f /tmp/${name}.rdb`);
      break;
    case "DRAGONFLY": {
      // DFLY LOAD does FlushAll-then-load, so VALIDATE the RDB signature FIRST — an obviously corrupt/wrong
      // file must not wipe the live dataset before we even try to load it. `-e` makes a failed load exit
      // non-zero (redis-cli otherwise exits 0 on a command-level -ERR, masking a failed restore as success).
      const inner =
        "cat > /data/tugra_restore.rdb && head -c5 /data/tugra_restore.rdb | grep -q REDIS && " +
        "redis-cli -e --no-auth-warning DFLY LOAD /data/tugra_restore.rdb; rc=$?; rm -f /data/tugra_restore.rdb; exit $rc";
      lines.push(`${decode.join(" | ")} | docker exec -i -e ${shq(`REDISCLI_AUTH=${password}`)} ${name} sh -c ${shq(inner)}`);
      break;
    }
    case "CLICKHOUSE": {
      // Restore to a TEMP database, then DROP the real one and RENAME temp→real — so a corrupt/rejected backup
      // never destroys the live DB before the restore is known good (stage-then-swap). A prior-run temp is
      // cleared up front; on failure the data survives in EITHER the real DB or the temp (never both dropped).
      // Identifiers are DOUBLE-QUOTE quoted (\"…\") — backticks in the double-quoted --query would trigger shell
      // command substitution. clickhouse-client reads its credentials from the container env.
      const tmpDb = `${database}__tugra_restore_tmp`;
      const zip = "/var/lib/clickhouse/backups/tugra_restore.zip";
      const inner =
        "mkdir -p /var/lib/clickhouse/backups; " +
        `clickhouse-client --query "DROP DATABASE IF EXISTS \\"${tmpDb}\\" SYNC" 2>/dev/null; ` +
        `cat > ${zip} && ` +
        `clickhouse-client --query "RESTORE DATABASE \\"${database}\\" AS \\"${tmpDb}\\" FROM File('${zip}')" >/dev/null && ` +
        `clickhouse-client --query "DROP DATABASE IF EXISTS \\"${database}\\" SYNC" && ` +
        `clickhouse-client --query "RENAME DATABASE \\"${tmpDb}\\" TO \\"${database}\\""; ` +
        `rc=$?; rm -f ${zip}; exit $rc`;
      lines.push(`${decode.join(" | ")} | docker exec -i ${name} sh -c ${shq(inner)}`);
      break;
    }
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
