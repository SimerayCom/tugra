/** Pure rules of the pre-migration snapshot (item 93): how long it lives, what its overall state is, when it is due. */

/** The safety copy is kept this many days, then removed (object and row). */
export const SNAPSHOT_TTL_DAYS = 7;
const DAY_MS = 86_400_000;

export const SNAPSHOT_STATUSES = ["PLANNED", "CAPTURING", "SUCCESS", "PARTIAL", "FAILED", "EXPIRED", "SKIPPED"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export interface SnapshotItem {
  kind: "database" | "volume";
  /** The Tugra database id or application id the copy belongs to. */
  ref: string;
  /** The volume name for a volume copy. */
  volume?: string;
  name: string | null;
  /** The `Backup` / `VolumeBackup` row the copy is recorded in (restore goes through it). */
  rowId: string | null;
  status: "SUCCESS" | "FAILED";
  sizeBytes: string | null;
  /** A scrubbed one-line reason, never raw agent output. */
  error: string | null;
}

export const expiryOf = (from: Date): Date => new Date(from.getTime() + SNAPSHOT_TTL_DAYS * DAY_MS);

/** `SUCCESS` only when every item copied; some = `PARTIAL`; none = `FAILED`. Nothing to copy is the caller's `SKIPPED`. */
export function overallStatus(items: ReadonlyArray<Pick<SnapshotItem, "status">>): "SUCCESS" | "PARTIAL" | "FAILED" {
  const ok = items.filter((i) => i.status === "SUCCESS").length;
  return ok === items.length ? "SUCCESS" : ok === 0 ? "FAILED" : "PARTIAL";
}

/** The data copy is complete (the target holds the source's frozen state) once DATA_FINAL passed. */
export const captureDue = (steps: ReadonlyArray<{ key: string; status: string }>): boolean => steps.some((s) => s.key === "DATA_FINAL" && s.status === "PASSED");

/** A run in one of these states can no longer use a new copy. */
const DEAD_RUN = new Set(["ABORTED", "ROLLED_BACK", "REVERSED", "DRY_RUN_DONE"]);
export const runAcceptsSnapshot = (status: string): boolean => !DEAD_RUN.has(status);

/** Which stored rows a stuck capture may be retried from. */
export const retryable = (s: string): boolean => s === "PLANNED" || s === "FAILED" || s === "PARTIAL";
export const isLive = (s: string): boolean => s === "SUCCESS" || s === "PARTIAL";
