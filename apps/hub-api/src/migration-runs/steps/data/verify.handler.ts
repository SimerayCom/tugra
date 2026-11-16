import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import type { ApprovalBinding, DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  PONR_APPROVAL_TTL_SEC,
  STEP_HANDLERS,
  type ActResult,
  type CompResult,
  type CompensateHow,
  type Observation,
  type RunSnapshot,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import {
  CHECK_STORE,
  DATA_CODES,
  DATA_PORT,
  DB_STATS_PORT,
  DRIFT_PORT,
  FLIP_PLAN_PORT,
  OBJECT_PORT,
  RUNTIME_PORT,
  SOURCE_STATS_CHECK,
  VERIFY_APPROVAL_CHECK,
  type CheckStore,
  type DataPort,
  type DataSnapshot,
  type DbStats,
  type DbStatsPort,
  type DriftPort,
  type FlipPlanLite,
  type FlipPlanPort,
  type ObjectPort,
  type ObjectView,
  type RuntimePort,
  type RuntimeSnapshot,
} from "./data-contract";
import { loadObjects, loadSnapshot } from "./handler-util";
import { PARITY_CODES } from "./verify/db-stats";
import { judgeAgainstBaseline } from "./verify/baseline-judge";
import { buildVerifySuite, classifySuite, ponrBindingHash, reportHash, toGateCheck, type SuiteCheck } from "./verify/verify-suite";

/** A target measurement / drift probe younger than this is reused (the run polls every few seconds). */
export const MEASURE_TTL_MS = 10 * 60_000;
/** One tick measures for at most this long; the rest waits for the next tick. */
export const MEASURE_BUDGET_MS = 45_000;
const TARGET_STATS_CHECK = "target-stats";
const DRIFT_CHECK = "source-drift-probe";
const MAX_GATE_CHECKS = 500;
const MAX_ACKABLE = 200;

export interface VerifyObs extends Observation {
  snap: DataSnapshot;
  runtime: RuntimeSnapshot;
  objects: ObjectView[];
  suite: SuiteCheck[];
  report: string;
  flip: FlipPlanLite;
  /** The PONR binding hash; null when the flip/swap plan cannot be computed (the suite then blocks). */
  bindingHash: string | null;
  /** The approval marker VERIFY wrote when an approval was accepted. */
  marker: { boundHash: string; approvalAt: string } | null;
  storedApprovalAt: string | null;
  now: number;
  measuredPending: number;
}

const evidenceOf = (v: unknown): DbStats | undefined => (v && typeof v === "object" && Array.isArray((v as DbStats).tables) ? (v as DbStats) : undefined);

/** Keep every failing/unknown/warn check; fill the rest with passes up to the gate schema's cap. */
function limitChecks(checks: readonly GateCheck[]): GateCheck[] {
  if (checks.length <= MAX_GATE_CHECKS) return [...checks];
  const loud = checks.filter((c) => c.status !== "pass");
  return [...loud, ...checks.filter((c) => c.status === "pass")].slice(0, MAX_GATE_CHECKS);
}

/**
 * VERIFY (approval, the point-of-no-return review): the verification suite, then ONE attended, name-typed approval bound to
 * `H(verifyReportHash || flipPlanHash || statefulHosts)` that expires after 30 minutes (design 4.1 / 10).
 *
 * Every check carries its evidence kind. DB logical parity compares what the migrator reported for the source with what the
 * hub measured on the target. A failing check that no human may accept (lost data, a stopped database, a missing flip plan)
 * blocks; one a human may accept (an unmeasured database, an app that is not running, a source that could not be re-read)
 * is listed in the approval, which must tick it explicitly. The verdicts and the evidence are persisted to
 * `MigrationRunCheck` when the approval is accepted.
 */
@Injectable()
export class VerifyHandler implements StepHandler<VerifyObs>, OnModuleInit {
  readonly key = "VERIFY" as const;
  readonly kind = "approval" as const;
  readonly rollback = "FREE" as const;

  constructor(
    @Inject(STEP_HANDLERS) private readonly registry: StepHandlerRegistry,
    @Inject(DATA_PORT) private readonly data: DataPort,
    @Inject(OBJECT_PORT) private readonly objects: ObjectPort,
    @Inject(RUNTIME_PORT) private readonly runtime: RuntimePort,
    @Inject(DB_STATS_PORT) private readonly stats: DbStatsPort,
    @Inject(FLIP_PLAN_PORT) private readonly flipPlans: FlipPlanPort,
    @Inject(DRIFT_PORT) private readonly drift: DriftPort,
    @Inject(CHECK_STORE) private readonly checks: CheckStore,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  applicable(_run: RunSnapshot): boolean {
    return true;
  }

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    const run = ctx.run;
    return [{ code: "verify.dry.plan", level: "info", params: { rowCountMode: run.options.rowCountMode, topology: run.topology, mode: run.mode, approvalTtlSec: PONR_APPROVAL_TTL_SEC } }];
  }

  // ───────────────────────────── observe ─────────────────────────────

  async observe(ctx: StepContext): Promise<VerifyObs> {
    const run = ctx.run;
    const snap = await loadSnapshot(this.data, ctx);
    const { views, missing } = await loadObjects(this.objects, ctx);
    const runtime = await this.runtime.snapshot(run);
    const flip = await this.flipPlans.plan(run);
    const rows = await this.checks.list(run.id, "VERIFY");
    const sourceStats = new Map<string, DbStats>();
    const sourceAt = new Map<string, number>();
    const targetStats = new Map<string, DbStats>();
    const targetAt = new Map<string, number>();
    let driftRow: { result: "same" | "changed" | "unknown"; at: number } | null = null;
    let marker: VerifyObs["marker"] = null;
    for (const r of rows) {
      if (r.checkId === SOURCE_STATS_CHECK) {
        const s = evidenceOf(r.evidence);
        if (s) {
          sourceStats.set(r.subject, s);
          sourceAt.set(r.subject, r.at.getTime());
        }
      } else if (r.checkId === TARGET_STATS_CHECK) {
        const s = evidenceOf(r.evidence);
        if (s) {
          targetStats.set(r.subject, s);
          targetAt.set(r.subject, r.at.getTime());
        }
      } else if (r.checkId === DRIFT_CHECK) {
        const res = (r.evidence as { result?: string } | null)?.result;
        if (res === "same" || res === "changed" || res === "unknown") driftRow = { result: res, at: r.at.getTime() };
      } else if (r.checkId === VERIFY_APPROVAL_CHECK) {
        const e = r.evidence as { boundHash?: unknown; approvalAt?: unknown } | null;
        if (e && typeof e.boundHash === "string" && typeof e.approvalAt === "string") marker = { boundHash: e.boundHash, approvalAt: e.approvalAt };
      }
    }
    const now = ctx.now().getTime();

    // drift: re-read the source (cached; the source API is not hammered every tick)
    let driftResult: "same" | "changed" | "unknown";
    if (driftRow && now - driftRow.at < MEASURE_TTL_MS) driftResult = driftRow.result;
    else {
      driftResult = (await this.drift.check(run)).result;
      await this.checks.upsert({ runId: run.id, stepKey: "VERIFY", checkId: DRIFT_CHECK, subject: "", status: driftResult === "same" ? "pass" : driftResult === "changed" ? "fail" : "unknown", evidenceKind: "hub-verified", evidence: { result: driftResult }, at: ctx.now() });
    }

    // target statistics: hub-measured, cached per database, re-measured when stale or when the source was re-reported
    const started = Date.now();
    let measuredPending = 0;
    for (const d of snap.databases) {
      if (d.plane === "unsupported" || d.task !== "done") continue;
      const src = sourceStats.get(d.itemRef);
      if (d.plane === "volume" && (!src || src.state !== "measured")) continue;
      const have = targetAt.get(d.itemRef);
      const fresh = have !== undefined && now - have < MEASURE_TTL_MS && have >= (sourceAt.get(d.itemRef) ?? 0);
      if (fresh) continue;
      if (Date.now() - started > MEASURE_BUDGET_MS || ctx.signal.aborted) {
        measuredPending++;
        continue;
      }
      const s = await this.stats.measureTarget(run, d, run.options.rowCountMode);
      targetStats.set(d.itemRef, s);
      targetAt.set(d.itemRef, now);
      await this.checks.upsert({ runId: run.id, stepKey: "VERIFY", checkId: TARGET_STATS_CHECK, subject: d.itemRef, status: s.state === "measured" ? "pass" : "unknown", evidenceKind: "hub-verified", evidence: s as unknown as Record<string, unknown>, at: ctx.now() });
    }

    // R52: a resource that was already failing at the source is a pre-existing warning, a new failure still fails
    const suite = judgeAgainstBaseline(buildVerifySuite({ snap, runtime, objects: views, sourceStats, targetStats, drift: driftResult, flip, runInputs: run.inputs }), run.sourceBaseline).suite;
    for (const id of missing) suite.push({ id: `object-gone:${id.slice(0, 40)}`, checkId: "bucket", subject: id, status: "fail", code: DATA_CODES.seedObjectGone, evidence: "hub-verified" });
    const report = reportHash(suite);
    return {
      snap,
      runtime,
      objects: views,
      suite,
      report,
      flip,
      bindingHash: flip.planHash ? ponrBindingHash(report, flip) : null,
      marker,
      storedApprovalAt: ctx.step.approval?.at ?? null,
      now,
      measuredPending,
      progress: { done: suite.filter((c) => c.status === "pass" || c.status === "warn").length, total: suite.length, unit: "item" },
    };
  }

  // ───────────────────────────── gates ─────────────────────────────

  private gate(ctx: StepContext, obs: VerifyObs): GateResult {
    const acks = new Set(ctx.approval?.acks ?? []);
    const cls = classifySuite(obs.suite, acks);
    const ackedIds = new Set(cls.acked.map((c) => c.id));
    const checks = limitChecks(obs.suite.map((c) => toGateCheck(c, ackedIds.has(c.id))));
    // a human can still decide the ackable ones in the approval: only a check nobody may accept blocks the gate
    const wait = cls.blocked.length ? ({ kind: "operator", code: cls.blocked[0].code, params: { blocked: cls.blocked.length } } as const) : undefined;
    return { passed: cls.blocked.length === 0 && obs.measuredPending === 0, checks, ...(wait ? { wait } : {}) };
  }

  preGate(ctx: StepContext, obs: VerifyObs): GateResult {
    const g = this.gate(ctx, obs);
    if (obs.measuredPending > 0 && !g.wait) return { ...g, wait: { kind: "operator", code: PARITY_CODES.targetUnavailable, params: { pending: obs.measuredPending } } };
    return g;
  }

  async approvalBinding(ctx: StepContext, obs: VerifyObs): Promise<ApprovalBinding | null> {
    if (!obs.bindingHash) return null;
    const cls = classifySuite(obs.suite);
    const ackable = cls.pending.map((c) => c.id).slice(0, MAX_ACKABLE);
    const run = ctx.run;
    return {
      inputHash: obs.bindingHash,
      ponr: true,
      confirm: run.mode === "takeover" ? "target-server+source-host" : "target-server",
      ttlSec: PONR_APPROVAL_TTL_SEC,
      requiresDataRisk: obs.flip.statefulHosts.length > 0,
      ackable,
      requiredAcks: ackable,
      review: {
        checks: obs.suite.length,
        passed: obs.suite.filter((c) => c.status === "pass").length,
        warnings: obs.suite.filter((c) => c.status === "warn").length,
        needsAck: cls.pending.length,
        blocked: cls.blocked.length,
        hosts: obs.flip.hosts.length,
        statefulHosts: obs.flip.statefulHosts.slice(0, 40),
        estimateSec: run.windowEstimate?.freezeToFlipSec ?? null,
        rowCountMode: run.options.rowCountMode,
        topology: run.topology,
      },
    };
  }

  /** Passes only when an approval for THIS exact review was accepted and persisted, and it has not expired. */
  postGate(_ctx: StepContext, obs: VerifyObs): GateResult {
    const m = obs.marker;
    const ok =
      !!m &&
      !!obs.bindingHash &&
      m.boundHash === obs.bindingHash &&
      m.approvalAt === obs.storedApprovalAt &&
      obs.now - new Date(m.approvalAt).getTime() <= PONR_APPROVAL_TTL_SEC * 1000;
    return { passed: ok, checks: [{ id: "ponr-approval", status: ok ? "pass" : "unknown", code: DATA_CODES.verifyPonr }] };
  }

  // ───────────────────────────── act ─────────────────────────────

  async act(ctx: StepContext, obs: VerifyObs): Promise<ActResult> {
    const run = ctx.run;
    const approval = ctx.approval;
    if (!approval || !obs.bindingHash || approval.boundHash !== obs.bindingHash) return { outcome: "fail", code: "verify.approval-stale", retryable: true };
    const cls = classifySuite(obs.suite, new Set(approval.acks));
    if (cls.blocked.length > 0 || cls.pending.length > 0 || obs.measuredPending > 0) {
      return { outcome: "fail", code: "verify.unacknowledged", params: { blocked: cls.blocked.length, pending: cls.pending.length }, retryable: true };
    }
    await ctx.assertLease();
    const ackedIds = new Set(cls.acked.map((c) => c.id));
    for (const c of obs.suite) {
      await this.checks.upsert({
        runId: run.id,
        stepKey: "VERIFY",
        checkId: c.checkId,
        subject: c.subject,
        status: c.status,
        evidenceKind: c.evidence ?? "hub-verified",
        evidence: { code: c.code, ...(c.params ? { params: c.params } : {}), ...(ackedIds.has(c.id) ? { acked: true } : {}) },
      });
    }
    await this.checks.upsert({
      runId: run.id,
      stepKey: "VERIFY",
      checkId: VERIFY_APPROVAL_CHECK,
      subject: "",
      status: "pass",
      evidenceKind: "operator-attested",
      evidence: { boundHash: obs.bindingHash, approvalAt: approval.at, byUserId: approval.byUserId, acks: approval.acks.length, acceptDataRisk: approval.acceptDataRisk, at: ctx.now().toISOString() },
    });
    await ctx.emit({ stepKey: "VERIFY", level: "info", code: "verify.report-persisted", params: { checks: obs.suite.length, acked: cls.acked.length, warnings: obs.suite.filter((c) => c.status === "warn").length } });
    return { outcome: "done" };
  }

  async compensate(_ctx: StepContext, _how: CompensateHow): Promise<CompResult> {
    return { outcome: "nothing-to-do" }; // FREE: a review has nothing to undo (the evidence rows stay as the record)
  }
}
