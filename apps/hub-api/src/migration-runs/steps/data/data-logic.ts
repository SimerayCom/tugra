/**
 * Pure logic of the data steps: transfer-error classification, the gate checks of DATA_SEED / DATA_FINAL, the window
 * estimate, the migrator command flags and a few hashing helpers. No I/O, no clock (callers pass `now`), no secret.
 * Everything here is unit-tested directly; the handlers only wire it to the ports.
 */
import { createHash } from "node:crypto";
import type { GateCheck, WindowEstimate } from "../../core/dto";
import { resolveOwnerInput, type RunSnapshot } from "../../core/run-contract";
import { DATA_CODES, LIVE_VOLUME_STATES, type DataSnapshot, type DbDataItem, type ObjectView, type VolumeDataItem } from "./data-contract";
import { VX_409 } from "../../../importer/volume-stream/vx-constants";

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

const dbIsPending = (d: DbDataItem, freezeStartedAt: Date | null | undefined): boolean => d.plane === "logical" && !dbRestoredAfterFreeze(d, freezeStartedAt);

/** The checks the DATA_FINAL gate is made of. `warn` entries never block (they are reported in the VERIFY coverage ledger). */
export function finalChecks(snap: DataSnapshot, objects: readonly ObjectView[], freezeStartedAt?: Date | null): GateCheck[] {
  const checks: GateCheck[] = [];
  for (const d of snap.databases) {
    if (d.plane === "unsupported") {
      checks.push({ id: checkKey("db-unsupported", d.itemRef), status: "warn", code: DATA_CODES.finalDbUnsupported, subject: d.itemRef, params: { engine: d.engine, reason: d.unsupportedReason }, evidence: "hub-verified" });
      continue;
    }
    if (d.plane === "volume") continue; // its db-data volume row below carries the evidence
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
      const entriesKnown = v.entries !== null && v.inventory?.found === true;
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

export function estimateWindow(snap: DataSnapshot, now: Date): WindowEstimate {
  const vols = inScopeVolumes(snap);
  let bytes = 0;
  for (const v of vols) bytes += v.inventory?.found ? v.inventory.rawBytes : (v.rawBytesTotal ?? 0);
  const observed = snap.volumes.map((v) => v.bps ?? 0).filter((x) => x > 0);
  const rate = observed.length ? Math.max(1, Math.round(observed.reduce((a, b) => a + b, 0) / observed.length)) : ASSUMED_BYTES_PER_SEC;
  const dbs = snap.databases.filter((d) => d.plane === "logical").length;
  const copySec = Math.ceil(bytes / rate);
  const extractSec = Math.ceil(bytes * EXTRACT_SEC_PER_BYTE);
  const total = copySec + extractSec + dbs * DB_DUMP_OVERHEAD_SEC + WINDOW_BASE_OVERHEAD_SEC;
  const unknownSizes = vols.filter((v) => !v.inventory?.found && v.rawBytesTotal === null).length;
  return {
    freezeToFlipSec: unknownSizes > 0 ? null : total,
    basis: [
      { code: "data-seed.estimate.bytes", params: { bytes, volumes: vols.length, unknown: unknownSizes } },
      { code: observed.length ? "data-seed.estimate.rate-observed" : "data-seed.estimate.rate-assumed", params: { bytesPerSec: rate } },
      { code: "data-seed.estimate.extract", params: { seconds: extractSec } },
      { code: "data-seed.estimate.databases", params: { count: dbs, secondsEach: DB_DUMP_OVERHEAD_SEC } },
    ],
    estimatedAt: now.toISOString(),
  };
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
      flags = ["--arms", "all", "--dry-run"];
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
