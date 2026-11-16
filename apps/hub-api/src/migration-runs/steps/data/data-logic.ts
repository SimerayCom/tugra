/**
 * Pure logic of the data steps: transfer-error classification, the gate checks of DATA_SEED / DATA_FINAL, the window
 * estimate, the migrator command flags and a few hashing helpers. No I/O, no clock (callers pass `now`), no secret.
 * Everything here is unit-tested directly; the handlers only wire it to the ports.
 */
import { createHash } from "node:crypto";
import type { GateCheck, WindowEstimate } from "../../core/dto";
import { largeDbModeOf, resolveOwnerInput, type RunSnapshot } from "../../core/run-contract";
import { DATA_CODES, LIVE_VOLUME_STATES, type DataSnapshot, type DbDataItem, type ObjectView, type VolumeDataItem } from "./data-contract";
import { DUMP_MEASURE_BELOW_BYTES, VX_409, artifactCapBytes, isStreamDumpEngine } from "../../../importer/volume-stream/vx-constants";

// ───────────────────────────── hashing ─────────────────────────────

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** JSON with sorted object keys: the same value always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

/** A short, stable id fragment for a subject (item refs can be 256 chars; a gate check id is limited to 80). */
export const subjectKey = (subject: string): string => sha256Hex(subject).slice(0, 10);

/** The id under which one check can be acknowledged: unique per (check, subject). */
export const checkKey = (checkId: string, subject: string): string => (subject ? `${checkId}:${subjectKey(subject)}` : checkId);

// ───────────────────────────── transfer / task failure classification ─────────────────────────────

export type TransferFailure = "diverged" | "dest-dirty" | "fingerprint-changed" | "aborted" | "disk-insufficient" | "other";

/**
 * Classify a volume transfer's recorded `error` by the 409 literals the importer itself emits. The raw text is never
 * surfaced: the run shows a code.
 */
export function classifyTransferError(error: string | null): TransferFailure | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (e.includes(VX_409.diverged) || e.includes(VX_409.partLost) || e.includes(VX_409.shortPart)) return "diverged";
  if (e.includes(VX_409.destDirty.toLowerCase())) return "dest-dirty";
  if (e.includes(VX_409.fingerprintChanged)) return "fingerprint-changed";
  if (e.includes(VX_409.diskInsufficient)) return "disk-insufficient";
  if (e.includes("aborted")) return "aborted";
  return "other";
}

/** Classify a database `data:` task's failure output (fixed codes only). */
export function classifyDbTaskFailure(output: string | null): string | null {
  if (!output) return "restore-failed";
  const o = output.toLowerCase();
  if (o.includes("restored-differs") || o.includes("different artifact") || o.includes("differs")) return "restored-differs";
  if (o.includes("dest-dirty") || o.includes("dirty")) return "dest-dirty";
  return "restore-failed";
}

// ───────────────────────────── object migrations ─────────────────────────────

const ACTIVE_OBJECT_STATUSES = new Set(["SEEDING", "FINALIZING", "VERIFYING"]);
const SEEDED_BUCKET = new Set(["SEEDED", "FINAL", "VERIFIED", "DIFFERS"]);

export const objectIsActive = (o: ObjectView): boolean => ACTIVE_OBJECT_STATUSES.has(o.status) || o.buckets.some((b) => b.selected && ["QUEUED", "SEEDING", "FINALIZING"].includes(b.status));

/** Seed checks for the attached object migrations (hub-verified: the target agent measured them). */
export function objectSeedChecks(views: readonly ObjectView[]): GateCheck[] {
  const checks: GateCheck[] = [];
  for (const o of views) {
    if (o.blockers > 0) checks.push({ id: checkKey("object-blocked", o.id), status: "fail", code: DATA_CODES.seedObjectBlocked, subject: o.id, params: { blockers: o.blockers }, evidence: "hub-verified" });
    const selected = o.buckets.filter((b) => b.selected);
    if (selected.length === 0) {
      checks.push({ id: checkKey("object-seeded", o.id), status: "fail", code: DATA_CODES.seedObjectsPending, subject: o.id, params: { selected: 0 }, evidence: "hub-verified" });
      continue;
    }
    const pending = selected.filter((b) => !SEEDED_BUCKET.has(b.status));
    checks.push({
      id: checkKey("object-seeded", o.id),
      status: pending.length === 0 ? "pass" : objectIsActive(o) ? "unknown" : "fail",
      code: DATA_CODES.seedObjectsPending,
      subject: o.id,
      params: { pending: pending.length, selected: selected.length },
      evidence: "hub-verified",
    });
  }
  return checks;
}

/** Final checks for the attached object migrations: every selected bucket must be VERIFIED (`mc diff` clean). */
export function objectFinalChecks(views: readonly ObjectView[]): GateCheck[] {
  const checks: GateCheck[] = [];
  for (const o of views) {
    for (const b of o.buckets.filter((x) => x.selected)) {
      const subject = `${o.id}/${b.srcBucket}`;
      if (b.status === "VERIFIED") checks.push({ id: checkKey("bucket", subject), status: "pass", code: DATA_CODES.finalObjectsNotVerified, subject, evidence: "hub-verified" });
      else if (b.status === "DIFFERS")
        checks.push({ id: checkKey("bucket", subject), status: "fail", code: DATA_CODES.finalObjectDiffers, subject, params: { missing: b.diffMissing ?? 0, differ: b.diffDiffer ?? 0, extra: b.diffExtra ?? 0 }, evidence: "hub-verified" });
      else checks.push({ id: checkKey("bucket", subject), status: objectIsActive(o) ? "unknown" : "fail", code: DATA_CODES.finalObjectsNotVerified, subject, params: { status: b.status }, evidence: "hub-verified" });
    }
  }
  return checks;
}

// ───────────────────────────── per-database lane ─────────────────────────────

/**
 * Where a database's data moves, decided per database from the migrator's measured DUMP size, its engine and the layout gates:
 *  - `logical`: the dump (gzip) fits the artifact route's cap, so the standard one-command path carries it;
 *  - `physical`: the owner planned a copy of the data directory and every gate that can be known before the freeze passes;
 *  - `stream`: the STREAMED DUMP lane (no size cap, no layout limit): the dump is over the cap, or the physical copy cannot run;
 *  - `pending`: the migrator has not measured it yet (nothing is decided on a guess);
 *  - `blocked`: it needs the stream lane and the owner did not allow it (or the engine has none): a verdict, never a silent failure.
 * Only the DUMP size decides the cap: a volume a few MiB over it can still dump under it, and the reverse.
 */
export type DbLane = "logical" | "physical" | "stream" | "pending" | "blocked";

export interface LaneDecision {
  lane: DbLane;
  /** Fixed vocabulary, never text: `small-dump`, `over-cap`, `uncounted-over-cap`, `physical-planned`, `physical-gate`, `sticky`, `unmeasured`, `measure-failed`, `refused`, `engine-no-lane`, `stream-unavailable`. */
  reason: string;
  /** The raw dump bytes the decision rests on (counted, else the catalog size); null when nothing was measured. */
  dumpBytes: number | null;
  /** The gzip dump bytes (what the artifact route would carry) when the migrator counted the dump. */
  gzBytes: number | null;
  /** True when the dump itself was counted; false when only the catalog size is known. */
  counted: boolean;
  capBytes: number;
  /** `physical-gate`: the failing gate id. */
  gate?: string;
}

/** Gates whose failure proves the physical copy cannot run (the others are `state`, which a different lane cannot fix, and `quiesced`, which the freeze provides). */
const PHYSICAL_BLOCKING_GATES = new Set(["credentials", "major", "layout", "image"]);

export interface LaneInput {
  db: DbDataItem;
  /** The db-data volume row of a database planned for a physical copy (carries the gates), if any. */
  physical: VolumeDataItem | null;
  largeDbMode: "refuse" | "stream-logical";
  capBytes: number;
  /** The streamed dump lane is available on this hub. */
  dumpEnabled: boolean;
}

/** An uncounted catalog size at or under this fraction of the cap is certainly under it (a dump is smaller than the database). */
const UNCOUNTED_SAFE_FRACTION = 4;

export function decideDbLane(i: LaneInput): LaneDecision {
  const { db, capBytes } = i;
  const m = db.measure ?? null;
  const counted = !!m && m.state === "measured" && m.dumpGzBytes !== null && m.dumpGzBytes !== undefined;
  const dumpBytes = m && m.state === "measured" ? (m.dumpRawBytes ?? m.dbBytes) : null;
  const gzBytes = counted ? (m!.dumpGzBytes as number) : null;
  const base = { dumpBytes, gzBytes, counted, capBytes };
  const canStream = i.largeDbMode === "stream-logical" && isStreamDumpEngine(db.engine);

  if (db.plane === "stream") return { ...base, lane: "stream", reason: "sticky" };
  if (!isStreamDumpEngine(db.engine)) return { ...base, lane: db.plane === "volume" ? "physical" : "logical", reason: "engine-no-lane" };

  // a physical copy that passes every gate knowable before the freeze keeps its lane
  if (db.plane === "volume") {
    const failing = (i.physical?.gates ?? []).find((g) => PHYSICAL_BLOCKING_GATES.has(g.id) && g.status === "fail");
    if (!failing) return { ...base, lane: "physical", reason: "physical-planned" };
    if (!i.dumpEnabled) return { ...base, lane: "blocked", reason: "stream-unavailable", gate: failing.id };
    if (!canStream) return { ...base, lane: "blocked", reason: "refused", gate: failing.id };
    if (!m || m.state !== "measured") return { ...base, lane: "pending", reason: m ? "measure-failed" : "unmeasured", gate: failing.id };
    return { ...base, lane: "stream", reason: "physical-gate", gate: failing.id };
  }

  if (!m) return { ...base, lane: "pending", reason: "unmeasured" };
  if (m.state !== "measured") return { ...base, lane: "pending", reason: "measure-failed" };
  const small = counted ? gzBytes! <= capBytes : m.dbBytes <= capBytes / UNCOUNTED_SAFE_FRACTION && m.dbBytes <= DUMP_MEASURE_BELOW_BYTES;
  if (small) return { ...base, lane: "logical", reason: counted ? "small-dump" : "small-database" };
  const why = counted ? "over-cap" : "uncounted-over-cap";
  if (!i.dumpEnabled) return { ...base, lane: "blocked", reason: "stream-unavailable" };
  if (!canStream) return { ...base, lane: "blocked", reason: "refused" };
  return { ...base, lane: "stream", reason: why };
}

/** The decision for every database of the snapshot that has a choice (dump-capable engines, or any database already on the stream lane). */
export function decideLanes(run: Pick<RunSnapshot, "options">, snap: DataSnapshot, capBytes: number = artifactCapBytes()): Map<string, LaneDecision> {
  const out = new Map<string, LaneDecision>();
  const mode = largeDbModeOf(run.options);
  for (const d of snap.databases) {
    if (d.plane === "unsupported") continue;
    if (!isStreamDumpEngine(d.engine) && d.plane !== "stream") continue;
    const physical = d.plane === "volume" ? (snap.volumes.find((v) => v.destType === "db-data" && v.ownerItemRef === d.itemRef) ?? null) : null;
    out.set(d.itemRef, decideDbLane({ db: d, physical, largeDbMode: mode, capBytes, dumpEnabled: snap.dumpEnabled !== false && snap.vxEnabled }));
  }
  return out;
}

/** Databases the migrator moves itself (as an artifact, or as a streamed dump): the ones its source-side `--verify` report covers. */
export const isMigratorDb = (d: Pick<DbDataItem, "plane">): boolean => d.plane === "logical" || d.plane === "stream";

/** Databases whose lane still depends on a measurement the migrator has not made (the inspect pass must run). */
export function dbsNeedingMeasure(run: Pick<RunSnapshot, "options">, snap: DataSnapshot, retry = false): DbDataItem[] {
  const decisions = decideLanes(run, snap);
  return snap.databases.filter((d) => {
    const dec = decisions.get(d.itemRef);
    if (!dec) return false;
    if (d.plane === "volume" && dec.lane === "physical") return false; // its gates stand on their own
    if (!d.measure) return true;
    return retry && d.measure.state !== "measured";
  });
}

/** The lane checks of the DATA_SEED gate. `pass` carries the lane (information); `unknown`/`fail` carry what is missing or refused. */
export function dbLaneChecks(run: Pick<RunSnapshot, "options">, snap: DataSnapshot, capBytes: number = artifactCapBytes()): GateCheck[] {
  const checks: GateCheck[] = [];
  const decisions = decideLanes(run, snap, capBytes);
  for (const d of snap.databases) {
    const dec = decisions.get(d.itemRef);
    if (!dec) continue;
    const id = checkKey("db-lane", d.itemRef);
    const common = { subject: d.itemRef, evidence: "migrator-reported" as const };
    const sizes = { engine: d.engine, dumpBytes: dec.dumpBytes, gzBytes: dec.gzBytes, counted: dec.counted, capBytes: dec.capBytes };
    if (dec.lane === "pending") {
      checks.push({ id, status: dec.reason === "measure-failed" ? "fail" : "unknown", code: DATA_CODES.seedDbUnmeasured, params: { engine: d.engine, reason: dec.reason }, ...common });
    } else if (dec.lane === "blocked") {
      const code =
        dec.reason === "stream-unavailable" ? DATA_CODES.seedDbStreamUnavailable : dec.gate ? DATA_CODES.seedDbPhysicalRefused : DATA_CODES.seedDbOverCapRefused;
      checks.push({ id, status: "fail", code, params: { ...sizes, ...(dec.gate ? { gate: dec.gate } : {}) }, ...common });
    } else if (dec.reason === "engine-no-lane") {
      continue; // an engine with no dump lane keeps the standard route (the importer's own limits apply)
    } else {
      checks.push({ id, status: "pass", code: DATA_CODES.seedDbLane, params: { ...sizes, lane: dec.lane, reason: dec.reason }, ...common });
    }
  }
  return checks;
}

// ───────────────────────────── DATA_SEED checks ─────────────────────────────

/** The Postgres physical-copy gates evaluated at seed time: `quiesced` is expected to fail until the freeze, so it is excluded. */
const SEED_PG_GATES = new Set(["inventory", "credentials", "major", "layout", "image", "state"]);

const inScopeVolumes = (snap: DataSnapshot): VolumeDataItem[] => snap.volumes.filter((v) => !v.excluded);

/** The checks the DATA_SEED gate is made of (pure; `objects` are the attached object migrations' current views). */
export function seedChecks(run: RunSnapshot, snap: DataSnapshot, objects: readonly ObjectView[]): GateCheck[] {
  const checks: GateCheck[] = [];
  if (inScopeVolumes(snap).length > 0 && !snap.vxEnabled) checks.push({ id: "vx-disabled", status: "fail", code: DATA_CODES.vxDisabled });
  if (run.options.sourceRunner === "agent" && run.topology !== "swap-proxy") checks.push({ id: "agent-same-host", status: "fail", code: DATA_CODES.agentNeedsSameHost });

  for (const v of snap.volumes) {
    if (v.excluded) {
      checks.push({ id: checkKey("volume-excluded", v.itemRef), status: "warn", code: DATA_CODES.seedVolumeExcluded, subject: v.itemRef, evidence: "operator-attested" });
      continue;
    }
    if (!v.inventory) {
      checks.push({ id: checkKey("volume-inspected", v.itemRef), status: "unknown", code: DATA_CODES.seedVolumeNotInspected, subject: v.itemRef, evidence: "migrator-reported" });
      continue;
    }
    if (!v.inventory.found) {
      checks.push({ id: checkKey("volume-inspected", v.itemRef), status: "fail", code: DATA_CODES.seedVolumeMissing, subject: v.itemRef, evidence: "migrator-reported" });
      continue;
    }
    checks.push({ id: checkKey("volume-inspected", v.itemRef), status: "pass", code: DATA_CODES.seedVolumeNotInspected, subject: v.itemRef, params: { rawBytes: v.inventory.rawBytes, entries: v.inventory.entries }, evidence: "migrator-reported" });
    if (!v.disk) checks.push({ id: checkKey("volume-disk", v.itemRef), status: "unknown", code: DATA_CODES.seedDiskUnknown, subject: v.itemRef, evidence: "hub-verified" });
    else if (v.disk.unknown) checks.push({ id: checkKey("volume-disk", v.itemRef), status: "unknown", code: DATA_CODES.seedDiskUnknown, subject: v.itemRef, evidence: "hub-verified" });
    else if (!v.disk.ok) checks.push({ id: checkKey("volume-disk", v.itemRef), status: "fail", code: DATA_CODES.seedDiskInsufficient, subject: v.itemRef, evidence: "hub-verified" });
    else checks.push({ id: checkKey("volume-disk", v.itemRef), status: "pass", code: DATA_CODES.seedDiskUnknown, subject: v.itemRef, evidence: "hub-verified" });
    for (const g of v.gates ?? []) {
      if (!SEED_PG_GATES.has(g.id)) continue;
      checks.push({ id: checkKey(`pg-gate-${g.id}`, v.itemRef), status: g.status, code: DATA_CODES.seedPgGate, subject: v.itemRef, params: { gate: g.id }, evidence: "hub-verified" });
    }
  }

  checks.push(...dbLaneChecks(run, snap));

  if (run.options.warmDbSeed) {
    for (const d of snap.databases.filter((x) => x.plane === "logical")) {
      checks.push({ id: checkKey("warm-db", d.itemRef), status: d.task === "done" ? "pass" : d.task === "failed" ? "fail" : "unknown", code: DATA_CODES.seedWarmDb, subject: d.itemRef, params: { engine: d.engine }, evidence: "hub-verified" });
    }
  }
  checks.push(...objectSeedChecks(objects));
  return checks;
}

// ───────────────────────────── DATA_FINAL checks ─────────────────────────────

/**
 * A logical database whose `data:` task finished BEFORE the freeze holds a warm seed (or an earlier pass), not the final copy:
 * writes made between that dump and the freeze are not in it. Only enforced once the freeze opened (`freezeStartedAt` set,
 * which DATA_FINAL's own pre-gate guarantees); a task without a finish time cannot prove it is fresh.
 */
export function dbRestoredAfterFreeze(d: DbDataItem, freezeStartedAt: Date | null | undefined): boolean {
  if (d.task !== "done") return false;
  if (!freezeStartedAt) return true;
  const at = d.finishedAt ? Date.parse(d.finishedAt) : NaN;
  return Number.isFinite(at) && at >= freezeStartedAt.getTime();
}

// (a streamed dump's evidence is its volume row, checked through the `volumes` side of the snapshot)
const dbIsPending = (d: DbDataItem, freezeStartedAt: Date | null | undefined): boolean => d.plane === "logical" && !dbRestoredAfterFreeze(d, freezeStartedAt);

/** The checks the DATA_FINAL gate is made of. `warn` entries never block (they are reported in the VERIFY coverage ledger). */
export function finalChecks(snap: DataSnapshot, objects: readonly ObjectView[], freezeStartedAt?: Date | null): GateCheck[] {
  const checks: GateCheck[] = [];
  for (const d of snap.databases) {
    if (d.plane === "unsupported") {
      checks.push({ id: checkKey("db-unsupported", d.itemRef), status: "warn", code: DATA_CODES.finalDbUnsupported, subject: d.itemRef, params: { engine: d.engine, reason: d.unsupportedReason }, evidence: "hub-verified" });
      continue;
    }
    if (d.plane === "volume" || d.plane === "stream") continue; // its db-data / db-dump volume row below carries the evidence
    if (d.task === "done" && dbRestoredAfterFreeze(d, freezeStartedAt)) checks.push({ id: checkKey("db-restored", d.itemRef), status: "pass", code: DATA_CODES.finalDbNotRestored, subject: d.itemRef, params: { engine: d.engine }, evidence: "hub-verified" });
    else if (d.task === "done") checks.push({ id: checkKey("db-restored", d.itemRef), status: "unknown", code: DATA_CODES.finalDbNotRestored, subject: d.itemRef, params: { engine: d.engine, running: false, stale: true }, evidence: "hub-verified" });
    else if (d.task === "failed") {
      const code = d.taskFailure === "restored-differs" ? DATA_CODES.finalDbRestoredDiffers : DATA_CODES.finalDbFailed;
      checks.push({ id: checkKey("db-restored", d.itemRef), status: "fail", code, subject: d.itemRef, params: { engine: d.engine, reason: d.taskFailure ?? "restore-failed" }, evidence: "hub-verified" });
    } else checks.push({ id: checkKey("db-restored", d.itemRef), status: "unknown", code: DATA_CODES.finalDbNotRestored, subject: d.itemRef, params: { engine: d.engine, running: d.task === "running" }, evidence: "hub-verified" });
  }
  for (const v of snap.volumes) {
    if (v.excluded) {
      checks.push({ id: checkKey("volume-excluded", v.itemRef), status: "warn", code: DATA_CODES.seedVolumeExcluded, subject: v.itemRef, evidence: "operator-attested" });
      continue;
    }
    const failure = classifyTransferError(v.error);
    if (v.state === "DONE") {
      // a streamed dump has no entries to compare: its evidence is the verified parts and the restore's own exit status
      const entriesKnown = v.destType !== "db-dump" && v.entries !== null && v.inventory?.found === true;
      if (entriesKnown && v.inventory!.entries !== v.entries) {
        checks.push({ id: checkKey("volume-entries", v.itemRef), status: "fail", code: DATA_CODES.finalEntriesMismatch, subject: v.itemRef, params: { inspected: v.inventory!.entries, copied: v.entries as number }, evidence: "migrator-reported" });
      } else {
        checks.push({ id: checkKey("volume-copied", v.itemRef), status: "pass", code: DATA_CODES.finalVolumeNotDone, subject: v.itemRef, params: { rawBytes: v.rawBytesDone, entries: v.entries }, evidence: "hub-verified" });
      }
    } else if (v.state === "FAILED" || v.state === "ABORTED") {
      const code = failure === "diverged" ? DATA_CODES.finalVolumeDiverged : failure === "dest-dirty" ? DATA_CODES.finalDestDirty : DATA_CODES.finalVolumeFailed;
      checks.push({ id: checkKey("volume-copied", v.itemRef), status: "fail", code, subject: v.itemRef, params: { reason: failure ?? "other" }, evidence: "hub-verified" });
    } else {
      checks.push({
        id: checkKey("volume-copied", v.itemRef),
        status: "unknown",
        code: DATA_CODES.finalVolumeNotDone,
        subject: v.itemRef,
        params: { state: v.state, rawBytesDone: v.rawBytesDone, rawBytesTotal: v.rawBytesTotal },
        evidence: "hub-verified",
      });
    }
    for (const g of v.gates ?? []) {
      if (g.status === "pass") continue;
      checks.push({ id: checkKey(`pg-gate-${g.id}`, v.itemRef), status: g.status, code: DATA_CODES.finalPgGate, subject: v.itemRef, params: { gate: g.id }, evidence: "hub-verified" });
    }
  }
  checks.push(...objectFinalChecks(objects));
  return checks;
}

/** True when the migrator still has something to move (a database not yet restored since the freeze, or an unfinished volume). */
export function migratorWorkRemains(snap: DataSnapshot, freezeStartedAt?: Date | null): boolean {
  return snap.databases.some((d) => dbIsPending(d, freezeStartedAt)) || snap.volumes.some((v) => !v.excluded && v.state !== "DONE");
}

export const hasLiveTransfer = (snap: DataSnapshot): boolean => snap.volumes.some((v) => LIVE_VOLUME_STATES.includes(v.state));

// ───────────────────────────── window estimate ─────────────────────────────

/** Assumed end-to-end relay rate when no transfer has been measured yet: deliberately conservative. */
export const ASSUMED_BYTES_PER_SEC = 20 * 1024 * 1024;
/** "about 15 min extract per 30 GB" (G4-A docs): the target-side extract after the last part lands. */
export const EXTRACT_SEC_PER_BYTE = (15 * 60) / (30 * 1024 ** 3);
/** Fixed overhead: remap, deploy-dark health, verify and the flip itself are separate steps; this is only the data tail. */
export const DB_DUMP_OVERHEAD_SEC = 60;
export const WINDOW_BASE_OVERHEAD_SEC = 120;

/**
 * What a streamed dump is restored at on the target, in raw dump bytes per second (an ASSUMPTION, conservative: a restore rebuilds
 * indexes and replays statements, far slower than a copy). The window estimate says so; the measured transfer rate replaces the
 * copy half as soon as one exists, the restore half stays an assumption.
 */
export const STREAM_RESTORE_BYTES_PER_SEC: Readonly<Record<string, number>> = { POSTGRES: 10 * 1024 * 1024, MARIADB: 6 * 1024 * 1024, MYSQL: 6 * 1024 * 1024 };
export const DEFAULT_STREAM_RESTORE_BYTES_PER_SEC = 6 * 1024 * 1024;

export function estimateWindow(snap: DataSnapshot, now: Date): WindowEstimate {
  const all = inScopeVolumes(snap);
  const vols = all.filter((v) => v.destType !== "db-dump");
  const dumps = all.filter((v) => v.destType === "db-dump");
  const sizeOf = (v: VolumeDataItem): number => (v.inventory?.found ? v.inventory.rawBytes : (v.rawBytesTotal ?? 0));
  let bytes = 0;
  for (const v of vols) bytes += sizeOf(v);
  let dumpBytes = 0;
  let restoreSec = 0;
  for (const v of dumps) {
    const n = sizeOf(v);
    dumpBytes += n;
    restoreSec += Math.ceil(n / (STREAM_RESTORE_BYTES_PER_SEC[v.engine ?? ""] ?? DEFAULT_STREAM_RESTORE_BYTES_PER_SEC));
  }
  const observed = snap.volumes.map((v) => v.bps ?? 0).filter((x) => x > 0);
  const rate = observed.length ? Math.max(1, Math.round(observed.reduce((a, b) => a + b, 0) / observed.length)) : ASSUMED_BYTES_PER_SEC;
  const dbs = snap.databases.filter((d) => d.plane === "logical").length;
  const copySec = Math.ceil(bytes / rate);
  const extractSec = Math.ceil(bytes * EXTRACT_SEC_PER_BYTE);
  // a streamed dump has no warm seed: its dump, its transfer and its restore all run INSIDE the freeze (transfer first, restore after the last part)
  const streamSec = Math.ceil(dumpBytes / rate) + restoreSec;
  const total = copySec + extractSec + dbs * DB_DUMP_OVERHEAD_SEC + streamSec + WINDOW_BASE_OVERHEAD_SEC;
  const unknownSizes = all.filter((v) => !v.inventory?.found && v.rawBytesTotal === null).length;
  const basis: WindowEstimate["basis"] = [
    { code: "data-seed.estimate.bytes", params: { bytes, volumes: vols.length, unknown: unknownSizes } },
    { code: observed.length ? "data-seed.estimate.rate-observed" : "data-seed.estimate.rate-assumed", params: { bytesPerSec: rate } },
    { code: "data-seed.estimate.extract", params: { seconds: extractSec } },
    { code: "data-seed.estimate.databases", params: { count: dbs, secondsEach: DB_DUMP_OVERHEAD_SEC } },
  ];
  if (dumps.length > 0) {
    basis.push(
      { code: "data-seed.estimate.stream-databases", params: { count: dumps.length, bytes: dumpBytes, restoreSeconds: restoreSec } },
      { code: "data-seed.estimate.stream-in-freeze", params: { count: dumps.length } },
    );
  }
  return { freezeToFlipSec: unknownSizes > 0 ? null : total, basis, estimatedAt: now.toISOString() };
}

/** Same estimate ignoring the timestamp: lets a handler avoid rewriting an unchanged estimate every tick. */
export const estimateEquals = (a: WindowEstimate | null, b: WindowEstimate): boolean => !!a && a.freezeToFlipSec === b.freezeToFlipSec && canonicalJson(a.basis) === canonicalJson(b.basis);

// ───────────────────────────── migrator flags ─────────────────────────────

const FLAG_TOKEN_RE = /^[A-Za-z0-9._:=/@-]{1,100}$/;

/** Every flag word that reaches a source-host shell must match this (it never contains a space, quote or `$`). */
export function assertSafeFlags(flags: readonly string[]): void {
  for (const f of flags) if (!FLAG_TOKEN_RE.test(f)) throw new Error("unsafe migrator flag");
}

export type MigratorPhase = "inspect" | "warm-db" | "final";

/**
 * The flags the migrator is run with for one phase. The same list is shown to an operator (appended to the command the
 * UI mints) and passed by the same-host launcher, so both routes do exactly the same thing.
 */
export function migratorFlags(phase: MigratorPhase, run: RunSnapshot, snap?: Pick<DataSnapshot, "volumes">): string[] {
  const hasVolumes = !!snap && snap.volumes.some((v) => !v.excluded);
  const allowBind = resolveOwnerInput(run.inputs, "allowBind") === true;
  let flags: string[];
  switch (phase) {
    case "inspect":
      // --measure-dbs: each dump-capable database's catalog size (and its counted dump when cheap), so the lane is chosen from the DUMP
      flags = ["--arms", "all", "--dry-run", "--measure-dbs"];
      break;
    case "warm-db":
      flags = ["--arms", "databases"];
      break;
    case "final":
      flags = ["--arms", "all", "--resync", "--verify", "--verify-mode", run.options.rowCountMode, "--hub-outage-wait", "30m"];
      if (run.options.stopSource) flags.push("--stop-source");
      if (allowBind && hasVolumes) flags.push("--allow-bind");
      if (run.options.certs === "seed") flags.push("--certs");
      break;
  }
  assertSafeFlags(flags);
  return flags;
}
