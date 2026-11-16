import type { VxDbSizeItem } from "./vx.dto";
import { DUMP_STAGED_RATIO } from "./vx-constants";

/**
 * Pure helpers of the STREAMED DATABASE DUMP lane: what the migrator measured for a database, the best size estimate the hub can
 * make from it, and the free-space verdict for the target. Nothing here does I/O.
 *
 * The lane exists because the 256 MiB artifact route is capped by the size of the DUMP (gzip), not the size of the volume, and a
 * database that cannot be copied as files (PostgreSQL 18's nested data directory, an Alpine cluster under Tugra's Debian image,
 * MariaDB) has no other route at any size.
 */

/** `Restore.createdBy` of the restore rows the streamed dump lane writes (`vx:<transferId>`): how the lane tells its own restore from anyone else's. */
export const VX_RESTORE_BY_PREFIX = "vx:";

/** What `POST vx/db-sizes` stores per database (`BulkOperation.meta.vxDbSizes[<database itemRef>]`). */
export interface DbSizeRecord extends VxDbSizeItem {
  runId?: string;
  at?: string;
}

/** The best known raw dump size: the counted dump, else the catalog size (an upper-ish bound of a dump), else null. */
export function dumpRawEstimate(m: Pick<DbSizeRecord, "state" | "dbBytes" | "dumpRawBytes"> | null | undefined): number | null {
  if (!m || m.state !== "measured") return null;
  if (m.dumpRawBytes !== undefined) return m.dumpRawBytes;
  return m.dbBytes;
}

/** True when the size in {@link dumpRawEstimate} is the counted dump rather than a catalog-size bound. */
export const dumpWasCounted = (m: Pick<DbSizeRecord, "state" | "dumpRawBytes"> | null | undefined): boolean => !!m && m.state === "measured" && m.dumpRawBytes !== undefined;

export interface DumpDiskInput {
  /** Raw (decoded) dump bytes the transfer will carry. */
  rawDumpBytes: number;
  /** The database's own on-disk size on the source: the target's docker root has to hold the restored database. */
  dbBytes: number;
  targetStagingFreeBytes: number | null;
  targetDockerFreeBytes: number | null;
  targetSameDevice: boolean;
}

export interface DumpDiskVerdict {
  ok: boolean;
  unknown: boolean;
  details: Record<string, number | boolean | string | null>;
}

const GiB = 1024 ** 3;

/**
 * Free-space verdict for a streamed dump on the TARGET. Two things land there: the staged compressed parts (about the dump size
 * times {@link DUMP_STAGED_RATIO}, the decoded dump is never on disk) and the restored database itself (the source's on-disk size
 * with 10% headroom plus 1 GiB for indexes, WAL and temporary files). On one filesystem both must fit together. An unreadable probe
 * is `unknown`, never `ok` (fail closed).
 */
export function dumpDiskVerdict(i: DumpDiskInput): DumpDiskVerdict {
  const staged = Math.ceil(i.rawDumpBytes * DUMP_STAGED_RATIO);
  const dbNeed = Math.ceil(Math.max(i.dbBytes, i.rawDumpBytes) * 1.1 + GiB);
  const details = { totalBytes: i.rawDumpBytes, stagedBytes: staged, databaseBytes: dbNeed, targetStagingFreeBytes: i.targetStagingFreeBytes, targetDockerFreeBytes: i.targetDockerFreeBytes, targetSameDevice: i.targetSameDevice, lane: "dump" };
  if (i.targetStagingFreeBytes === null || i.targetDockerFreeBytes === null) return { ok: false, unknown: true, details };
  const stageOk = i.targetSameDevice ? i.targetStagingFreeBytes >= staged + dbNeed : i.targetStagingFreeBytes >= staged;
  const dockerOk = i.targetSameDevice ? true : i.targetDockerFreeBytes >= dbNeed;
  return { ok: stageOk && dockerOk, unknown: false, details };
}

/** The restore budget the hub gives the target's streaming restore: a floor plus a generous allowance per GiB of dump (<= 24 h). */
export function dumpRestoreTimeoutMs(rawBytes: number): number {
  const ms = 15 * 60_000 + Math.ceil(Math.max(0, rawBytes) / GiB) * 6 * 60_000;
  return Math.min(Math.max(ms, 1), 24 * 3600_000);
}
