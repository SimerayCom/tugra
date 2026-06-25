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
  type DestinationSpec,
} from "./destination";

export const BACKUP_DIR = "/etc/tugra/backups";

const EXT: Record<DbEngine, string> = {
  POSTGRES: "sql",
  MYSQL: "sql",
  MARIADB: "sql",
  REDIS: "rdb",
  KEYDB: "rdb",
  MONGO: "archive",
  // backup not supported yet (provision-only) — placeholders keep the map exhaustive
  DRAGONFLY: "rdb",
  CLICKHOUSE: "sql",
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
      return `docker exec -e PGPASSWORD=${shq(password)} ${name} pg_dump -U ${shq(username)} ${shq(database)}`;
    case "MYSQL":
      return `docker exec -e MYSQL_PWD=${shq(password)} ${name} mysqldump -u${shq(username)} ${shq(database)}`;
    case "MARIADB":
      return `docker exec -e MYSQL_PWD=${shq(password)} ${name} mariadb-dump -u${shq(username)} ${shq(database)}`;
    case "MONGO":
      return `docker exec ${name} mongodump --username ${shq(username)} --password ${shq(password)} --authenticationDatabase admin --archive`;
    case "REDIS":
      return `docker exec ${name} sh -c ${shq(`redis-cli -a ${shqInner(password)} --no-auth-warning SAVE >/dev/null 2>&1 && cat /data/dump.rdb`)}`;
    case "KEYDB":
      return `docker exec ${name} sh -c ${shq(`keydb-cli -a ${shqInner(password)} --no-auth-warning SAVE >/dev/null 2>&1 && cat /data/dump.rdb`)}`;
    case "DRAGONFLY":
    case "CLICKHOUSE":
      throw new Error(`backup not supported for ${db.engine}`);
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
  return restorePipeline(db, source, dest, true);
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
  return restorePipeline(db, `curl -fsSL ${shq(url)}`, dest, opts.gzip);
}

/** Shared: pipe an arbitrary source command through optional gpg/gunzip into the engine's restore client. */
function restorePipeline(db: DbSpec, sourceCmd: string, dest: DestinationSpec, gzip: boolean): string {
  const name = dbContainerName(db);
  const { username, password, database } = db.credentials;

  const decode = [sourceCmd];
  if (dest.encryption.enabled) decode.push(gpgDecrypt(dest));
  if (gzip) decode.push("gunzip");

  const lines = ["set -e", "set -o pipefail"];
  switch (db.engine) {
    case "POSTGRES":
      lines.push(`${decode.join(" | ")} | docker exec -i -e PGPASSWORD=${shq(password)} ${name} psql -U ${shq(username)} -d ${shq(database)}`);
      break;
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
    case "DRAGONFLY":
    case "CLICKHOUSE":
      throw new Error(`restore not supported for ${db.engine}`);
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
