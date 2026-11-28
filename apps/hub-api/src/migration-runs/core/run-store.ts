/**
 * The persistence port of the run engine (P7 lane A). The engine, the service and the recovery loop only talk to this
 * interface; `run-store.prisma.ts` is the production implementation and `testing/run-world.ts` an in-memory one that can
 * also crash on demand (so the engine's crash/resume invariants are specs, not hopes).
 *
 * Authority rules (the same for every implementation):
 *  - A write guarded with `bootId` (an "owned" write) is applied ONLY while `MigrationRun.ownerId === bootId`; otherwise
 *    it throws {@link RunLeaseLostError} (another boot adopted the run, so this process must stop).
 *  - Every other write is a compare-and-set through {@link RunGuard}; `false` means the precondition no longer held.
 */
import type { MigrationRun, MigrationRunEvent, MigrationRunStep } from "@prisma/client";
import type { RunStatus, StepKey, StepStatus } from "./run-contract";

export type RunRow = MigrationRun;
export type StepRow = MigrationRunStep;
export type EventRow = MigrationRunEvent;

/** A new run: every column the creator decides (the rest has its schema default). */
export interface NewRun {
  teamId: string;
  actorId: string;
  targetServerId: string;
  sourceKind: string;
  sourceHost: string | null;
  sessionId: string | null;
  planHash: string;
  mode: string;
  topology: string;
  dryRun: boolean;
  promotedFromId: string | null;
  applyInput: unknown;
  options: unknown;
  inputs: unknown;
  /** `srv:<targetServerId>` (the default target) for a real run (unique), null for a dry-run. */
  activeKey: string | null;
  /** Multi-host placement (source server uuid to target server id); null/absent = single target. */
  serverMap?: Record<string, string> | null;
  /** The source's version string when already known at create time. */
  sourceVersion?: string | null;
  /** An agent-read source: the Tugra server whose agent reads it (null for a token session). */
  agentServerId?: string | null;
  /** An agent-read source: the source team the read is limited to (null: every team). */
  sourceTeamRef?: string | null;
  /** Campaign label. */
  campaign?: string | null;
  /** An in-place takeover run (swap-proxy only). */
  inPlace?: boolean;
  /**
   * Every target server the run locks (the default AND each `serverMap` target), written in the SAME transaction as the run so
   * "one live run per target server" holds for all of them. Empty for a dry-run. Absent = just the `activeKey` server.
   */
  lockServerIds?: readonly string[];
}

export interface NewStep {
  key: StepKey;
  idx: number;
  kind: string;
  rollbackClass: string;
}

/** Writable run columns (JSON columns are `unknown`; the Prisma store maps `null` to SQL NULL). */
export interface RunPatch {
  sourceHost?: string | null;
  sessionId?: string | null;
  opId?: string | null;
  opHistory?: string[];
  status?: RunStatus;
  currentStep?: StepKey | null;
  ponrAt?: Date | null;
  ponrByUserId?: string | null;
  pauseRequested?: boolean;
  abortRequested?: boolean;
  ownerId?: string | null;
  heartbeatAt?: Date | null;
  activeKey?: string | null;
  /**
   * Re-arm helper: with a non-null `activeKey` the store locks exactly these servers (default: just that key's server), in the
   * same transaction as the update; with `activeKey: null` it releases every lock row of the run. Never stored on the run.
   */
  lockServerIds?: readonly string[];
  sourceVersion?: string | null;
  sourceBaseline?: unknown;
  inputs?: unknown;
  windowEstimate?: unknown;
  freezeStartedAt?: Date | null;
  freezeEndedAt?: Date | null;
  failureStep?: StepKey | null;
  failureCode?: string | null;
  report?: unknown;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

/** Writable step columns. */
export interface StepPatch {
  status?: StepStatus;
  attempt?: number;
  gate?: unknown;
  approval?: unknown;
  inputHash?: string | null;
  progress?: unknown;
  compensation?: unknown;
  evidence?: unknown;
  wait?: unknown;
  notBefore?: Date | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  lastError?: string | null;
}

/** Preconditions of a compare-and-set run update. All given conditions must hold. */
export interface RunGuard {
  /** Owned write: `ownerId` must equal this boot id (else RunLeaseLostError). */
  bootId?: string;
  /**
   * The run must be in one of these statuses. Combined with `bootId`, a status miss on a run whose lease is still ours is a
   * plain `false` (a service command such as abort changed the status under the driver), never RunLeaseLostError.
   */
  statusIn?: readonly RunStatus[];
  /** `true`: ponrAt must be null; `false`: must be set. */
  ponrUnset?: boolean;
  /** `ownerId` must be null (never claimed) or differ from this boot id (an orphan). */
  orphanOf?: string;
}

export interface EventInput {
  stepKey: StepKey | null;
  level: "info" | "warn" | "error";
  code: string;
  params: Record<string, unknown> | null;
  actorId: string | null;
}

export interface ListRunsFilter {
  actorId: string;
  teamIds: readonly string[];
  teamId?: string;
  status?: RunStatus;
  live?: boolean;
  campaign?: string;
  limit: number;
}

/** Raised by {@link RunStore.create} (and a re-arming `updateRun`) when a REAL run already holds `activeKey` or ANY of the target servers (one live run per target server). */
export class ServerHasLiveRunError extends Error {
  constructor() {
    super("target server already has a live migration run");
    this.name = "ServerHasLiveRunError";
  }
}

export interface RunStore {
  /** Create the run, its step rows and its server locks atomically. Throws {@link ServerHasLiveRunError} on an `activeKey` or server-lock clash. */
  create(run: NewRun, steps: readonly NewStep[], status: RunStatus): Promise<RunRow>;
  get(id: string): Promise<RunRow | null>;
  steps(runId: string): Promise<StepRow[]>;
  stepsOf(runIds: readonly string[]): Promise<StepRow[]>;
  list(filter: ListRunsFilter): Promise<RunRow[]>;
  /** Non-terminal runs the scheduler must tick (QUEUED excluded: only an explicit start/dry-run kick drives those). */
  drivable(): Promise<RunRow[]>;
  /** Steps of finished takeover runs that a decommission left in flight (re-driven after a hub restart). */
  manualInFlight(): Promise<StepRow[]>;

  /** Compare-and-set run update; `false` when the guard did not hold. An owned guard raises RunLeaseLostError instead. */
  updateRun(id: string, guard: RunGuard, patch: RunPatch): Promise<boolean>;
  /** Step update. `bootId` makes it an owned write (the run's lease must be ours). */
  updateStep(runId: string, key: StepKey, patch: StepPatch, bootId?: string): Promise<void>;
  /** Step update that only applies while the step still has one of `statusIn` (service-side compare-and-set). */
  updateStepIf(runId: string, key: StepKey, statusIn: readonly StepStatus[], patch: StepPatch): Promise<boolean>;

  /** Append an event with the next sequence number; returns the seq. `bootId` makes it an owned write. */
  appendEvent(runId: string, event: EventInput, bootId?: string): Promise<number>;
  events(runId: string, afterSeq: number, limit: number): Promise<EventRow[]>;
  /** The events of one code, oldest first (the run report lists the warnings the run raised). */
  eventsWithCode(runId: string, code: string, limit: number): Promise<EventRow[]>;

  /**
   * Persist `ponrAt` once (monotonic). Applies only while the lease is ours and no abort is in flight. Returns the
   * existing/new instant, or `"abort"` when an abort was requested first (the caller must stop, never flip).
   */
  setPonr(runId: string, bootId: string, at: Date, byUserId: string): Promise<Date | "abort">;
  /** Take (or re-take) the lease: sets ownerId/heartbeatAt when the run is in `statusIn`. Returns the previous owner. */
  claim(runId: string, bootId: string, now: Date, statusIn: readonly RunStatus[]): Promise<{ claimed: boolean; previousOwner: string | null }>;
  heartbeat(runId: string, bootId: string, now: Date): Promise<boolean>;
}
