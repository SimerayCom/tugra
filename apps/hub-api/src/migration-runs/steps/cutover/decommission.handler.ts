import { Inject, Injectable } from "@nestjs/common";
import type { ApprovalBinding, DryRunItem, GateCheck, GateResult } from "../../core/dto";
import {
  STEP_HANDLERS,
  StepFailure,
  makeGate,
  resolveOwnerInput,
  type ActResult,
  type CompResult,
  type CompensateHow,
  type Observation,
  type RunSnapshot,
  type SourceController,
  type StepContext,
  type StepHandler,
  type StepHandlerRegistry,
} from "../../core/run-contract";
import { CutoverStepBase } from "./cutover-step-base";
import { CutoverWorld } from "./cutover-world.service";
import {
  DECOMMISSION_MAX_CONTAINERS,
  REMOVAL_COMMANDS,
  STOP_COMMANDS,
  buildDecommissionDiscoverScript,
  buildDecommissionStopScript,
  parseDecommissionDiscover,
  parseDecommissionStop,
  removalCommandFor,
  type SourceContainer,
} from "./decommission-script";
import { capHosts, chk, decommissionBindingHash, hasAttestation, timerGate } from "./run-cutover-logic";

export const DECOMMISSION_ATTEST = "decommission.source-stopped";

export interface DecommissionObs extends Observation {
  controller: SourceController;
  /** The hub can stop the containers itself: the Tugra agent runs on the source host (same-host takeover) and the owner did not choose `manual`. */
  hubStops: boolean;
  /** Coolify-managed containers on the host (only when `hubStops`); null = could not be read. */
  containers: SourceContainer[] | null;
  databases: Array<{ databaseId: string; hasSuccess: boolean }>;
  ageHours: number;
}

/**
 * DECOMMISSION (takeover only, armed by its own route, never automatic): retire the source. STOP-ONLY: the hub stops the
 * exact Coolify-managed container ids it discovered and the operator approved, and prints the removal commands. It never
 * runs `docker rm` and never touches a volume. When the hub cannot reach the source host (two-box, or a `manual`
 * controller), it prints the stop and removal commands and waits for the operator's attestation.
 *
 * Preconditions: FINALIZE passed, the run is old enough (`decommissionMinAgeHours`, default 72 h) and every migrated
 * database has at least one successful Tugra backup.
 */
@Injectable()
export class DecommissionHandler extends CutoverStepBase implements StepHandler<DecommissionObs> {
  readonly key = "DECOMMISSION" as const;
  readonly kind = "approval" as const;
  readonly rollback = "IRREVERSIBLE" as const;

  constructor(
    @Inject(STEP_HANDLERS) registry: StepHandlerRegistry,
    private readonly world: CutoverWorld,
  ) {
    super(registry);
  }

  applicable(run: RunSnapshot): boolean {
    return run.mode === "takeover";
  }

  private controllerOf(run: RunSnapshot): SourceController {
    return resolveOwnerInput(run.inputs, "sourceController") ?? "manual";
  }

  /** The hub can stop source containers only where it has a shell on the source host: the same box (swap-proxy). */
  private hubStops(run: RunSnapshot): boolean {
    return run.topology === "swap-proxy" && this.controllerOf(run) !== "manual";
  }

  async dryRun(ctx: StepContext): Promise<DryRunItem[]> {
    const run = ctx.run;
    return [
      { code: "decommission.dry.stop-only", level: "info", params: { controller: this.controllerOf(run), hubStops: this.hubStops(run) } },
      { code: "decommission.dry.min-age", level: "info", params: { hours: run.options.decommissionMinAgeHours } },
    ];
  }

  async observe(ctx: StepContext): Promise<DecommissionObs> {
    const run = ctx.run;
    const hubStops = this.hubStops(run);
    const dbIds = run.opId ? await this.world.opDatabaseIds(run.opId) : [];
    const obs: DecommissionObs = {
      controller: this.controllerOf(run),
      hubStops,
      containers: null,
      databases: await this.world.backupCoverage(dbIds),
      ageHours: (ctx.now().getTime() - run.createdAt.getTime()) / 3_600_000,
    };
    if (hubStops) {
      try {
        obs.containers = parseDecommissionDiscover((await this.world.exec(run.targetServerId, buildDecommissionDiscoverScript(), 60_000)).output);
      } catch {
        obs.containers = null;
      }
    }
    return obs;
  }

  async approvalBinding(ctx: StepContext, obs: DecommissionObs): Promise<ApprovalBinding | null> {
    const run = ctx.run;
    return {
      inputHash: decommissionBindingHash({ runId: run.id, sourceHost: run.sourceHost, containers: (obs.containers ?? []).map((c) => c.id), controller: obs.controller, databases: obs.databases }),
      ponr: false,
      confirm: "source-host",
      ttlSec: null,
      requiresDataRisk: false,
      ackable: [],
      requiredAcks: [],
      review: {
        controller: obs.controller,
        hubStops: obs.hubStops,
        containers: (obs.containers ?? []).map((c) => c.name).slice(0, 200),
        databases: obs.databases.length,
        stopOnly: true,
      },
    };
  }

  preGate(ctx: StepContext, obs: DecommissionObs): GateResult {
    const run = ctx.run;
    const checks: GateCheck[] = [
      chk("decommission.finalized", ctx.stepState("FINALIZE").status === "PASSED" ? "pass" : "fail", "decommission.not-finalized"),
      chk("decommission.source-host", run.sourceHost ? "pass" : "fail", "decommission.no-source-host"),
    ];
    const minAge = run.options.decommissionMinAgeHours;
    const oldEnough = obs.ageHours >= minAge;
    checks.push(chk("decommission.min-age", oldEnough ? "pass" : "fail", "decommission.too-young", oldEnough ? {} : { params: { hours: minAge } }));
    for (const d of obs.databases) checks.push(chk("decommission.backup", d.hasSuccess ? "pass" : "fail", "decommission.no-backup", { subject: d.databaseId, evidence: "hub-verified" }));
    if (obs.hubStops) {
      checks.push(chk("decommission.discover", obs.containers === null ? "unknown" : "pass", "decommission.discover-failed"));
      if (obs.containers && obs.containers.length > DECOMMISSION_MAX_CONTAINERS) checks.push(chk("decommission.too-many", "fail", "decommission.too-many-containers"));
    }
    const until = new Date(run.createdAt.getTime() + minAge * 3_600_000);
    return timerGate(checks, ["decommission.min-age"], oldEnough ? null : until, "decommission.too-young");
  }

  async act(ctx: StepContext, obs: DecommissionObs): Promise<ActResult> {
    const run = ctx.run;
    if (!obs.hubStops) {
      // The hub has no shell on the source host: print the commands, the operator stops it and attests.
      if (hasAttestation(ctx.step.evidence, DECOMMISSION_ATTEST)) return { outcome: "done" };
      return { outcome: "wait", wait: { kind: "operator", code: "decommission.stop-source", params: { stop: [...STOP_COMMANDS], remove: [...REMOVAL_COMMANDS] }, attest: [DECOMMISSION_ATTEST] } };
    }
    const running = (obs.containers ?? []).filter((c) => c.running);
    if (running.length > 0) {
      // The exact ids are recorded BEFORE the stop, so a crash right after still leaves the list the report prints.
      await ctx.recordCompensation({ stoppedIds: running.map((c) => c.id) });
      await ctx.assertLease();
      const st = parseDecommissionStop((await this.world.exec(run.targetServerId, buildDecommissionStopScript(running.map((c) => c.id)), 120_000)).output);
      if (!st) throw new StepFailure("decommission.stop-failed", {}, true);
      const still = running.filter((c) => st[c.id] === true);
      if (still.length > 0) throw new StepFailure("decommission.still-running", { containers: capHosts(still.map((c) => c.name)) }, true);
      await ctx.emit({ stepKey: "DECOMMISSION", level: "info", code: "decommission.stopped", params: { containers: running.length } });
    }
    const names = (obs.containers ?? []).map((c) => c.name);
    await ctx.emit({ stepKey: "DECOMMISSION", level: "info", code: "decommission.removal-commands", params: { commands: [...(removalCommandFor(names) ? [removalCommandFor(names)!] : []), ...REMOVAL_COMMANDS], keepsVolumes: true } });
    return { outcome: "done" };
  }

  postGate(ctx: StepContext, obs: DecommissionObs): GateResult {
    if (!obs.hubStops) return makeGate([chk("decommission.stopped", hasAttestation(ctx.step.evidence, DECOMMISSION_ATTEST) ? "pass" : "fail", "decommission.stop-source", { evidence: "operator-attested" })]);
    if (obs.containers === null) return makeGate([chk("decommission.stopped", "unknown", "decommission.discover-failed")]);
    const running = obs.containers.filter((c) => c.running);
    return makeGate([chk("decommission.stopped", running.length === 0 ? "pass" : "fail", "decommission.still-running", { params: { containers: capHosts(running.map((c) => c.name)) }, evidence: "hub-verified" })]);
  }

  /** Stopping is not undone by the engine (the operator restarts the source themselves); nothing here is deleted either. */
  async compensate(_ctx: StepContext, _how: CompensateHow): Promise<CompResult> {
    return { outcome: "nothing-to-do" };
  }
}
