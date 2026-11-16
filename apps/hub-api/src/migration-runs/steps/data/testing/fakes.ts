/**
 * Test doubles for the data steps: a recording `StepContext`, a default `RunSnapshot`, and in-memory implementations of every
 * port (`data-contract.ts`). Behaviour mirrors the real adapters closely enough that a spec exercises the handler's real logic
 * (including crash-resume: the compensation a handler wrote is fed back into the next context).
 */
import { RunLeaseLostError, targetServerFor, targetServerIdsOf, type RunSnapshot, type StepContext, type StepKey, type StepSnapshot, type RunEventInput } from "../../../core/run-contract";
import { OwnerInputsSchema, RunOptionsSchema, type OwnerInputs, type RunOptions, type SourceBaseline, type StepApprovalRecord, type StepProgress, type WaitSpec, type WindowEstimate } from "../../../core/dto";
import type {
  ApiFailure,
  ApiResourceKind,
  ApiState,
  CapabilityPort,
  DataPort,
  DataSnapshot,
  DbDataItem,
  DbMeasureLite,
  DbStats,
  DbStatsPort,
  DriftPort,
  FlipPlanLite,
  FlipPlanPort,
  ObjectPort,
  ObjectView,
  RuntimePort,
  RuntimeSnapshot,
  SourceApiPort,
  VolumeDataItem,
} from "../data-contract";

export const NOW = new Date("2026-11-20T10:00:00.000Z");

export interface RunOverrides {
  options?: Partial<RunOptions>;
  inputs?: OwnerInputs;
  mode?: "copy" | "takeover";
  topology?: "two-box" | "swap-proxy";
  opId?: string | null;
  sourceKind?: "coolify" | "dokploy";
  windowEstimate?: WindowEstimate | null;
  sessionId?: string | null;
  dryRun?: boolean;
  serverMap?: Record<string, string>;
  sourceBaseline?: SourceBaseline | null;
}

export function makeRun(o: RunOverrides = {}): RunSnapshot {
  return {
    id: "cmrun00000001",
    teamId: "team1",
    actorId: "user1",
    targetServerId: "srv-target",
    serverMap: o.serverMap ?? {},
    sourceKind: o.sourceKind ?? "coolify",
    sourceVersion: null,
    campaign: null,
    sourceBaseline: o.sourceBaseline ?? null,
    sourceHost: "coolify.example.com",
    sessionId: o.sessionId === undefined ? "sess1" : o.sessionId,
    opId: o.opId === undefined ? "op1" : o.opId,
    opHistory: [],
    planHash: "0123456789abcdef0123456789abcdef",
    mode: o.mode ?? "copy",
    topology: o.topology ?? "two-box",
    dryRun: o.dryRun ?? false,
    promotedFromId: null,
    applyInput: { sourceKind: o.sourceKind ?? "coolify", targetServerId: "srv-target", planHash: "0123456789abcdef0123456789abcdef" },
    options: RunOptionsSchema.parse(o.options ?? {}),
    // the write gap (N2) is accepted by default in fixtures (the owner default 0 would park every FREEZE spec on the attestation); specs of the gap answer it explicitly
    inputs: OwnerInputsSchema.parse({ tickGapAcceptMinutes: { value: 10_080, source: "request", setBy: "user1", at: NOW.toISOString() }, ...(o.inputs ?? {}) }),
    status: "RUNNING",
    currentStep: null,
    ponrAt: null,
    windowEstimate: o.windowEstimate ?? null,
    freezeStartedAt: null,
    freezeEndedAt: null,
    createdAt: new Date("2026-11-19T10:00:00.000Z"),
  };
}

/** An owner-input record. */
export const answered = <T>(value: T) => ({ value, source: "request" as const, setBy: "user1", at: NOW.toISOString() });

export function stepSnap(key: StepKey, o: Partial<StepSnapshot> = {}): StepSnapshot {
  return { key, status: "PENDING", attempt: 0, gate: null, approval: null, inputHash: null, progress: null, compensation: null, evidence: { attestations: [], attachments: [] }, wait: null, notBefore: null, ...o };
}

export interface CtxHarness {
  ctx: StepContext;
  events: RunEventInput[];
  patches: Array<Record<string, unknown>>;
  comp: Record<string, unknown>;
  progress: StepProgress[];
  /** Mutate to simulate time passing. */
  clock: { now: Date };
  setStep(key: StepKey, s: Partial<StepSnapshot>): void;
  abort(): void;
  lose(): void;
}

export interface CtxOptions {
  run?: RunSnapshot;
  key: StepKey;
  steps?: Partial<Record<StepKey, Partial<StepSnapshot>>>;
  approval?: StepApprovalRecord | null;
  trigger?: StepContext["trigger"];
  now?: Date;
}

/** A recording context. `comp` is the step's compensation JSON: pass `steps[key].compensation` to resume after a "crash". */
export function makeCtx(o: CtxOptions): CtxHarness {
  const run = o.run ?? makeRun();
  const states = new Map<StepKey, StepSnapshot>();
  for (const [k, v] of Object.entries(o.steps ?? {})) states.set(k as StepKey, stepSnap(k as StepKey, v));
  const events: RunEventInput[] = [];
  const patches: Array<Record<string, unknown>> = [];
  const progress: StepProgress[] = [];
  const clock = { now: o.now ?? NOW };
  const ac = new AbortController();
  let lost = false;
  const own = (): StepSnapshot => {
    let s = states.get(o.key);
    if (!s) {
      s = stepSnap(o.key);
      states.set(o.key, s);
    }
    return s;
  };
  const comp: Record<string, unknown> = { ...((own().compensation as Record<string, unknown> | null) ?? {}) };
  const guard = () => {
    if (lost) throw new RunLeaseLostError(run.id);
  };
  const stepState = (k: StepKey): StepSnapshot => {
    const s = states.get(k) ?? stepSnap(k);
    return k === o.key ? { ...s, compensation: { ...comp } } : s;
  };
  const ctx: StepContext = {
    run,
    get step() {
      return stepState(o.key);
    },
    actor: { userId: run.actorId },
    bootId: "boot-1",
    trigger: o.trigger ?? "tick",
    dryRun: run.dryRun,
    approval: o.approval ?? null,
    signal: ac.signal,
    now: () => clock.now,
    targetFor: (ref) => targetServerFor(run, ref),
    targetServerIds: targetServerIdsOf(run),
    stepState,
    assertLease: async () => guard(),
    emit: async (e) => {
      guard();
      events.push(e);
    },
    setProgress: async (p) => {
      guard();
      progress.push(p);
    },
    recordCompensation: async (patch) => {
      guard();
      Object.assign(comp, patch);
    },
    patchRun: async (p) => {
      guard();
      patches.push({ ...p });
    },
    markPonr: async () => {
      throw new Error("markPonr is not legal in a data step");
    },
  };
  return {
    ctx,
    events,
    patches,
    comp,
    progress,
    clock,
    setStep: (k, s) => states.set(k, stepSnap(k, { ...(states.get(k) ?? {}), ...s })),
    abort: () => ac.abort(),
    lose: () => {
      lost = true;
    },
  };
}

// ───────────────────────────── snapshot builders ─────────────────────────────

export const volume = (itemRef: string, o: Partial<VolumeDataItem> = {}): VolumeDataItem => ({
  itemRef,
  destType: "app-volume",
  ownerName: "web",
  excluded: false,
  state: "NONE",
  rawBytesTotal: null,
  rawBytesDone: 0,
  bytesDone: 0,
  bps: null,
  etaSec: null,
  entries: null,
  error: null,
  inventory: null,
  disk: null,
  gates: null,
  ...o,
});

export const inspected = (itemRef: string, bytes = 1024 ** 3, entries = 100, o: Partial<VolumeDataItem> = {}): VolumeDataItem =>
  volume(itemRef, { rawBytesTotal: bytes, inventory: { found: true, rawBytes: bytes, entries, running: true, mountType: "volume" }, disk: { ok: true, unknown: false }, ...o });

export const copied = (itemRef: string, bytes = 1024 ** 3, entries = 100): VolumeDataItem => inspected(itemRef, bytes, entries, { state: "DONE", entries, rawBytesDone: bytes, bytesDone: bytes / 2 });

/** A small, counted dump: under the artifact cap, so the database stays on the standard route. */
export const SMALL_MEASURE: DbMeasureLite = { state: "measured", reason: null, dbBytes: 5_000_000, dumpRawBytes: 4_000_000, dumpGzBytes: 1_000_000, measuredBy: "dump" };
/** A 30 GiB database measured by catalog size only (the dump was not counted): over the cap. */
export const BIG_MEASURE: DbMeasureLite = { state: "measured", reason: null, dbBytes: 34_100_000_000, dumpRawBytes: null, dumpGzBytes: null, measuredBy: "catalog" };

export const database = (itemRef: string, o: Partial<DbDataItem> = {}): DbDataItem => ({ itemRef, dbId: `dbid-${itemRef}`, name: "db", engine: "POSTGRES", plane: "logical", unsupportedReason: null, task: "none", taskFailure: null, finishedAt: null, measure: SMALL_MEASURE, ...o });

export function makeSnap(o: Partial<DataSnapshot> = {}): DataSnapshot {
  return {
    opId: "op1",
    targetServerId: "srv-target",
    vxEnabled: true,
    dumpEnabled: true,
    tokenActive: false,
    tokenExpiresAt: null,
    hubBase: "https://hub.example.com",
    databases: [],
    volumes: [],
    apps: [{ itemRef: "app:srv1:abc", name: "web" }],
    services: [],
    ...o,
  };
}

// ───────────────────────────── ports ─────────────────────────────

export class FakeDataPort implements DataPort {
  snap: DataSnapshot;
  tokens = 0;
  lastToken: string | null = null;
  revoked = 0;
  aborted: string[] = [];
  issueFails = false;
  /** Hook: runs after each snapshot() (lets a test advance the world between ticks). */
  onSnapshot?: (s: DataSnapshot) => void;
  constructor(snap: DataSnapshot = makeSnap()) {
    this.snap = snap;
  }
  async snapshot(): Promise<DataSnapshot> {
    const s = structuredClone(this.snap);
    this.onSnapshot?.(this.snap);
    return s;
  }
  async issueToken(): Promise<{ token: string; expiresAt: Date }> {
    if (this.issueFails) throw new Error("refused");
    this.tokens++;
    this.lastToken = `tugra_mig_${"B".repeat(43)}`;
    this.snap.tokenActive = true;
    return { token: this.lastToken, expiresAt: new Date(NOW.getTime() + 3600_000) };
  }
  async revokeToken(): Promise<void> {
    this.revoked++;
    this.snap.tokenActive = false;
  }
  async abortTransfers(_run: unknown, itemRefs: readonly string[]): Promise<string[]> {
    this.aborted.push(...itemRefs);
    return [...itemRefs];
  }
  /** Databases the run put on the streamed dump lane (the fake flips the snapshot's plane like the real port's next read would). */
  streamed: string[] = [];
  streamRefused = false;
  async enableStream(_run: unknown, dbItemRef: string, on: boolean): Promise<boolean> {
    if (on && this.streamRefused) return false;
    if (on) this.streamed.push(dbItemRef);
    for (const d of this.snap.databases) if (d.itemRef === dbItemRef) d.plane = on ? "stream" : "logical";
    return true;
  }
}

export class FakeObjectPort implements ObjectPort {
  views = new Map<string, ObjectView>();
  calls: string[] = [];
  failStart = false;
  add(v: Partial<ObjectView> & { id: string }): ObjectView {
    const full: ObjectView = { status: "PREFLIGHTED", phase: null, buckets: [{ srcBucket: "media", selected: true, status: "PENDING", diffMissing: null, diffDiffer: null, diffExtra: null }], blockers: 0, cancelRequested: false, ...v };
    this.views.set(v.id, full);
    return full;
  }
  async get(_u: string, id: string): Promise<ObjectView | null> {
    const v = this.views.get(id);
    return v ? structuredClone(v) : null;
  }
  private set(id: string, status: string, bucket: string, phase: "seed" | "final" | null = null): void {
    const v = this.views.get(id)!;
    v.status = status;
    v.phase = phase;
    for (const b of v.buckets) if (b.selected) b.status = bucket;
  }
  async startSeed(_u: string, id: string): Promise<void> {
    this.calls.push(`seed:${id}`);
    if (this.failStart) throw new Error("rejected");
    this.set(id, "SEEDING", "SEEDING", "seed");
  }
  async startFinal(_u: string, id: string): Promise<void> {
    this.calls.push(`final:${id}`);
    if (this.failStart) throw new Error("rejected");
    this.set(id, "FINALIZING", "FINALIZING", "final");
  }
  async verify(_u: string, id: string): Promise<void> {
    this.calls.push(`verify:${id}`);
    this.set(id, "VERIFYING", "FINAL");
  }
  async cancel(_u: string, id: string): Promise<void> {
    this.calls.push(`cancel:${id}`);
    this.set(id, "FAILED", "FAILED");
  }
}

export class FakeSourceApi implements SourceApiPort {
  states = new Map<string, ApiState>();
  calls: string[] = [];
  availability: { ok: true } | { ok: false; reason: ApiFailure } = { ok: true };
  failStop = new Map<string, ApiFailure>();
  failStart = new Map<string, ApiFailure>();
  /** When false a `stop` is accepted but the resource keeps running (a slow stop). */
  stopsTakeEffect = true;
  async available(): Promise<{ ok: true } | { ok: false; reason: ApiFailure }> {
    return this.availability;
  }
  async state(_r: unknown, kind: ApiResourceKind, uuid: string): Promise<{ ok: true; state: ApiState } | { ok: false; reason: ApiFailure }> {
    this.calls.push(`state:${kind}:${uuid}`);
    return { ok: true, state: this.states.get(uuid) ?? "running" };
  }
  async stop(_r: unknown, kind: ApiResourceKind, uuid: string): Promise<{ ok: true } | { ok: false; reason: ApiFailure }> {
    this.calls.push(`stop:${kind}:${uuid}`);
    const f = this.failStop.get(uuid);
    if (f) return { ok: false, reason: f };
    if (this.stopsTakeEffect) this.states.set(uuid, "stopped");
    return { ok: true };
  }
  async start(_r: unknown, kind: ApiResourceKind, uuid: string): Promise<{ ok: true } | { ok: false; reason: ApiFailure }> {
    this.calls.push(`start:${kind}:${uuid}`);
    const f = this.failStart.get(uuid);
    if (f) return { ok: false, reason: f };
    this.states.set(uuid, "running");
    return { ok: true };
  }
}

export class FakeCaps implements CapabilityPort {
  granted = new Set<string>();
  deny = false;
  log: string[] = [];
  async ensureMigrate(): Promise<{ ok: true; added: boolean } | { ok: false; reason: "forbidden" | "not-found" }> {
    if (this.deny) return { ok: false, reason: "forbidden" };
    const had = this.granted.has("migrate");
    this.granted.add("migrate");
    this.log.push(had ? "ensure:had" : "ensure:added");
    return { ok: true, added: !had };
  }
  async releaseMigrate(): Promise<void> {
    this.granted.delete("migrate");
    this.log.push("release");
  }
}

export class FakeRuntime implements RuntimePort {
  rt: RuntimeSnapshot = { apps: [], databases: [], hosts: [], incomplete: [] };
  async snapshot(): Promise<RuntimeSnapshot> {
    return structuredClone(this.rt);
  }
}

export class FakeStats implements DbStatsPort {
  byRef = new Map<string, DbStats>();
  calls: string[] = [];
  delayMs = 0;
  async measureTarget(_r: unknown, db: DbDataItem, mode: "exact" | "estimate"): Promise<DbStats> {
    this.calls.push(db.itemRef);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.byRef.get(db.itemRef) ?? { itemRef: db.itemRef, engine: db.engine, kind: "tables", mode, state: "failed", reason: "verify-exec", tableCount: 0, truncated: false, tables: [] };
  }
}

export class FakeFlip implements FlipPlanPort {
  lite: FlipPlanLite = { planHash: "a".repeat(32), hosts: ["app.example.com"], statefulHosts: ["app.example.com"], unavailable: null };
  async plan(): Promise<FlipPlanLite> {
    return { ...this.lite };
  }
}

export class FakeDrift implements DriftPort {
  result: "same" | "changed" | "unknown" = "same";
  calls = 0;
  async check(): Promise<{ result: "same" | "changed" | "unknown" }> {
    this.calls++;
    return { result: this.result };
  }
}

/** A table-count measurement for specs. */
export const measured = (itemRef: string, tables: Array<[string, number]>, o: Partial<DbStats> = {}): DbStats => ({
  itemRef,
  engine: "POSTGRES",
  kind: "tables",
  mode: "exact",
  state: "measured",
  reason: null,
  tableCount: tables.length,
  truncated: false,
  tables: tables.map(([name, rows]) => ({ name, rows, estimated: false, expires: 0 })),
  ...o,
});

export type { WaitSpec };
