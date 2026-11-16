/**
 * P7 lane B: the data / freeze / verify steps' own contract. ADDITIVE to `core/run-contract.ts` (which lane B cannot
 * change): the read model of an import op's data plane, and the ports (interfaces) every handler talks to. The real
 * adapters live in `adapters/`; the tests use the fakes in `testing/`.
 *
 * Nothing here carries a secret: tokens are issued by a port and handed straight to the launcher, never stored in a
 * snapshot, an event or a check row.
 */
import type { RunSnapshot, StepKey } from "../../core/run-contract";
import type { GateResult } from "../../core/dto";

// ───────────────────────────── DI tokens ─────────────────────────────

export const DATA_PORT = Symbol("MIGRATION_RUN_DATA_PORT");
export const OBJECT_PORT = Symbol("MIGRATION_RUN_OBJECT_PORT");
export const SOURCE_HOST_PORT = Symbol("MIGRATION_RUN_SOURCE_HOST_PORT");
export const SOURCE_API_PORT = Symbol("MIGRATION_RUN_SOURCE_API_PORT");
export const CAPABILITY_PORT = Symbol("MIGRATION_RUN_CAPABILITY_PORT");
export const CHECK_STORE = Symbol("MIGRATION_RUN_CHECK_STORE");
export const DB_STATS_PORT = Symbol("MIGRATION_RUN_DB_STATS_PORT");
export const RUNTIME_PORT = Symbol("MIGRATION_RUN_RUNTIME_PORT");
export const FLIP_PLAN_PORT = Symbol("MIGRATION_RUN_FLIP_PLAN_PORT");
export const DRIFT_PORT = Symbol("MIGRATION_RUN_DRIFT_PORT");

// ───────────────────────────── the data plane read model ─────────────────────────────

/** The migrator's own inspection of one source volume (`--dry-run`), reported by an UNTRUSTED host. */
export interface InventoryLite {
  found: boolean;
  rawBytes: number;
  entries: number;
  running: boolean;
  mountType: "volume" | "bind";
  pgMajor?: string;
  pgLayout?: string;
}

/** Volume transfer states of the importer (`MigrationVolumeTransfer.state`) plus the two the view adds. */
export type VolumeState = "NONE" | "EXCLUDED" | "PENDING" | "COPYING" | "COPIED" | "APPLYING" | "DONE" | "FAILED" | "ABORTED";
export const LIVE_VOLUME_STATES: readonly VolumeState[] = ["PENDING", "COPYING", "COPIED", "APPLYING"];

export interface VolumeDataItem {
  itemRef: string;
  destType: "app-volume" | "db-data";
  /** Display name of the owning app/database (never a secret). */
  ownerName: string | null;
  excluded: boolean;
  state: VolumeState;
  rawBytesTotal: number | null;
  rawBytesDone: number;
  bytesDone: number;
  bps: number | null;
  etaSec: number | null;
  /** Entry count the migrator reported at finish (the hub cross-checks it while applying). */
  entries: number | null;
  error: string | null;
  inventory: InventoryLite | null;
  disk: { ok: boolean; unknown: boolean } | null;
  /** db-data only: the physical-copy gates (id + status), evaluated hub-side. */
  gates: Array<{ id: string; status: "pass" | "fail" | "unknown" }> | null;
}

export type DbPlane = "logical" | "volume" | "unsupported";

export interface DbDataItem {
  itemRef: string;
  dbId: string | null;
  name: string | null;
  engine: string;
  plane: DbPlane;
  unsupportedReason: string | null;
  /** The `data:<itemRef>` task: none = never started. */
  task: "none" | "running" | "done" | "failed";
  /** A fixed failure classification of the data task's output (never the raw text). */
  taskFailure: string | null;
  /** When the `data:<itemRef>` task last finished (ISO); null while it has not. A dump restored BEFORE the freeze is not the final copy. */
  finishedAt: string | null;
}

export interface SourceItem {
  /** `app:<serverRef|_>:<uuid>` / `service:...` */
  itemRef: string;
  /** Display name (the destination's name; no secret). */
  name: string | null;
}

export interface DataSnapshot {
  opId: string;
  targetServerId: string;
  vxEnabled: boolean;
  /** A live migration token exists (the operator can still run the migrator). */
  tokenActive: boolean;
  tokenExpiresAt: string | null;
  /** The hub origin captured when the token was last minted (or HUB_PUBLIC_URL); null when unknown. */
  hubBase: string | null;
  databases: DbDataItem[];
  volumes: VolumeDataItem[];
  /** Apps the op provisioned (the FREEZE stop list is built from these). */
  apps: SourceItem[];
  services: SourceItem[];
}

/** An object migration, reduced to what the run needs (no endpoints, no credentials). */
export interface ObjectView {
  id: string;
  status: string;
  phase: "seed" | "final" | null;
  buckets: Array<{ srcBucket: string; selected: boolean; status: string; diffMissing: number | null; diffDiffer: number | null; diffExtra: number | null }>;
  blockers: number;
  cancelRequested: boolean;
}

// ───────────────────────────── ports ─────────────────────────────

/** The importer's data plane, as the run sees it. The real adapter is read-only except where a method says otherwise. */
export interface DataPort {
  /** READ-ONLY. Throws {@link DataPortError} `op-missing` when the op is gone/foreign. */
  snapshot(run: RunSnapshot): Promise<DataSnapshot>;
  /** Rotate the op's migration token (invalidating any command already pasted) and return it ONCE. */
  issueToken(run: RunSnapshot, hubBase: string): Promise<{ token: string; expiresAt: Date }>;
  /** Kill the op's live migration token. Idempotent. */
  revokeToken(run: RunSnapshot): Promise<void>;
  /** Abort the LIVE (not applying/done) transfers among `itemRefs`; returns the ones aborted. Never resets or wipes. */
  abortTransfers(run: RunSnapshot, itemRefs: readonly string[]): Promise<string[]>;
}

export class DataPortError extends Error {
  constructor(readonly code: "op-missing" | "forbidden" | "token-rejected") {
    super(code);
    this.name = "DataPortError";
  }
}

/** Object (S3/MinIO) migrations, driven on the target agent. The run only attaches and observes; credentials never pass through it. */
export interface ObjectPort {
  /** null when the migration is gone or the actor cannot read it. */
  get(userId: string, id: string): Promise<ObjectView | null>;
  startSeed(userId: string, id: string): Promise<void>;
  /** The caller has verified the writers are frozen (FREEZE passed); the port passes the acknowledgement. */
  startFinal(userId: string, id: string): Promise<void>;
  verify(userId: string, id: string): Promise<void>;
  cancel(userId: string, id: string): Promise<void>;
}

/** Run a script on a server's agent under the opt-in `migrate` capability (or `database` for the read-only DB stats). */
export interface SourceHostPort {
  run(serverId: string, script: string, capability: "migrate" | "database", timeoutMs: number): Promise<{ exitCode: number; output: string }>;
}

export type ApiResourceKind = "application" | "service" | "database";
export type ApiState = "running" | "stopped" | "unknown";
export type ApiFailure = "forbidden" | "unauthorized" | "not-found" | "unreachable" | "rejected" | "bad-response" | "session-expired" | "unsupported";

/** The Coolify write API, bound to the run's import session. */
export interface SourceApiPort {
  /** False for a source kind without a control client (Dokploy) or when the session is unusable. */
  available(run: RunSnapshot): Promise<{ ok: true } | { ok: false; reason: ApiFailure }>;
  state(run: RunSnapshot, kind: ApiResourceKind, uuid: string): Promise<{ ok: true; state: ApiState } | { ok: false; reason: ApiFailure }>;
  stop(run: RunSnapshot, kind: ApiResourceKind, uuid: string): Promise<{ ok: true } | { ok: false; reason: ApiFailure }>;
  start(run: RunSnapshot, kind: ApiResourceKind, uuid: string): Promise<{ ok: true } | { ok: false; reason: ApiFailure }>;
}

/** Grant/revoke the opt-in `migrate` capability for a run (only when this run added it). */
export interface CapabilityPort {
  /** Idempotent. `added` is true only when THIS call added it (so only then may the run revoke it later). */
  ensureMigrate(userId: string, serverId: string): Promise<{ ok: true; added: boolean } | { ok: false; reason: "forbidden" | "not-found" }>;
  releaseMigrate(userId: string, serverId: string): Promise<void>;
}

export type CheckStatusValue = "pass" | "fail" | "warn" | "unknown";
export type EvidenceKindValue = "hub-verified" | "migrator-reported" | "operator-attested";

export interface RunCheckRow {
  runId: string;
  stepKey: string;
  checkId: string;
  subject: string;
  status: CheckStatusValue;
  evidenceKind: EvidenceKindValue;
  evidence: Record<string, unknown> | null;
  at: Date;
}

/** `MigrationRunCheck` persistence. `upsert` is the only writer; `evidence` is capped at 8 KiB and must be secret-free. */
export interface CheckStore {
  list(runId: string, stepKey: string): Promise<RunCheckRow[]>;
  upsert(row: Omit<RunCheckRow, "at"> & { at?: Date }): Promise<void>;
}

// ───────────────────────────── DB logical-parity statistics ─────────────────────────────

export interface StatsTable {
  name: string;
  /** -1 = not counted (the measuring side refused or failed on this one). */
  rows: number;
  estimated: boolean;
  /** Redis family: keys carrying a TTL (they may legitimately expire between the two measurements). */
  expires: number;
}

/** One database's statistics from ONE side (`source` = reported by the migrator, `target` = measured by the hub). */
export interface DbStats {
  itemRef: string;
  engine: string;
  kind: "tables" | "keys";
  mode: "exact" | "estimate";
  state: "measured" | "skipped" | "failed";
  reason: string | null;
  tableCount: number;
  truncated: boolean;
  tables: StatsTable[];
}

export interface DbStatsPort {
  /** Measure the TARGET database (hub-verified: the hub runs the statement through the target agent). */
  measureTarget(run: RunSnapshot, db: DbDataItem, mode: "exact" | "estimate"): Promise<DbStats>;
}

// ───────────────────────────── runtime / flip plan / drift ─────────────────────────────

export interface RuntimeAppState {
  itemRef: string;
  name: string | null;
  /** The Tugra app status (`RUNNING`, `STOPPED`, `FAILED`...). */
  status: string;
  /** `unresolvedEnv` / dropped invalid env keys the importer recorded for this app (counts). */
  envUnresolved: number;
  envDropped: number;
}

export interface RuntimeDbState {
  itemRef: string;
  name: string | null;
  status: string;
}

export interface RuntimeHostState {
  hostname: string;
  /** The CutoverDomain state machine (`PLANNED`..`VERIFIED`, or a blocked side state). */
  state: string;
  stateful: boolean;
  blockReason: string | null;
}

/** Every provisioned thing of the op and where it stands (all hub-verified). */
export interface RuntimeSnapshot {
  apps: RuntimeAppState[];
  databases: RuntimeDbState[];
  hosts: RuntimeHostState[];
  /** Tasks of the op that did NOT end DONE: itemRef, kind, status, and whether the plan item was skipped on purpose. */
  incomplete: Array<{ itemRef: string; kind: string; status: string }>;
}

export interface RuntimePort {
  snapshot(run: RunSnapshot): Promise<RuntimeSnapshot>;
}

/** The two-box flip plan or the swap plan, reduced to a hash and the hosts it would move. */
export interface FlipPlanLite {
  /** `flip`'s confirm token (two-box) or a deterministic swap-plan digest (swap-proxy); null when it cannot be computed yet. */
  planHash: string | null;
  hosts: string[];
  /** Stateful hosts among them (the data-risk acknowledgement applies when non-empty). */
  statefulHosts: string[];
  /** A fixed reason code when `planHash` is null (nothing READY yet, DNS credential missing...). */
  unavailable: string | null;
}

export interface FlipPlanPort {
  plan(run: RunSnapshot): Promise<FlipPlanLite>;
}

/** Re-discover the source and compare with the plan the run was created from. */
export interface DriftPort {
  /** `unknown` when the session expired or the source is unreachable (the gate then asks to re-enter the token or ack). */
  check(run: RunSnapshot): Promise<{ result: "same" | "changed" | "unknown" }>;
}

// ───────────────────────────── source control (freeze) ─────────────────────────────

/** One recorded source container (identity captured BEFORE any stop, so a restart can verify it is the same one). */
export interface RecordedContainer {
  id: string; // 64 hex
  name: string;
  image: string;
  /** Published ports string as docker prints it (display + identity). */
  ports: string;
  /** The importer itemRef it belongs to. */
  itemRef: string;
}

/** What a freeze touched, written to `compensation` BEFORE the effect. Ids and names only. */
export interface FreezeRecord {
  controller: "manual" | "api" | "agent";
  /** api: the Coolify resources this run asked to stop. */
  api?: Array<{ kind: ApiResourceKind; uuid: string; itemRef: string }>;
  /** agent: the exact containers (identity-checked) this run asked to stop. */
  containers?: RecordedContainer[];
  /** agent: names of stop-list items no container matched, accepted by the operator (the evidence is then operator-attested). */
  unresolved?: string[];
}

export type FreezeOutcome =
  | { ok: true; quiesced: true }
  | { ok: true; quiesced: false; remaining: number }
  | { ok: false; code: string; params?: Record<string, string | number | boolean | null> };

// ───────────────────────────── codes ─────────────────────────────

/** Every code the data steps emit (the web localizes `migrationRun.codes.<code>`). Kept in one place so a typo cannot ship. */
export const DATA_CODES = {
  // generic
  opMissing: "data.op-missing",
  vxDisabled: "data.vx-disabled",
  agentNeedsSameHost: "data.agent-requires-same-host",
  capabilityDenied: "data.migrate-capability-denied",
  capabilityMissingTarget: "data.migrate-target-not-found",
  hubUrlUnknown: "data.hub-url-unknown",
  agentOffline: "data.agent-offline",
  launcherFailed: "data.launcher-failed",
  migratorRunning: "data.migrator-running",
  runMigrator: "data.run-migrator",
  // seed
  seedVolumeNotInspected: "data-seed.volume-not-inspected",
  seedVolumeMissing: "data-seed.volume-source-missing",
  seedDiskInsufficient: "data-seed.disk-insufficient",
  seedDiskUnknown: "data-seed.disk-unknown",
  seedVolumeExcluded: "data-seed.volume-excluded",
  seedPgGate: "data-seed.pg-gate",
  seedWarmDb: "data-seed.warm-db",
  seedObjectsPending: "data-seed.objects-not-seeded",
  seedObjectBlocked: "data-seed.object-blocked",
  seedObjectStartRejected: "data-seed.object-start-rejected",
  seedEstimate: "data-seed.estimate",
  seedObjectGone: "data-seed.object-migration-gone",
  // freeze
  freezeScheduled: "freeze.scheduled",
  freezeStopList: "freeze.stop-list",
  freezeManual: "freeze.stop-source-manually",
  freezeApiUnavailable: "freeze.api-unavailable",
  freezeApiFailed: "freeze.api-stop-failed",
  freezeAgentFailed: "freeze.agent-stop-failed",
  freezeContainerUnresolved: "freeze.container-unresolved",
  freezeContainerMismatch: "freeze.container-identity-mismatch",
  freezeNothingToStop: "freeze.nothing-to-stop",
  freezeQuiesced: "freeze.source-quiesced",
  freezeStillRunning: "freeze.source-still-running",
  freezeAttestation: "freeze.operator-attested",
  freezeRestartManual: "freeze.restart-source-manually",
  freezeRestartFailed: "freeze.restart-failed",
  // final
  finalVolumeNotDone: "data-final.volume-not-copied",
  finalVolumeFailed: "data-final.volume-failed",
  finalVolumeDiverged: "data-final.volume-diverged",
  finalDestDirty: "data-final.dest-dirty",
  finalEntriesMismatch: "data-final.entries-mismatch",
  finalDbNotRestored: "data-final.db-not-restored",
  finalDbFailed: "data-final.db-failed",
  finalDbRestoredDiffers: "data-final.restored-differs",
  finalDbUnsupported: "data-final.db-unsupported",
  finalObjectsNotVerified: "data-final.bucket-not-verified",
  finalObjectDiffers: "data-final.bucket-differs",
  finalPgGate: "data-final.pg-gate",
  finalMigratorExit: "data-final.migrator-exit",
  finalStopSourceManual: "data-final.restart-stopped-source-manually",
  finalObjectsWritersNotFrozen: "data-final.objects-writers-not-frozen",
  finalAwaitVerifyReport: "data-final.awaiting-verify-report",
  finalVerifyReportMissing: "data-final.verify-report-missing",
  // verify
  verifyVolumeParity: "verify.volume-parity",
  verifyPgVersion: "verify.postgres-physical-copy",
  verifyDbParity: "verify.db-logical-parity",
  verifyObjects: "verify.objects",
  verifyRuntimeApp: "verify.app-running",
  verifyRuntimeDb: "verify.database-running",
  verifyHost: "verify.host-ready",
  verifyEnv: "verify.env-carried",
  verifyCoverage: "verify.coverage",
  verifyDrift: "verify.source-drift",
  verifyFlipPlan: "verify.flip-plan",
  verifyEvidenceMissing: "verify.evidence-missing",
  verifyPonr: "verify.ponr-review",
} as const;

// ───────────────────────────── small shared helpers ─────────────────────────────

export const ALL_DATA_STEP_KEYS: readonly StepKey[] = ["DATA_SEED", "FREEZE", "DATA_FINAL", "VERIFY"];

/** A gate that passed, for steps that have nothing to verify. */
export const emptyGate = (): GateResult => ({ passed: true, checks: [] });

// ───────────────────────────── MigrationRunCheck vocabulary ─────────────────────────────

/** The raw source-side measurement the migrator reports (`--verify`), stored as `migrator-reported` evidence. */
export const SOURCE_STATS_CHECK = "source-stats";
/** The approval marker VERIFY writes once a PONR-bound approval was accepted (its evidence carries the bound hash). */
export const VERIFY_APPROVAL_CHECK = "verify-approval";
/** Ordinary verdict rows are capped at 8 KiB of evidence; the raw measurement rows may carry every table (512 KiB). */
export const CHECK_EVIDENCE_MAX_BYTES = 8 * 1024;
export const RAW_EVIDENCE_MAX_BYTES = 512 * 1024;
