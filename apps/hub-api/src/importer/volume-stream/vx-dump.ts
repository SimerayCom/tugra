import type { VxDbSizeItem } from "./vx.dto";

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
  /** The dump's gzip size when the migrator COUNTED it (`dumpGzBytes`): the real size of the staged parts. Absent = unknown. */
  countedGzBytes?: number | null;
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

/** The bytes the staged parts may take on the target: the counted gzip size (+5%), else the raw size (the safe bound; see {@link dumpDiskVerdict}). */
export function dumpStagedBytes(rawDumpBytes: number, countedGzBytes?: number | null): number {
  if (countedGzBytes !== undefined && countedGzBytes !== null && countedGzBytes >= 0) return Math.ceil(countedGzBytes * 1.05);
  return Math.ceil(rawDumpBytes);
}

/**
 * Free-space verdict for a streamed dump on the TARGET. Two things land there: the staged compressed parts (the COUNTED gzip size
 * plus 5% when the migrator counted the dump; otherwise the raw size, because data that is already compressed or random
 * gzips to about 1.0x and an optimistic ratio would only fail hours into the transfer; the decoded dump is never on disk) and the restored database itself (the source's on-disk size
 * with 10% headroom plus 1 GiB for indexes, WAL and temporary files). On one filesystem both must fit together. An unreadable probe
 * is `unknown`, never `ok` (fail closed).
 */
export function dumpDiskVerdict(i: DumpDiskInput): DumpDiskVerdict {
  const staged = dumpStagedBytes(i.rawDumpBytes, i.countedGzBytes);
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

const MiB = 1024 ** 2;

/**
 * The one number pair a person needs from a failed free-space check: how much the target needs where it is tightest, and how much it
 * has there. Reads the `details` of either verdict (a volume's or a streamed dump's); null when the probe could not read the disk.
 */
export function diskShortfall(d: Record<string, number | boolean | string | null> | null | undefined): { needBytes: number; freeBytes: number } | null {
  if (!d) return null;
  const staging = typeof d.targetStagingFreeBytes === "number" ? d.targetStagingFreeBytes : null;
  const docker = typeof d.targetDockerFreeBytes === "number" ? d.targetDockerFreeBytes : null;
  if (staging === null || docker === null) return null;
  const same = d.targetSameDevice === true;
  if (d.lane === "dump") {
    const staged = typeof d.stagedBytes === "number" ? d.stagedBytes : null;
    const db = typeof d.databaseBytes === "number" ? d.databaseBytes : null;
    if (staged === null || db === null) return null;
    if (same) return { needBytes: staged + db, freeBytes: staging };
    return staging < staged ? { needBytes: staged, freeBytes: staging } : { needBytes: db, freeBytes: docker };
  }
  const total = typeof d.totalBytes === "number" ? d.totalBytes : null;
  if (total === null) return null;
  if (same) return { needBytes: Math.ceil(2.05 * total + GiB), freeBytes: staging };
  const stageNeed = Math.ceil(1.02 * total + 512 * MiB);
  return staging < stageNeed ? { needBytes: stageNeed, freeBytes: staging } : { needBytes: Math.ceil(1.05 * total + 512 * MiB), freeBytes: docker };
}
