/**
 * Constants + env-driven limits of the migration VOLUME STREAM (v2). Pure and secret-free. Every limit is read live
 * from the environment with a clamp, so an unset/garbage value falls back to the documented default and today's
 * behaviour is unchanged when the stream is not used.
 */

/** Wire protocol the migrator must speak; advertised on `GET targets` as `vxProtocol`. */
export const VX_PROTOCOL = 1;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function num(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/** Kill switch: `MIGRATION_VX_ENABLED=false|0|off|no` turns the stream off (routes 404, no volume rows in /targets). */
export function vxEnabled(): boolean {
  const raw = (process.env.MIGRATION_VX_ENABLED ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(raw);
}

/** Raw bytes per part (the hub policy the migrator must match): default 128 MiB, clamped 32..512. */
export function vxPartRawBytes(): number {
  return clampInt(num("MIGRATION_VX_PART_MIB"), 128, 32, 512) * MiB;
}

/** Raw (tar) bytes allowed per volume: default 256 GiB, ceiling 2 TiB. */
export function vxMaxBytes(): number {
  return clampInt(num("MIGRATION_VX_MAX_BYTES"), 256 * GiB, 1 * GiB, 2048 * GiB);
}

/** Part names are 5 digits (`p.00000`), so the count can never exceed 100000. */
export function vxMaxParts(): number {
  return clampInt(num("MIGRATION_VX_MAX_PARTS"), 100_000, 1, 100_000);
}

/** No beat/commit for this long = the migrator is gone (the recovery sweep fails the transfer, resumable). */
export function vxStaleMs(): number {
  return clampInt(num("MIGRATION_VX_STALE_MS"), 300_000, 30_000, 24 * 3600_000);
}

/** Hard cap on a migration token's total life under sliding renewal (hours → ms). */
export function tokenMaxLifeMs(): number {
  return clampInt(num("MIGRATION_TOKEN_MAX_LIFE_HOURS"), 72, 1, 24 * 14) * 3600_000;
}

/** Relay seats reserved for migration parts; separate from (never shared with) the app-move relay cap. */
export function migrationRelayConcurrency(): number {
  return clampInt(num("MIGRATION_RELAY_CONCURRENCY"), 2, 1, 16);
}

/** How long `commit` long-polls for the target's confirmation before answering `pending` (the migrator asks again). */
export function vxCommitWaitMs(): number {
  return clampInt(num("MIGRATION_VX_COMMIT_WAIT_MS"), 90_000, 10, 120_000);
}

/** The relay principal of a migrator-sourced part: cannot collide with a cuid ServerId, and the relay HMAC binds it. */
export const VX_PRINCIPAL_PREFIX = "mig:";
export function vxPrincipal(opId: string): string {
  return `${VX_PRINCIPAL_PREFIX}${opId}`;
}

/** The staging directory index every migration transfer uses under `/etc/tugra/app-moves/<transferId>/<idx>/`. */
export const VX_VOL_IDX = 0;

/** A volume itemRef: `volume:<serverRef|_>:<sourceRef>:<volName>` (mirrors the Go ParseVolumeRef). */
export const VOLUME_ITEMREF_RE = /^volume:([A-Za-z0-9_-]{1,128}):([a-zA-Z0-9][a-zA-Z0-9_-]{0,127}):([a-z0-9][a-z0-9_-]{0,63})$/;

/** The data-task itemRef of a stream transfer. The importer's stale-reaper never touches these. */
export function vxDataRef(itemRef: string): string {
  return `data:${itemRef}`;
}
export const VX_DATA_PREFIX = "data:volume:";

/**
 * The 409 `message` literals the Go migrator keys on (`classify409`). They are identical in
 * `apps/hub-api/test/fixtures/vx-409-literals.json` and `agent/internal/migrate/testdata/vx-409-literals.json` (a hub
 * test fails when the two copies differ), and every one is asserted to be thrown by the service.
 */
export const VX_409 = {
  fingerprintChanged: "vx-fingerprint-changed",
  diverged: "vx-diverged",
  shortPart: "vx-short-part",
  partLost: "vx-part-lost",
  diskInsufficient: "vx-disk-insufficient",
  aborted: "vx-aborted",
  otherRun: "another migrator run is active for this volume",
  dbVolumeMode: "this database is set to volume copy",
  usesStream: "this volume uses the streamed copy",
  usesHubStaged: "this volume already uses the hub-staged upload",
  destDirty: "the destination was started or holds data not restored by this migration",
} as const;
export type Vx409 = keyof typeof VX_409;
