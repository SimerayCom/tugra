/**
 * An in-memory world for the run core specs (P7 lane A), in the spirit of `app-moves/testing/fake-world.ts`: a stateful
 * in-memory {@link RunStore} that can kill a "process" at any persisted write, a fake clock, fake env/sink ports, a scripted
 * import port (ops, tasks, apps, databases, deployments) and configurable pass-through handlers for the steps other lanes
 * own. Every external side effect of a handler lands in `world.effects` / `world.port.calls`, so the specs assert on
 * observable state and ordering instead of mock call counts, and the crash specs can prove "each effect at most once".
 *
 * Lanes B and C can build on it: register their real handlers with `world.registry` (or keep the stubs for the steps they
 * do not own) and drive them through the real engine and service.
 */
import { ConflictException, ForbiddenException, HttpException, NotFoundException } from "@nestjs/common";
import type { ImportApplyInput, ImportMappingResolveInput, RemoteSourceKind } from "../../../importer/dto";
import type { ImportPlanResponse } from "../../../importer/importer.service";
import type { ResolvedMapping } from "../../../importer/import-mapping";
import type { ServicePreview } from "../../../importer/service-preview";
import type { RollbackOptions } from "../../../importer/import-executor.service";
import { DeployDarkStep } from "../../steps/import/deploy-dark.step";
import { ImportStep } from "../../steps/import/import.step";
import type { DeploymentRef, ImportStepsPort, OpSnapshot, OpTask, RemapApplyResult, RemapSummary, ResourceState, SessionState, TargetFacts } from "../../steps/import/import-ports";
import { InMemoryRunHints } from "../../steps/import/baseline/run-hints";
import { PreflightStep } from "../../steps/import/preflight.step";
import { RemapEnvStep } from "../../steps/import/remap-env.step";
import { MigrationRunsService } from "../migration-runs.service";
import type { ApprovalBinding, CreateMigrationRunInput, DryRunItem, GateResult, RunReport } from "../dto";
import {
  RunLeaseLostError,
  STEP_KEYS,
  STEP_MANIFEST,
  isStepKey,
  makeGate,
  type ActResult,
  type AnyStepHandler,
  type CompResult,
  type CompensateHow,
  type Observation,
  type RunActor,
  type RunStatus,
  type StepContext,
  type StepHandler,
  type StepKey,
  type StepStatus,
} from "../run-contract";
import { RunEngineService } from "../run-engine.service";
import { RunRecoveryService } from "../run-recovery.service";
import type { RunEnvPort, RunImportPort, RunNotification, RunSessionInfo, RunSinkPort } from "../run-ports";
import { applyScope, resolveScope } from "../run-scope";
import { openWarnings } from "../dry-run-warnings";
import {
  ServerHasLiveRunError,
  type EventInput,
  type EventRow,
  type ListRunsFilter,
  type NewRun,
  type NewStep,
  type RunGuard,
  type RunPatch,
  type RunRow,
  type RunStore,
  type StepPatch,
  type StepRow,
} from "../run-store";
import { StepHandlerRegistryService } from "../step-handler.registry";

// ───────────────────────────── clock ─────────────────────────────

export class TestClock {
  t = Date.parse("2026-11-23T08:00:00.000Z");
  sleeps = 0;
  now(): Date {
    return new Date(this.t);
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps += 1;
    if (this.sleeps > 20_000) throw new Error("TestClock: runaway sleep loop");
    this.t += ms;
    // yield to the event loop (not just the microtask queue): a polling handler must not starve timers, I/O or the spec itself
    await new Promise<void>((r) => setImmediate(r));
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

// ───────────────────────────── store ─────────────────────────────

/** Thrown by a store whose "process" was killed: the driver that issued the write is gone. */
export class CrashError extends Error {
  constructor() {
    super("process crashed");
    this.name = "CrashError";
  }
}

const clone = <T>(v: T): T => {
  if (v === null || typeof v !== "object") return v;
  if (Object.prototype.toString.call(v) === "[object Date]") return new Date((v as unknown as Date).getTime()) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => clone(x)) as unknown as T;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, clone(x)])) as T;
};

/**
 * A stateful in-memory {@link RunStore}. `killAfterOwnedWrites(n, bootId)` marks `bootId` dead right BEFORE its n-th owned
 * write is applied: that write (and every later write of that boot) throws {@link CrashError}, exactly like a hub process
 * that died between two statements. Writes of other boots and the service's compare-and-set writes are unaffected.
 */
export class InMemoryRunStore implements RunStore {
  readonly runs = new Map<string, RunRow>();
  readonly stepRows = new Map<string, StepRow[]>();
  readonly eventRows: EventRow[] = [];
  /** Server locks (server id to run id): the in-memory twin of `MigrationRunServerLock`. */
  readonly serverLocks = new Map<string, string>();
  /** Every owned write, in order (label = `table.field,...`): the crash specs enumerate these boundaries. */
  ownedWrites = 0;
  private killAt: { n: number; bootId: string } | null = null;
  private readonly dead = new Set<string>();
  private seq = 0;
  /** Writes outside the run's own rows would be recorded here by a spy; the store itself only has run rows. */
  constructor(private readonly clock: TestClock) {}

  killAfterOwnedWrites(n: number, bootId: string): void {
    this.killAt = { n, bootId };
    this.ownedWrites = 0;
  }
  isDead(bootId: string): boolean {
    return this.dead.has(bootId);
  }

  private owned(bootId?: string): void {
    if (!bootId) return;
    if (this.dead.has(bootId)) throw new CrashError();
    this.ownedWrites += 1;
    if (this.killAt && this.killAt.bootId === bootId && this.ownedWrites >= this.killAt.n) {
      this.dead.add(bootId);
      this.killAt = null;
      throw new CrashError();
    }
  }

  private run(id: string): RunRow {
    const r = this.runs.get(id);
    if (!r) throw new Error(`run ${id} not found`);
    return r;
  }

  private checkLease(id: string, bootId?: string): void {
    if (!bootId) return;
    const r = this.runs.get(id);
    if (!r || r.ownerId !== bootId) throw new RunLeaseLostError(id);
  }

  async create(run: NewRun, steps: readonly NewStep[], status: RunStatus): Promise<RunRow> {
    if (run.activeKey && [...this.runs.values()].some((r) => r.activeKey === run.activeKey)) throw new ServerHasLiveRunError();
    const locks = [...new Set(run.lockServerIds ?? (run.activeKey ? [run.activeKey.replace(/^srv:/, "")] : []))];
    if (locks.some((sid) => this.serverLocks.has(sid))) throw new ServerHasLiveRunError();
    const id = `run-${++this.seq}`;
    for (const sid of locks) this.serverLocks.set(sid, id);
    const now = this.clock.now();
    const row: RunRow = {
      id,
      teamId: run.teamId,
      actorId: run.actorId,
      targetServerId: run.targetServerId,
      serverMap: run.serverMap && Object.keys(run.serverMap).length ? (clone(run.serverMap) as never) : null,
      sourceKind: run.sourceKind,
      sourceHost: run.sourceHost,
      sourceVersion: run.sourceVersion ?? null,
      agentServerId: run.agentServerId ?? null,
      sourceTeamRef: run.sourceTeamRef ?? null,
      sourceBaseline: null,
      campaign: run.campaign ?? null,
      sessionId: run.sessionId,
      opId: null,
      opHistory: [],
      planHash: run.planHash,
      mode: run.mode,
      topology: run.topology,
      inPlace: run.inPlace === true,
      dryRun: run.dryRun,
      promotedFromId: run.promotedFromId,
      applyInput: clone(run.applyInput) as never,
      options: clone(run.options) as never,
      inputs: clone(run.inputs) as never,
      status,
      currentStep: null,
      ponrAt: null,
      ponrByUserId: null,
      pauseRequested: false,
      abortRequested: false,
      ownerId: null,
      heartbeatAt: null,
      activeKey: run.activeKey,
      eventSeq: 0,
      windowEstimate: null,
      freezeStartedAt: null,
      freezeEndedAt: null,
      failureStep: null,
      failureCode: null,
      report: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };
    this.runs.set(id, row);
    this.stepRows.set(
      id,
      steps.map((s) => ({
        runId: id,
        key: s.key,
        idx: s.idx,
        kind: s.kind,
        status: "PENDING",
        rollbackClass: s.rollbackClass,
        attempt: 0,
        gate: null,
        approval: null,
        inputHash: null,
        progress: null,
        compensation: null,
        evidence: null,
        wait: null,
        notBefore: null,
        startedAt: null,
        finishedAt: null,
        lastError: null,
      })),
    );
    return clone(row);
  }

  async get(id: string): Promise<RunRow | null> {
    const r = this.runs.get(id);
    return r ? clone(r) : null;
  }
  async steps(runId: string): Promise<StepRow[]> {
    return clone([...(this.stepRows.get(runId) ?? [])].sort((a, b) => a.idx - b.idx));
  }
  async stepsOf(runIds: readonly string[]): Promise<StepRow[]> {
    return runIds.flatMap((id) => clone(this.stepRows.get(id) ?? []));
  }
  async list(f: ListRunsFilter): Promise<RunRow[]> {
    const live: RunStatus[] = ["QUEUED", "RUNNING", "WAITING", "PAUSED", "ABORTING", "ROLLING_BACK", "REVERSING", "FAILED"];
    return [...this.runs.values()]
      .filter((r) => r.actorId === f.actorId && (f.teamId ? r.teamId === f.teamId && f.teamIds.includes(f.teamId) : f.teamIds.includes(r.teamId)) && (!f.status || r.status === f.status) && (!f.live || live.includes(r.status as RunStatus)) && (!f.campaign || r.campaign === f.campaign))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, f.limit)
      .map(clone);
  }
  async drivable(): Promise<RunRow[]> {
    return [...this.runs.values()].filter((r) => ["RUNNING", "WAITING", "ABORTING", "ROLLING_BACK", "REVERSING"].includes(r.status)).map(clone);
  }
  async manualInFlight(): Promise<StepRow[]> {
    return [...this.stepRows.entries()].flatMap(([runId, rows]) =>
      this.runs.get(runId)?.status === "COMPLETED" ? rows.filter((s) => s.key === "DECOMMISSION" && ["RUNNING", "WAITING_OPERATOR", "WAITING_APPROVAL", "WAITING_TIMER"].includes(s.status)).map(clone) : [],
    );
  }

  async updateRun(id: string, guard: RunGuard, patch: RunPatch): Promise<boolean> {
    this.owned(guard.bootId);
    const r = this.runs.get(id);
    const leaseOk = !!r && (!guard.bootId || r.ownerId === guard.bootId);
    const ok =
      !!r &&
      leaseOk &&
      (!guard.statusIn || guard.statusIn.includes(r.status as RunStatus)) &&
      (guard.ponrUnset === undefined || (guard.ponrUnset ? r.ponrAt === null : r.ponrAt !== null)) &&
      (!guard.orphanOf || r.ownerId === null || r.ownerId !== guard.orphanOf);
    if (!ok) {
      if (guard.bootId && !(leaseOk && guard.statusIn)) throw new RunLeaseLostError(id);
      return false;
    }
    if (patch.activeKey && [...this.runs.values()].some((x) => x.id !== id && x.activeKey === patch.activeKey)) throw new ServerHasLiveRunError();
    if (patch.activeKey !== undefined) {
      // mirrors the Prisma store: the lock rows move with `activeKey` in one step
      const wanted = patch.activeKey ? [...new Set(patch.lockServerIds ?? [patch.activeKey.replace(/^srv:/, "")])] : [];
      if (wanted.some((sid) => this.serverLocks.has(sid) && this.serverLocks.get(sid) !== id)) throw new ServerHasLiveRunError();
      for (const [sid, rid] of [...this.serverLocks]) if (rid === id) this.serverLocks.delete(sid);
      for (const sid of wanted) this.serverLocks.set(sid, id);
    }
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && k !== "lockServerIds") (r as unknown as Record<string, unknown>)[k] = clone(v);
    r!.updatedAt = this.clock.now();
    return true;
  }

  async updateStep(runId: string, key: StepKey, patch: StepPatch, bootId?: string): Promise<void> {
    this.owned(bootId);
    this.checkLease(runId, bootId);
    const s = (this.stepRows.get(runId) ?? []).find((x) => x.key === key);
    if (!s) throw new Error(`step ${key} not found`);
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = clone(v);
  }

  async updateStepIf(runId: string, key: StepKey, statusIn: readonly StepStatus[], patch: StepPatch): Promise<boolean> {
    const s = (this.stepRows.get(runId) ?? []).find((x) => x.key === key);
    if (!s || !statusIn.includes(s.status as StepStatus)) return false;
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = clone(v);
    return true;
  }

  async appendEvent(runId: string, e: EventInput, bootId?: string): Promise<number> {
    this.owned(bootId);
    this.checkLease(runId, bootId);
    const r = this.run(runId);
    r.eventSeq += 1;
    this.eventRows.push({ runId, seq: r.eventSeq, at: this.clock.now(), stepKey: e.stepKey, level: e.level, code: e.code, params: clone(e.params) as never, actorId: e.actorId });
    return r.eventSeq;
  }

  async events(runId: string, afterSeq: number, limit: number): Promise<EventRow[]> {
    return this.eventRows.filter((e) => e.runId === runId && e.seq > afterSeq).slice(0, limit).map(clone);
  }

  async setPonr(runId: string, bootId: string, at: Date, byUserId: string): Promise<Date | "abort"> {
    this.owned(bootId);
    this.checkLease(runId, bootId);
    const r = this.run(runId);
    if (r.ponrAt) return r.ponrAt;
    if (r.abortRequested || !["RUNNING", "WAITING"].includes(r.status)) return "abort";
    r.ponrAt = at;
    r.ponrByUserId = byUserId;
    return at;
  }

  async claim(runId: string, bootId: string, now: Date, statusIn: readonly RunStatus[]): Promise<{ claimed: boolean; previousOwner: string | null }> {
    if (this.dead.has(bootId)) throw new CrashError();
    const r = this.runs.get(runId);
    if (!r) return { claimed: false, previousOwner: null };
    const previousOwner = r.ownerId;
    if (!statusIn.includes(r.status as RunStatus)) return { claimed: false, previousOwner };
    r.ownerId = bootId;
    r.heartbeatAt = now;
    return { claimed: true, previousOwner };
  }

  async heartbeat(runId: string, bootId: string, now: Date): Promise<boolean> {
    const r = this.runs.get(runId);
    if (!r || r.ownerId !== bootId) return false;
    r.heartbeatAt = now;
    return true;
  }

  // ── inspection helpers ──
  row(id: string): RunRow {
    return clone(this.run(id));
  }
  step(id: string, key: StepKey): StepRow {
    return clone((this.stepRows.get(id) ?? []).find((s) => s.key === key)!);
  }
  statusOf(id: string): RunStatus {
    return this.run(id).status as RunStatus;
  }
  stepStatus(id: string, key: StepKey): StepStatus {
    return this.step(id, key).status as StepStatus;
  }
  codes(id: string): string[] {
    return this.eventRows.filter((e) => e.runId === id).map((e) => e.code);
  }
  /** Force a column (specs simulate "another boot owns this run" / an old heartbeat). */
  force(id: string, patch: Partial<RunRow>): void {
    Object.assign(this.run(id), patch);
  }
}

// ───────────────────────────── env, sink ─────────────────────────────

export const ACTOR: RunActor = { userId: "u1", scopes: ["*"], channel: "session" };
export const TEAM = "t1";
export const SERVER = "srv1";
export const H32 = "d".repeat(32);

export class FakeEnv implements RunEnvPort {
  teams = [TEAM];
  perms: Record<string, { member: boolean; appsConfig: boolean; databases: boolean }> = {};
  serversById = new Map<string, { id: string; name: string; teamId: string; status?: string; capabilities?: string[] }>([[SERVER, { id: SERVER, name: "tugra-box", teamId: TEAM }]]);
  sessions = new Map<string, RunSessionInfo>();
  objectMigrations = new Map<string, { id: string; teamId: string; createdById: string }>();
  connects: Array<{ baseUrl: string; teamId: string }> = [];
  private n = 0;
  constructor(private readonly clock: TestClock) {
    this.sessions.set("s1", this.session0("s1"));
  }
  session0(id: string): RunSessionInfo {
    return { id, teamId: TEAM, sourceKind: "coolify", baseUrl: "https://coolify.example.com", scopeKey: "", host: "coolify.example.com", state: "active", expiresAt: new Date(this.clock.t + 3_600_000) };
  }
  async teamIds(): Promise<string[]> {
    return this.teams;
  }
  async standing(userId: string, teamId: string) {
    return this.perms[`${userId}|${teamId}`] ?? { member: this.teams.includes(teamId), appsConfig: true, databases: true };
  }
  async server(id: string) {
    return this.serversById.get(id) ?? null;
  }
  async servers(ids: readonly string[]) {
    return new Map(ids.flatMap((id) => (this.serversById.has(id) ? [[id, this.serversById.get(id)!.name] as [string, string]] : [])));
  }
  async session(_u: string, id: string) {
    const s = this.sessions.get(id);
    if (!s) return null;
    return { ...s, state: s.state === "active" && s.expiresAt.getTime() <= this.clock.t ? ("expired" as const) : s.state };
  }
  async connectSession(_u: string, input: { teamId: string; sourceKind: RemoteSourceKind; baseUrl: string; token: string; scopeLabel?: string }) {
    this.connects.push({ baseUrl: input.baseUrl, teamId: input.teamId });
    const id = `s-new-${++this.n}`;
    const expiresAt = new Date(this.clock.t + 3_600_000);
    this.sessions.set(id, { ...this.session0(id), baseUrl: input.baseUrl, expiresAt });
    return { sessionId: id, expiresAt };
  }
  async objectMigration(id: string) {
    return this.objectMigrations.get(id) ?? null;
  }
}

export class FakeSink implements RunSinkPort {
  audits: Array<{ actor: string; action: string; target: string; meta?: Record<string, unknown> }> = [];
  notes: RunNotification[] = [];
  async audit(e: { actor: string; action: string; target: string; meta?: Record<string, unknown> }) {
    this.audits.push(e);
  }
  async notify(_t: string, n: RunNotification) {
    this.notes.push(n);
  }
}

// ───────────────────────────── scripted import port ─────────────────────────────

interface FakeTask extends OpTask {
  /** the fan-out progress counter of a PENDING task */
  stage?: number;
}
interface FakeOp {
  id: string;
  userId: string;
  serverId: string;
  createdAt: number;
  tasks: FakeTask[];
  rolledBack: boolean;
  cancelRequested: boolean;
  /** the in-process fan-out is alive (dies with the "process") */
  alive: boolean;
  /** polls survived by a RUNNING task of a dead driver before the importer's stale reaper settles it */
  staleReapIn: number;
  planItems: OpSnapshot["planItems"];
  remap: boolean;
}

export interface FakeResource {
  id: string;
  name: string;
  status: string;
}

/** A plan with two apps (one stateless), one database and one skipped service. */
export function defaultPlan(overrides: Partial<ImportPlanResponse> = {}): ImportPlanResponse {
  return {
    sourceKind: "coolify",
    mode: "copy",
    items: [
      { itemRef: "database:_:db1", kind: "database", name: "pg-main", proposed: { engine: "POSTGRES" }, risks: [], dependsOn: [] },
      { itemRef: "app:_:web", kind: "app", name: "web", proposed: { domain: "web.example.com" }, risks: [], dependsOn: ["database:_:db1"] },
      { itemRef: "app:_:static", kind: "app", name: "static-site", proposed: { domain: "static.example.com" }, risks: [], dependsOn: [] },
    ],
    totals: { apps: 2, databases: 1, volumes: 0, blockers: 0 },
    warnings: [],
    planHash: H32,
    preflight: { databases: [{ name: "pg-main", engine: "POSTGRES", dataPlane: "one-click", reason: "" }], services: [], appsWithVolumeData: 0 },
    ...overrides,
  } as ImportPlanResponse;
}

export class ScriptedImportPort implements ImportStepsPort {
  /** everything the world was asked to do, in order (reads excluded): `apply`, `cancel:<op>`, `rollback:<op>`, `deploy:<app>:<key>` ... */
  calls: string[] = [];
  /** every call, reads included, to prove a dry-run reads only. */
  reads: string[] = [];
  plan_: ImportPlanResponse = defaultPlan();
  session: SessionState = "active";
  target_: TargetFacts = { serverName: "tugra-box", agentOnline: true, capabilities: ["deploy", "database", "backup"], acmeEmailOk: true, proxyBind: "public", dnsCredential: false, zones: [] };
  storedMapping = false;
  mappingResult: ResolvedMapping | null = null;
  services: ServicePreview[] = [];
  ops = new Map<string, FakeOp>();
  apps = new Map<string, FakeResource>();
  dbs = new Map<string, FakeResource>();
  deploys: Array<DeploymentRef & { appId: string }> = [];
  /** itemRefs whose task FAILs when the fan-out reaches them (consumed once, so a re-apply succeeds) */
  failItems = new Set<string>();
  /** itemRef -> git link status reported on the task (e.g. `needs_source`) */
  gitStatus = new Map<string, string>();
  failDeployApps = new Set<string>();
  /** deploys stay QUEUED (the app is not RUNNING yet) until {@link settleDeploys}: `apps.deploy` only enqueues in production */
  queueDeploys = false;
  /** deployments that run (not just queue) when queued, and cannot be cancelled: a build in flight */
  runQueued = false;
  failApplyWith: HttpException | null = null;
  failStartDb = new Set<string>();
  remapPlan_: RemapSummary = { planHash: "e".repeat(64), appsToWrite: 1, needsManualKeys: 0, needsManualApps: 0 };
  remapFailed = 0;
  remapPendingBy = new Map<string, boolean>();
  remapNothing = false;
  /** What the source reports as its version (null = it reports none); `throwVersion` makes the read fail. */
  version_: string | null = null;
  throwVersion = false;
  private n = 0;
  constructor(private readonly clock: TestClock) {}

  /** The "process" died: every fan-out stops, RUNNING tasks are orphaned. */
  killProcess(): void {
    for (const op of this.ops.values()) op.alive = false;
  }

  async sessionState(): Promise<SessionState> {
    this.reads.push("sessionState");
    return this.session;
  }
  async plan(): Promise<ImportPlanResponse> {
    this.reads.push("plan");
    return this.plan_;
  }
  async sourceVersion(): Promise<string | null> {
    this.reads.push("sourceVersion");
    if (this.throwVersion) throw new Error("source unreachable");
    return this.version_;
  }

  /** Opt-in: a spec sets it to answer the create-time swap placement checks; unset = the port cannot tell (the checks are skipped). */
  sourceHosts?: RunImportPort["sourceHosts"];

  async planHash(): Promise<string> {
    this.reads.push("planHash");
    return this.plan_.planHash;
  }
  /** The last scope request the service made (what the real port would resolve against the live plan). */
  scopeCalls: Array<Parameters<NonNullable<ScriptedImportPort["scopeApply"]>>[1]> = [];
  async scopeApply(_u: string, i: Parameters<NonNullable<RunImportPort["scopeApply"]>>[1]): ReturnType<NonNullable<RunImportPort["scopeApply"]>> {
    this.reads.push("scopeApply");
    this.scopeCalls.push(i);
    const r = resolveScope(this.plan_, i.scope);
    if ("fail" in r) return { ok: false, code: r.fail };
    const { mapping, serviceChoices } = applyScope(this.plan_, r.inScope, { ...(i.serviceChoices ? { serviceChoices: i.serviceChoices } : {}) });
    return { ok: true, mapping, mappingHash: "f".repeat(32), ...(serviceChoices ? { serviceChoices } : {}), kept: r.kept, excluded: r.excluded };
  }
  /** Opt-in: a spec sets it to answer the create-time rebuild check; unset = the port cannot tell (shape only). */
  appRefs?: RunImportPort["appRefs"];

  /** What the source-agent check answers (default: every source server has an online agent). */
  agentGaps: { gaps: Array<{ ref: string; name: string; state: "no_agent" | "offline" }>; unverified: boolean } = { gaps: [], unverified: false };
  agentGapCalls: Array<Parameters<NonNullable<RunImportPort["sourceAgentGaps"]>>[1]> = [];
  async sourceAgentGaps(_u: string, i: Parameters<NonNullable<RunImportPort["sourceAgentGaps"]>>[1]): ReturnType<NonNullable<RunImportPort["sourceAgentGaps"]>> {
    this.reads.push("sourceAgentGaps");
    this.agentGapCalls.push(i);
    return this.agentGaps;
  }
  async resolveMapping(_u: string, _i: ImportMappingResolveInput): Promise<ResolvedMapping> {
    this.reads.push("resolveMapping");
    if (!this.mappingResult) throw new Error("no mapping");
    return this.mappingResult;
  }
  async storedMappingExists(): Promise<boolean> {
    this.reads.push("storedMappingExists");
    return this.storedMapping;
  }
  async previewServices(): Promise<ServicePreview[]> {
    this.reads.push("previewServices");
    return this.services;
  }
  async target(_u?: string, _i?: { serverId: string; dnsCredentialId?: string; hosts: readonly string[] }): Promise<TargetFacts> {
    this.reads.push("target");
    return this.target_;
  }

  async apply(userId: string, input: ImportApplyInput): Promise<{ opId: string }> {
    if (this.failApplyWith) throw this.failApplyWith;
    const serverId = (input as { targetServerId: string }).targetServerId;
    const inflight = [...this.ops.values()].find((o) => o.serverId === serverId && o.tasks.some((t) => t.status === "PENDING" || t.status === "RUNNING"));
    if (inflight) throw new ConflictException("an import for this server is already in progress");
    const id = `op-${++this.n}`;
    this.calls.push("apply");
    const already = new Set([...this.ops.values()].filter((o) => o.serverId === serverId && !o.rolledBack).flatMap((o) => o.tasks.filter((t) => t.status === "DONE" && t.resourceId).map((t) => t.itemRef)));
    const tasks: FakeTask[] = this.plan_.items
      .filter((i) => i.kind === "app" || i.kind === "database")
      .map((i) => ({ itemRef: i.itemRef, kind: i.kind, status: already.has(i.itemRef) ? "SKIPPED" : "PENDING", resourceType: null, resourceId: null, name: i.name, gitStatus: null, stage: 0 }));
    this.ops.set(id, {
      id,
      userId,
      serverId,
      createdAt: this.clock.t,
      tasks,
      rolledBack: false,
      cancelRequested: false,
      alive: true,
      staleReapIn: 2,
      planItems: this.plan_.items.map((i) => ({ itemRef: i.itemRef, kind: i.kind, dependsOn: i.dependsOn })),
      remap: false,
    });
    return { opId: id };
  }

  /** One fan-out step: PENDING -> RUNNING -> DONE (or FAILED). A dead fan-out stops; its RUNNING tasks are reaped after a while. */
  private advance(op: FakeOp): void {
    for (const t of op.tasks) {
      if (t.status === "PENDING" && op.alive && !op.cancelRequested) {
        t.status = "RUNNING";
      } else if (t.status === "RUNNING" && op.alive) {
        if (this.failItems.has(t.itemRef ?? "")) {
          this.failItems.delete(t.itemRef ?? "");
          t.status = "FAILED";
        } else {
          t.status = "DONE";
          t.resourceType = t.kind === "database" ? "database" : "application";
          t.gitStatus = this.gitStatus.get(t.itemRef ?? "") ?? null;
          t.resourceId = `${t.kind}-${++this.n}`;
          const map = t.kind === "database" ? this.dbs : this.apps;
          map.set(t.resourceId, { id: t.resourceId, name: t.name ?? "", status: "NEW" });
        }
      } else if (t.status === "RUNNING" && !op.alive) {
        if (--op.staleReapIn <= 0) t.status = "FAILED"; // the importer's stale-RUNNING reaper
      }
    }
  }

  async opSnapshot(_u: string, opId: string): Promise<OpSnapshot> {
    this.reads.push(`opSnapshot:${opId}`);
    const op = this.ops.get(opId);
    if (!op) throw new Error("op not found");
    this.advance(op);
    return { id: op.id, rolledBack: op.rolledBack, cancelRequested: op.cancelRequested, tasks: op.tasks.map((t) => ({ ...t })), planItems: op.planItems };
  }
  async opsSince(_u: string, serverId: string, since: Date): Promise<string[]> {
    this.reads.push("opsSince");
    return [...this.ops.values()].filter((o) => o.serverId === serverId && o.createdAt >= since.getTime()).map((o) => o.id);
  }
  async cancelOp(_u: string, opId: string): Promise<void> {
    this.calls.push(`cancel:${opId}`);
    const op = this.ops.get(opId)!;
    op.cancelRequested = true;
    for (const t of op.tasks) if (t.status === "PENDING") t.status = "CANCELLED";
  }
  async rollbackOp(_u: string, opId: string, opts: RollbackOptions): Promise<void> {
    this.calls.push(`rollback:${opId}${opts.runOwnedDeployments ? ":run-owned" : ""}${opts.includeData ? ":data" : ""}`);
    const op = this.ops.get(opId)!;
    if (op.tasks.some((t) => t.status === "PENDING" || t.status === "RUNNING")) throw new ConflictException("the import is still running");
    op.rolledBack = true;
    for (const t of op.tasks) {
      if (t.status !== "DONE" || !t.resourceId) continue;
      const hasData = t.resourceType === "database" && this.dbs.get(t.resourceId)?.status !== "NEW";
      const foreignDeploy = t.resourceType === "application" && this.deploys.some((d) => d.appId === t.resourceId && !(opts.runOwnedDeployments && d.key.startsWith(`migrun:${opts.runOwnedDeployments.runId}:`)));
      if (foreignDeploy || (hasData && !(opts.includeData && opts.dataConfirmNames?.includes(t.name ?? "")))) continue;
      (t.resourceType === "database" ? this.dbs : this.apps).delete(t.resourceId);
      t.status = "ROLLED_BACK";
    }
  }
  async opItems(): Promise<RunReport["items"]> {
    return [];
  }
  /** What the report's data section shows; a spec sets it to prove the report carries it (and the markdown prints it). */
  dataIntegrity: RunReport["dataIntegrity"] = [];
  async opDataIntegrity(): Promise<RunReport["dataIntegrity"]> {
    return this.dataIntegrity;
  }
  async mintCommand(_u: string, opId: string, _b: string, o: { reissue: boolean; certs: boolean }) {
    this.calls.push(`mint:${opId}:${o.reissue ? "reissue" : "mint"}`);
    return { expiresAt: new Date(this.clock.t + 3_600_000), command: "curl -fsSL https://hub.example.com/m.sh | sh -s -- TOKEN" };
  }

  async remapPending(_u: string, opId: string): Promise<boolean> {
    this.reads.push("remapPending");
    return this.remapPendingBy.get(opId) === true;
  }
  async remapPlan(): Promise<RemapSummary> {
    this.reads.push("remapPlan");
    if (this.remapNothing) throw new ConflictException("the import provisioned no resources to migrate data into");
    return this.remapPlan_;
  }
  async remapApply(_u: string, opId: string, token: string): Promise<RemapApplyResult> {
    this.calls.push(`remapApply:${opId}`);
    if (token !== this.remapPlan_.planHash) throw new ConflictException("the plan has changed since you reviewed it");
    this.remapPendingBy.set(opId, true);
    return { applied: this.remapFailed === 0, failed: this.remapFailed, linkFailed: 0 };
  }
  async remapUndo(_u: string, opId: string): Promise<boolean> {
    this.calls.push(`remapUndo:${opId}`);
    this.remapPendingBy.set(opId, false);
    return true;
  }

  async appState(_u: string, id: string): Promise<ResourceState> {
    this.reads.push("appState");
    const a = this.apps.get(id);
    return a ? { exists: true, status: a.status, name: a.name } : { exists: false, status: "NEW", name: null };
  }
  async dbState(_u: string, id: string): Promise<ResourceState> {
    this.reads.push("dbState");
    const d = this.dbs.get(id);
    return d ? { exists: true, status: d.status, name: d.name } : { exists: false, status: "NEW", name: null };
  }
  async startDb(_u: string, id: string): Promise<ResourceState> {
    this.calls.push(`startDb:${id}`);
    const d = this.dbs.get(id)!;
    d.status = this.failStartDb.has(id) ? "FAILED" : "RUNNING";
    return { exists: true, status: d.status, name: d.name };
  }
  async stopDb(_u: string, id: string): Promise<void> {
    this.calls.push(`stopDb:${id}`);
    this.dbs.get(id)!.status = "STOPPED";
  }
  async stopApp(_u: string, id: string): Promise<void> {
    this.calls.push(`stopApp:${id}`);
    this.apps.get(id)!.status = "STOPPED";
  }
  async deployments(appId: string, prefix: string): Promise<DeploymentRef[]> {
    this.reads.push("deployments");
    return this.deploys.filter((d) => d.appId === appId && d.key.startsWith(prefix)).map(({ appId: _a, ...d }) => d);
  }
  async deploy(userId: string, appId: string, key: string): Promise<DeploymentRef | null> {
    const prior = this.deploys.find((d) => d.appId === appId && d.key === key);
    if (prior) return prior;
    this.calls.push(`deploy:${appId}:${key}`);
    if (!this.apps.has(appId)) throw new ForbiddenException("nope");
    const failed = this.failDeployApps.has(appId);
    const queued = this.queueDeploys && !failed;
    const d = { appId, id: `dep-${++this.n}`, key, status: failed ? "FAILED" : queued ? (this.runQueued ? "RUNNING" : "QUEUED") : "SUCCESS", trigger: "manual", requestedBy: userId };
    this.deploys.push(d);
    if (failed) this.failDeployApps.delete(appId);
    else if (!queued) this.apps.get(appId)!.status = "RUNNING";
    return d;
  }
  async cancelDeployment(_u: string, appId: string, depId: string): Promise<void> {
    const d = this.deploys.find((x) => x.appId === appId && x.id === depId);
    if (!d) throw new NotFoundException("deployment not found");
    if (d.status !== "QUEUED") throw new ConflictException("this deployment can't be cancelled");
    this.calls.push(`cancelDeploy:${depId}`);
    d.status = "CANCELLED";
  }
  /** The queue drains: every queued/running (not cancelled) deployment finishes and its app comes up. */
  settleDeploys(): void {
    for (const d of this.deploys) {
      if (d.status !== "QUEUED" && d.status !== "RUNNING") continue;
      d.status = "SUCCESS";
      this.apps.get(d.appId)!.status = "RUNNING";
    }
  }
}

// ───────────────────────────── pass-through handlers for the other lanes' steps ─────────────────────────────

/** Scripted behaviour of one stand-in step. */
export interface StubScript {
  /** Gate checks block (operator wait) until this returns true. Default: never blocked. */
  blocked?: (w: RunWorld) => boolean;
  /** A custom pre-gate (a check with its own params and attestable ids); wins over `blocked` when it returns a gate. */
  gate?: (w: RunWorld) => GateResult | null;
  /** An approval binding shown until approved. */
  binding?: (w: RunWorld, ctx: StepContext) => ApprovalBinding | null;
  /** Act hook; default is "do the effect and finish". */
  act?: (w: RunWorld, ctx: StepContext) => Promise<ActResult | void>;
  /** The effect label recorded in `world.effects`. */
  effect?: string;
  compensate?: (w: RunWorld, ctx: StepContext, how: CompensateHow) => Promise<CompResult>;
  applicable?: (ctx: { mode: string; topology: string }) => boolean;
}

/** A stand-in for a step another lane owns: observe-then-act over `world.done`, recording its effects. */
export class StubStep implements StepHandler<Observation & { done: boolean }> {
  readonly kind: StepHandler["kind"];
  readonly rollback: StepHandler["rollback"];
  readonly skippable?: boolean;
  constructor(
    readonly key: StepKey,
    private readonly w: RunWorld,
    private readonly script: StubScript = {},
  ) {
    this.kind = STEP_MANIFEST[key].kind;
    this.rollback = STEP_MANIFEST[key].rollback;
    this.skippable = STEP_MANIFEST[key].skippable === true;
  }
  applicable(run: { mode: string; topology: string }): boolean {
    return this.script.applicable ? this.script.applicable(run) : true;
  }
  async dryRun(): Promise<DryRunItem[]> {
    this.w.dryRuns.push(this.key);
    return [{ code: `stub.${this.key.toLowerCase().replace(/_/g, "-")}`, level: "info" }];
  }
  async observe(): Promise<Observation & { done: boolean }> {
    return { done: this.w.done.has(`${this.key}`) };
  }
  preGate(): GateResult {
    const custom = this.script.gate?.(this.w);
    if (custom) return custom;
    return this.script.blocked?.(this.w) ? makeGate([{ id: `${this.key}.blocked`, status: "fail", code: "stub.blocked" }], { wait: { kind: "operator", code: "stub.blocked" } }) : makeGate([]);
  }
  async approvalBinding(ctx: StepContext): Promise<ApprovalBinding | null> {
    return this.script.binding ? this.script.binding(this.w, ctx) : null;
  }
  async act(_ctx: StepContext): Promise<ActResult> {
    const r = await this.script.act?.(this.w, _ctx);
    if (r) return r;
    this.w.effects.push(this.script.effect ?? `act:${this.key}`);
    this.w.done.add(this.key);
    return { outcome: "done" };
  }
  postGate(_ctx: StepContext, obs: Observation & { done: boolean }): GateResult {
    return makeGate(obs.done ? [] : [{ id: `${this.key}.pending`, status: "fail", code: "stub.pending" }]);
  }
  async compensate(ctx: StepContext, how: CompensateHow): Promise<CompResult> {
    this.w.compensations.push(`${this.key}:${how}`);
    if (this.script.compensate) return this.script.compensate(this.w, ctx, how);
    return how === "abort" && this.rollback === "UNDOABLE" && this.w.done.has(this.key) ? { outcome: "done" } : { outcome: "nothing-to-do" };
  }
}

// ───────────────────────────── the world ─────────────────────────────

export interface WorldOptions {
  /** Register lane A's real handlers over the scripted port (default true). */
  laneA?: boolean;
  /** Stand-ins for the other lanes' steps. Default: all of them, passing straight through. */
  stubs?: Partial<Record<StepKey, StubScript>>;
  /** Which stand-ins to register (default: every key lane A does not own). */
  stubKeys?: readonly StepKey[];
  /** Let the service's fire-and-forget `kick` start engine passes by itself (default false: specs drive with `settle`/`tick`, which keeps them deterministic). */
  autoKick?: boolean;
}

let bootSeq = 0;

export class RunWorld {
  readonly clock = new TestClock();
  readonly store = new InMemoryRunStore(this.clock);
  readonly env = new FakeEnv(this.clock);
  readonly sink = new FakeSink();
  readonly port = new ScriptedImportPort(this.clock);
  /** the run hints (accepted warnings, pins) the service reads when it promotes a dry-run */
  readonly hints = new InMemoryRunHints();
  /** the effects of stand-in steps, in order (e.g. `flip`) */
  readonly effects: string[] = [];
  readonly done = new Set<string>();
  readonly compensations: string[] = [];
  readonly dryRuns: StepKey[] = [];
  registry!: StepHandlerRegistryService;
  engine!: RunEngineService;
  service!: MigrationRunsService;
  recovery!: RunRecoveryService;
  bootId!: string;
  readonly opts: WorldOptions;

  constructor(opts: WorldOptions = {}) {
    this.opts = opts;
    this.boot();
  }

  /** (Re)start "the hub process": a fresh registry/engine/service/recovery with a NEW boot id over the same store and world. */
  boot(): void {
    this.bootId = `boot-${++bootSeq}`;
    this.registry = new StepHandlerRegistryService();
    const laneA: AnyStepHandler[] = [];
    if (this.opts.laneA !== false) {
      laneA.push(new PreflightStep(this.registry, this.port), new ImportStep(this.registry, this.port), new RemapEnvStep(this.registry, this.port), new DeployDarkStep(this.registry, this.port));
      for (const h of laneA) (h as unknown as { onModuleInit(): void }).onModuleInit();
    }
    const stubKeys = this.opts.stubKeys ?? STEP_KEYS.filter((k) => this.opts.laneA === false || STEP_MANIFEST[k].lane !== "A");
    for (const k of stubKeys) this.registry.register(new StubStep(k, this, this.opts.stubs?.[k]));
    this.engine = new RunEngineService(this.store, this.registry, { bootId: this.bootId } as never, this.env, this.sink);
    this.engine.clock = this.clock;
    this.engine.options = { heartbeatMs: 0 };
    if (!this.opts.autoKick) this.engine.kick = () => undefined;
    this.service = new MigrationRunsService(this.store, this.engine, this.registry, this.env, this.sink, this.port, undefined, undefined, this.hints);
    this.recovery = new RunRecoveryService(this.store, this.engine, this.sink);
  }

  /** The process dies: the old engine is dropped, fan-outs stop, then a new boot starts. */
  restart(): void {
    this.port.killProcess();
    this.boot();
  }

  createBody(over: Partial<CreateMigrationRunInput> = {}): CreateMigrationRunInput {
    return {
      sessionId: "s1",
      sourceKind: "coolify",
      targetServerId: SERVER,
      planHash: H32,
      mode: "copy",
      topology: "two-box",
      dryRun: false,
      options: { ttlPolicy: "wait", deployWaves: "single", warmDbSeed: false, stopSource: false, sourceRunner: "operator", certs: "none", acceptHttp01Gap: false, observeMinutes: 30, manualFinalize: false, batchSize: 5, intervalSec: 30, rowCountMode: "estimate", decommissionMinAgeHours: 72, stuckOperatorMinutes: 60 },
      inputs: {},
      ...over,
    } as CreateMigrationRunInput;
  }

  /** Create a run through the service (and start it unless it is a dry-run, which the service kicks itself). */
  async create(over: Partial<CreateMigrationRunInput> = {}, actor: RunActor = ACTOR): Promise<string> {
    const v = await this.service.create(actor, this.createBody(over));
    return v.id;
  }

  /** The operator's "Accept all" on a finished dry-run: every open warning is accepted, so the spec can promote it. */
  async acceptWarnings(id: string): Promise<string[]> {
    const keys = openWarnings(await this.store.steps(id), await this.hints.list(id));
    await this.hints.upsert(id, keys.map((key) => ({ kind: "warning-ack" as const, key, scope: "", value: "accepted", evidence: "operator-attested" as const })));
    return keys;
  }

  async start(id: string, actor: RunActor = ACTOR): Promise<void> {
    await this.service.start(actor, id, {});
  }

  /** Drive the run on the current boot until it parks (awaits the engine pass the service kicked). */
  async settle(id: string, trigger: "tick" | "recover" | "retry" | "approve" = "tick"): Promise<void> {
    await this.engine.drive(id, trigger);
    // a second pass lets a kick that raced the first one finish too
    await this.engine.drive(id, "tick");
  }

  /** Create, start and drive to the first park. */
  async run(over: Partial<CreateMigrationRunInput> = {}): Promise<string> {
    const id = await this.create(over);
    await this.start(id);
    await this.settle(id);
    return id;
  }

  async view(id: string, actor: RunActor = ACTOR) {
    return this.service.get(actor, id);
  }
  status(id: string): RunStatus {
    return this.store.statusOf(id);
  }
  stepStatus(id: string, key: StepKey): StepStatus {
    return this.store.stepStatus(id, key);
  }
  /** Fire `n` recovery ticks (the periodic loop), draining the passes they start. */
  async tick(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) await this.recovery.tick(this.clock.now());
  }
  /** Approve whatever the run's current step is waiting for, typing `confirmName`. */
  async approveCurrent(id: string, extra: { acks?: string[]; confirmName?: string; acceptDataRisk?: boolean } = {}): Promise<void> {
    const v = await this.view(id);
    if (v.nextAction.kind !== "approval" || !v.nextAction.approval || !v.nextAction.stepKey) throw new Error(`run is not waiting for an approval: ${v.nextAction.kind}`);
    const b = v.nextAction.approval;
    await this.service.approve(ACTOR, id, v.nextAction.stepKey, { boundHash: b.inputHash, acks: extra.acks ?? b.requiredAcks, ...(extra.confirmName ? { confirmName: extra.confirmName } : {}), ...(extra.acceptDataRisk ? { acceptDataRisk: true } : {}) });
  }
}

export { isStepKey };
