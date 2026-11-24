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

/**
 * Raw (dump) bytes allowed per STREAMED DATABASE DUMP. There is NO size cap by default: the only bound is structural (part names are
 * 5 digits, so a dump is at most {@link vxMaxParts} parts of {@link vxPartRawBytes} bytes: about 12 TiB at the defaults). An operator
 * who wants a ceiling sets `MIGRATION_VX_MAX_DUMP_BYTES` (at least 1 GiB, never above the structural bound).
 */
export function vxMaxDumpBytes(): number {
  const structural = vxMaxParts() * vxPartRawBytes();
  const cap = num("MIGRATION_VX_MAX_DUMP_BYTES");
  if (cap === undefined) return structural;
  return Math.min(structural, Math.max(1 * GiB, Math.floor(cap)));
}

/** True when the operator set a dump size ceiling (`MIGRATION_VX_MAX_DUMP_BYTES`): the plan then says so, instead of promising no limit. */
export function vxDumpCapIsOperatorSet(): boolean {
  return vxMaxDumpBytes() < vxMaxParts() * vxPartRawBytes();
}

/** Kill switch of the streamed dump lane alone: `MIGRATION_VX_DUMP_ENABLED=false|0|off|no` (the volume stream itself is unaffected). */
export function vxDumpEnabled(): boolean {
  const raw = (process.env.MIGRATION_VX_DUMP_ENABLED ?? "").trim().toLowerCase();
  return vxEnabled() && !["false", "0", "off", "no"].includes(raw);
}

/** The effective cap of the artifact route (`MIGRATION_MAX_ARTIFACT_BYTES`, default 256 MiB): the gzip dump size a logical restore may carry. */
export const DEFAULT_ARTIFACT_CAP_BYTES = 256 * MiB;
export function artifactCapBytes(): number {
  const n = Number(process.env.MIGRATION_MAX_ARTIFACT_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ARTIFACT_CAP_BYTES;
}

/** The catalog size up to which the migrator counts the dump itself; above it the hub treats the database as over the cap. Mirrors the Go default. */
export const DUMP_MEASURE_BELOW_BYTES = 1 * GiB;

/**
 * Engines the streamed dump lane understands: pg_dump custom format -> pg_restore, mariadb-dump / mysqldump -> the client,
 * mongodump --archive -> mongorestore --archive, ClickHouse BACKUP DATABASE -> RESTORE DATABASE.
 */
export const STREAM_DUMP_ENGINES = ["POSTGRES", "MARIADB", "MYSQL", "MONGO", "CLICKHOUSE"] as const;
export type StreamDumpEngine = (typeof STREAM_DUMP_ENGINES)[number];
export const isStreamDumpEngine = (e: string): e is StreamDumpEngine => (STREAM_DUMP_ENGINES as readonly string[]).includes(e);

/** Engines whose restore needs the dump as a FILE on the target (ClickHouse `RESTORE` cannot read a pipe): the target needs room for it next to the restored database. */
export const dumpLandsAsFile = (e: string): boolean => e === "CLICKHOUSE";

/** The volume name of a streamed dump row: `volume:<serverRef>:<sourceRef>:dump`. */
export const DUMP_VOLUME_NAME = "dump";
/** `volumeIngest` of a dump row in `GET targets` (an older migrator ignores a value it does not know). */
export const VOLUME_INGEST_DUMP = "stream-dump";

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
/** A streamed copy's data task: hours-long by design, so it must not make the whole import read "still running". */
export function isVxDataTask(t: { kind?: string | null; itemRef?: string | null }): boolean {
  return t.kind === "data" && typeof t.itemRef === "string" && t.itemRef.startsWith(VX_DATA_PREFIX);
}

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
