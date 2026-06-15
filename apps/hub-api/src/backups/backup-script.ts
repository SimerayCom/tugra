/**
 * Pure builders for the shell scripts the agent runs to dump / restore a managed
 * database to/from a file on the server's own disk.
 *
 * IMPORTANT: the agent exec channel caps combined output at 64KB, so a dump can
 * never be streamed back through it. Instead the agent writes the dump to a file
 * and the script prints only the byte size (`stat -c %s`). Restore reads from
 * that on-disk file. (Off-site/S3 upload is a follow-up; it also runs server-side.)
 */

import {
  dbContainerName,
  type DbEngine,
  type DbSpec,
} from "../databases/database-script";

export const BACKUP_DIR = "/etc/tugra/backups";

const EXT: Record<DbEngine, string> = {
  POSTGRES: "sql",
  MYSQL: "sql",
  REDIS: "rdb",
  MONGO: "archive",
};

export function backupDir(dbId: string): string {
  return `${BACKUP_DIR}/${dbId}`;
}

export function backupFilename(engine: DbEngine, ts: string): string {
  return `${ts}.${EXT[engine]}`;
}

export function backupPath(dbId: string, filename: string): string {
  return `${backupDir(dbId)}/${filename}`;
}

function shq(v: string): string {
  return `'${v.replaceAll("'", "'\\''")}'`;
}

/** Engine-specific dump command writing to `file` (stdout redirected, or docker cp). */
function dumpCmd(db: DbSpec, file: string): string {
  const name = dbContainerName(db);
  const { username, password, database } = db.credentials;
  switch (db.engine) {
    case "POSTGRES":
      return `docker exec -e PGPASSWORD=${shq(password)} ${name} pg_dump -U ${shq(username)} ${shq(database)} > ${file}`;
    case "MYSQL":
      return `docker exec -e MYSQL_PWD=${shq(password)} ${name} mysqldump -u${shq(username)} ${shq(database)} > ${file}`;
    case "MONGO":
      return `docker exec ${name} mongodump --username ${shq(username)} --password ${shq(password)} --authenticationDatabase admin --archive > ${file}`;
    case "REDIS":
      return `docker exec ${name} redis-cli -a ${shq(password)} --no-auth-warning SAVE && docker cp ${name}:/data/dump.rdb ${file}`;
  }
}

export function buildBackupScript(db: DbSpec, filename: string): string {
  const dir = backupDir(db.id);
  const file = backupPath(db.id, filename);
  return [
    "set -e",
    `mkdir -p ${dir}`,
    dumpCmd(db, file),
    `stat -c %s ${file}`,
  ].join("\n");
}

/** Engine-specific restore command reading from the on-disk `file`. */
function restoreCmd(db: DbSpec, file: string): string {
  const name = dbContainerName(db);
  const { username, password, database } = db.credentials;
  switch (db.engine) {
    case "POSTGRES":
      return `cat ${file} | docker exec -i -e PGPASSWORD=${shq(password)} ${name} psql -U ${shq(username)} -d ${shq(database)}`;
    case "MYSQL":
      return `cat ${file} | docker exec -i -e MYSQL_PWD=${shq(password)} ${name} mysql -u${shq(username)} ${shq(database)}`;
    case "MONGO":
      return `docker exec -i ${name} mongorestore --username ${shq(username)} --password ${shq(password)} --authenticationDatabase admin --archive --drop < ${file}`;
    case "REDIS":
      return [
        `docker cp ${file} ${name}:/data/dump.rdb`,
        `docker restart ${name}`,
      ].join(" && ");
  }
}

export function buildRestoreScript(db: DbSpec, filename: string): string {
  const file = backupPath(db.id, filename);
  return ["set -e", restoreCmd(db, file)].join("\n");
}

/** Delete a single backup file (used when pruning / removing). */
export function buildDeleteBackupScript(dbId: string, filename: string): string {
  return `rm -f ${backupPath(dbId, filename)} 2>/dev/null || true`;
}
