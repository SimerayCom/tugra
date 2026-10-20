import { dumpDbToStdout } from "../backups/backup-script";
import { supportsBackup, type DbEngine, type DbCredentials } from "../databases/database-script";
import type { DumpFormat } from "./import-source";

/**
 * The importer's DB data-plane dump recipe. It does NOT reinvent per-engine dump commands — it reuses Tugra's
 * own {@link dumpDbToStdout} (the exact builder behind Tugra's backups), so a dump taken from a source DB
 * container always matches what Tugra's restore (import-from-url) consumes, across every supported engine.
 * The SSH layer runs `command` inside the source container on the host and streams stdout to Tugra.
 */

const DUMP_FORMAT: Record<DbEngine, DumpFormat | null> = {
  POSTGRES: "pg_custom",
  MYSQL: "sql",
  MARIADB: "sql",
  MONGO: "mongo_archive",
  REDIS: "rdb",
  KEYDB: "rdb",
  DRAGONFLY: "rdb",
  CLICKHOUSE: "clickhouse_zip",
  LIBSQL: null, // single SQLite file — captured by a volume move, not a logical dump
};

/** Whether this engine has an SSH logical-dump path (everything Tugra can back up, i.e. all but LibSQL). */
export function canDumpOverSsh(engine: DbEngine): boolean {
  return supportsBackup(engine) && DUMP_FORMAT[engine] !== null;
}

export interface ImporterDumpPlan {
  /** The dump command to run (over SSH) inside the source DB container; streams the dump to stdout. */
  command: string;
  /** The dump format, so the restore side picks the right tool (pg_restore / mysql / mongorestore / …). */
  format: DumpFormat;
}

export function buildImporterDump(engine: DbEngine, container: string, creds: DbCredentials): ImporterDumpPlan {
  const format = DUMP_FORMAT[engine];
  if (!format) {
    throw new Error(`cannot dump ${engine} over SSH (no logical dump/restore pipeline) — move it manually (see the migration runbook)`);
  }
  return { command: dumpDbToStdout(engine, container, creds), format };
}
