/**
 * Pure, I/O-free helpers for the migration VOLUME data plane (P3). The volume ingest is a clone of the DB
 * data plane (migration-ingest.service.ts) with an app-volume destination instead of a database: the source
 * host PUTs a gzip tarball to hub staging, the hub restores it through the existing
 * {@link VolumeBackupsService.importFromUrl} over an HMAC-signed URL the target agent curls.
 *
 * These helpers carry NO secrets and touch NO disk/DB, so they are unit-tested directly. The size cap and the
 * restore timeout are deliberately coupled: a volume restore runs in one synchronous `sendCommand` bounded by
 * {@link volumeTimeoutMs}, whose ceiling stays well under the ingest service's 10-min stale-reaper window, so
 * a healthy restore never looks stale. Volumes over the cap are classified `manual-large` and routed to the
 * manual tar+copy path (NOT ridden through hub staging) — raising the cap past the ceiling needs the deferred
 * async/chunked restore (S6), never just a bigger number.
 */

export const DEFAULT_MAX_VOLUME_BYTES = 256 * 1024 * 1024; // gzip-compressed; parity with the DB artifact cap
export const MAX_VOLUME_BYTES_CEILING = 512 * 1024 * 1024; // hard ceiling: the 5-min sendCommand + 10-min stale reaper are coupled

/**
 * The live, env-aware per-volume staging cap (gzip-compressed bytes). `MIGRATION_MAX_VOLUME_BYTES` overrides
 * the default but is clamped to {@link MAX_VOLUME_BYTES_CEILING}; a garbage/zero/negative value falls back to
 * the default. Kept separate from the DB cap (`MIGRATION_MAX_ARTIFACT_BYTES`) so the two tune independently.
 */
export function maxVolumeBytes(): number {
  const n = Number(process.env.MIGRATION_MAX_VOLUME_BYTES);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_VOLUME_BYTES;
  return Math.min(n, MAX_VOLUME_BYTES_CEILING);
}

const RESTORE_BASE_MS = 5 * 60_000; // the agent fetch+decode+wipe+extract floor (mirrors the DB restore timeout)
const RESTORE_CEIL_MS = 8 * 60_000; // hard ceiling, strictly below STALE_RUNNING_MS (10 min) so a live restore is never reaped
const RESTORE_BYTES_PER_MS = 2 * 1024; // ~2 MiB/s decode+extract budget → +1 ms per 2 KiB

/**
 * How long to let a volume restore run on the target agent, scaled to the artifact size but clamped to
 * [{@link RESTORE_BASE_MS}, {@link RESTORE_CEIL_MS}]. The ceiling (8 min) is intentionally below the ingest
 * service's STALE_RUNNING_MS (10 min), so even a max-size restore completes before the stale-reaper could
 * re-claim the task.
 */
export function volumeTimeoutMs(bytes: number): number {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return Math.min(RESTORE_CEIL_MS, RESTORE_BASE_MS + Math.ceil(b / RESTORE_BYTES_PER_MS));
}

const MAX_DECODED_VOLUME_BYTES_CEILING = 8 * 1024 * 1024 * 1024; // 8 GiB hard ceiling on the TARGET host's temp write
const MIN_DECODED_VOLUME_BYTES = 1024 * 1024 * 1024; // 1 GiB floor so a small, highly-compressible legit volume never false-rejects
const DECODED_RATIO = 50; // allow up to ~50x compression; a gzip bomb (~1000x) is refused BEFORE it can fill the disk

/**
 * The decoded-size cap for an UNTRUSTED volume tarball, derived from its compressed size. The source host is
 * untrusted, so a ~250 MiB gzip of zeros (≈1000:1) would otherwise decompress to ≈250 GiB and fill the target
 * host's disk during restore. This caps the decoded stream (enforced by `head -c` in the import script) to a
 * generous multiple of the compressed bytes, clamped to [{@link MIN_DECODED_VOLUME_BYTES},
 * {@link MAX_DECODED_VOLUME_BYTES_CEILING}], so a bomb aborts before the wipe while real volumes are untouched.
 */
export function maxDecodedVolumeBytes(compressedBytes: number): number {
  const b = Number.isFinite(compressedBytes) && compressedBytes > 0 ? compressedBytes : 0;
  return Math.min(MAX_DECODED_VOLUME_BYTES_CEILING, Math.max(MIN_DECODED_VOLUME_BYTES, b * DECODED_RATIO));
}

// Mirrors SetVolumesSchema's name rule (applications/dto.ts) and appVolumeName()'s interpolation safety: the
// docker volume name tugra_appv_<appId>_<name> is placed UNQUOTED in a `-v` flag, so the name charset must be
// locked down here before a host-supplied :volumeName is ever used to resolve or write a volume.
export const VOLUME_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

/** True iff `n` is a syntactically valid app-volume name (the same set the declare step can produce). */
export function isValidVolumeName(n: unknown): n is string {
  return typeof n === "string" && VOLUME_NAME_RE.test(n);
}

/**
 * The staging-row itemRef for one app volume: `vol:<appItemRef>:<volumeName>`. A dedicated BulkTask carries
 * this ref (kind:"data", status DONE) so the per-volume staged artifact is keyed by ITS cuid — the app's
 * single provisioning task could not key two volumes without colliding. Build-only; never parsed back.
 */
export function volStageRef(appItemRef: string, volumeName: string): string {
  return `vol:${appItemRef}:${volumeName}`;
}

/** The sibling restore-task itemRef for one app volume: `data:` + {@link volStageRef}. The ingest service's
 *  existing `data:${task.itemRef}` restore-window lookup (serveArtifact) therefore works unmodified. */
export function volDataRef(appItemRef: string, volumeName: string): string {
  return `data:${volStageRef(appItemRef, volumeName)}`;
}

/**
 * Strip any URL (the signed dl capability link) and sig/exp query fragments out of agent output before it is
 * stored on a failed-restore task, so a volume restore's failure tail can never leak the capability URL to
 * the untrusted source host that polls status. Also bounds the length.
 */
export function scrubVolumeTail(s: string): string {
  return (s ?? "")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b(sig|exp)=[^&\s]+/gi, "$1=<redacted>")
    .slice(0, 2000);
}
