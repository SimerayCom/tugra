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
import { CutoverStepBase, rethrowLeaseLost } from "./cutover-step-base";
import { CutoverWorld } from "./cutover-world.service";
import {
  CONTROL_PLANE_REMOVAL_COMMANDS,
  CONTROL_PLANE_STOP_COMMANDS,
  DECOMMISSION_MAX_CONTAINERS,
  MANAGED_REMOVAL_COMMANDS,
  MANAGED_STOP_COMMANDS,
  buildDecommissionDiscoverScript,
  buildDecommissionStopScript,
  parseControlPlaneMarker,
  parseDecommissionDiscover,
  parseDecommissionStop,
  removalCommandFor,
  type SourceContainer,
} from "./decommission-script";
import { capHosts, chk, decommissionBindingHash, hasAttestation, timerGate } from "./run-cutover-logic";

export const DECOMMISSION_ATTEST = "decommission.source-stopped";
/**
 * The operator stopped the containers of the FIRST list (the managed hosts, without the control plane's own containers). It only
 * settles the step while other runs of the source are still to come: once they are all done the control plane's list is asked for
 * again, so the host that goes last is never closed by an attestation that did not cover it.
 */
export const DECOMMISSION_FIRST_ATTEST = "decommission.managed-stopped";

export interface DecommissionObs extends Observation {
  controller: SourceController;
  /** The hub can stop the containers itself: the Tugra agent runs on the source host (same-host takeover) and the owner did not choose `manual`. */
  hubStops: boolean;
  /** Coolify-managed containers on the host (only when `hubStops`); null = could not be read. */
  containers: SourceContainer[] | null;
  databases: Array<{ databaseId: string; hasSuccess: boolean }>;
  ageHours: number;
  /** This box carries the Coolify control plane itself; null = the hub has no shell here to see (a manual controller or a two-box run), which is NOT "no". */
  controlPlane: boolean | null;
  /** The other real runs of the same source: how many still move production and how many finished without stopping their own hosts; null = unreadable. */
  siblings: { live: number; undecommissioned: number } | null;
}

/**
 * DECOMMISSION (takeover only, armed by its own route, never automatic): retire the source. STOP-ONLY: the hub stops the
 * exact Coolify-managed container ids it discovered and the operator approved, and prints the removal commands. It never
 * runs `docker rm` and never touches a volume. When the hub cannot reach the source host (two-box, or a `manual`
 * controller), it prints the stop and removal commands and waits for the operator's attestation.
 *
 * Preconditions: FINALIZE passed, the run is old enough (`decommissionMinAgeHours`, default 72 h) and every migrated
 * database has at least one successful Tugra backup.
 *
 * The runbook order (R67/R70): the remote hosts are stopped team by team, and the Coolify host, which carries the control plane
 * and the telemetry the apps still send to it, goes LAST. A box that carries the control plane is refused while any other run of
 * the same source still lives; where the hub cannot see the box, the control-plane commands are simply not printed until none does.
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
      { code: "decommission.dry.order", level: "info" },
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
      controlPlane: null,
      siblings: null,
    };
    try {
      obs.siblings = await this.world.siblingRuns({ id: run.id, teamId: run.teamId, actorId: run.actorId, sourceKind: run.sourceKind, sourceHost: run.sourceHost, serverMap: run.serverMap, sourceBaseline: run.sourceBaseline });
    } catch (e) {
      rethrowLeaseLost(e);
      obs.siblings = null;
    }
    if (hubStops) {
      try {
        const out = (await this.world.exec(run.targetServerId, buildDecommissionDiscoverScript(), 60_000)).output;
        obs.containers = parseDecommissionDiscover(out);
        obs.controlPlane = parseControlPlaneMarker(out);
      } catch (e) {
        rethrowLeaseLost(e);
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
        controlPlane: obs.controlPlane,
        otherLiveRuns: obs.siblings?.live ?? null,
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
    checks.push(...this.orderChecks(obs));
    const until = new Date(run.createdAt.getTime() + minAge * 3_600_000);
    return timerGate(checks, ["decommission.min-age"], oldEnough ? null : until, "decommission.too-young");
  }

  /**
   * The runbook order (R67/R70). A box the hub SEES carrying the control plane is refused while another run of the source lives, and
   * says so when other finished runs have not stopped their hosts yet; a box the hub cannot see only gets the warning (the order is
   * then kept by the printed commands, see {@link controlPlaneNow}). An unreadable sibling list is unknown, never "none".
   */
  private orderChecks(obs: DecommissionObs): GateCheck[] {
    if (obs.controlPlane === false) return [];
    const out: GateCheck[] = [];
    const sib = obs.siblings;
    if (obs.controlPlane === true) {
      if (sib === null) out.push(chk("decommission.control-plane-last", "unknown", "decommission.siblings-unreadable"));
      else if (sib.live > 0) out.push(chk("decommission.control-plane-last", "fail", "decommission.control-plane-last", { params: { runs: sib.live }, evidence: "hub-verified" }));
      else if (sib.undecommissioned > 0) out.push(chk("decommission.control-plane-last", "fail", "decommission.control-plane-last-hosts", { params: { runs: sib.undecommissioned }, evidence: "hub-verified" }));
      else out.push(chk("decommission.control-plane-last", "pass", "decommission.control-plane-last-ok", { evidence: "hub-verified" }));
    } else if (sib && sib.undecommissioned > 0) {
      out.push(chk("decommission.hosts-pending", "warn", "decommission.hosts-pending", { params: { runs: sib.undecommissioned }, evidence: "hub-verified" }));
    }
    return out;
  }

  /**
   * May the printed commands include the control plane's own containers? Only when the other runs of the source are known and none
   * still lives or is waiting to stop its own hosts: a finished takeover that has not decommissioned its hosts is not done yet.
   */
  private controlPlaneNow(obs: DecommissionObs): boolean {
    return obs.siblings !== null && obs.siblings.live === 0 && obs.siblings.undecommissioned === 0;
  }

  /** The code and params of the first list: with the sibling list unreadable it says so, instead of a count it does not have. */
  private firstListWait(obs: DecommissionObs): { code: string; params: Record<string, string[] | number> } {
    const params = { stop: [...MANAGED_STOP_COMMANDS], remove: [...MANAGED_REMOVAL_COMMANDS] };
    if (obs.siblings === null) return { code: "decommission.stop-source-unknown", params };
    return { code: "decommission.stop-source-first", params: { ...params, runs: obs.siblings.live + obs.siblings.undecommissioned } };
  }

  async act(ctx: StepContext, obs: DecommissionObs): Promise<ActResult> {
    const run = ctx.run;
    const withControlPlane = this.controlPlaneNow(obs);
    if (!obs.hubStops) {
      // The hub has no shell on the source host: print the commands, the operator stops it and attests.
      if (hasAttestation(ctx.step.evidence, DECOMMISSION_ATTEST)) return { outcome: "done" };
      // The hub cannot tell whether this host carries the control plane, so the control plane's commands stay out of the list
      // until no other run of this source is open: the Coolify host is last, whichever host this run is for. An attestation of the
      // first list closes the step only while that still holds; once the others are done the full list is asked for.
      if (!withControlPlane) {
        // Only while another run of the source is KNOWN to be open: an unreadable sibling list never settles the step on the first
        // list, or a run that was in fact the last one would close without the control plane's commands ever being printed.
        const settles = obs.siblings !== null;
        if (settles && hasAttestation(ctx.step.evidence, DECOMMISSION_FIRST_ATTEST)) return { outcome: "done" };
        const first = this.firstListWait(obs);
        return { outcome: "wait", wait: { kind: "operator", code: first.code, params: first.params, ...(settles ? { attest: [DECOMMISSION_FIRST_ATTEST] } : {}) } };
      }
      return { outcome: "wait", wait: { kind: "operator", code: "decommission.stop-source", params: { stop: [...MANAGED_STOP_COMMANDS, ...CONTROL_PLANE_STOP_COMMANDS], remove: [...MANAGED_REMOVAL_COMMANDS, ...CONTROL_PLANE_REMOVAL_COMMANDS] }, attest: [DECOMMISSION_ATTEST] } };
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
    await ctx.emit({ stepKey: "DECOMMISSION", level: "info", code: "decommission.removal-commands", params: { commands: [...(removalCommandFor(names) ? [removalCommandFor(names)!] : []), ...MANAGED_REMOVAL_COMMANDS, ...(withControlPlane ? CONTROL_PLANE_REMOVAL_COMMANDS : [])], keepsVolumes: true } });
    return { outcome: "done" };
  }

  postGate(ctx: StepContext, obs: DecommissionObs): GateResult {
    if (!obs.hubStops) {
      const first = !this.controlPlaneNow(obs);
      const full = hasAttestation(ctx.step.evidence, DECOMMISSION_ATTEST);
      const firstOnly = !full && first && obs.siblings !== null && hasAttestation(ctx.step.evidence, DECOMMISSION_FIRST_ATTEST);
      // Settling on the first list leaves the control plane owed. The other runs may all be aborted before any of them reaches this
      // step, and then nobody prints its commands: the passed gate carries them, on this run, which is the one place left to read them.
      if (firstOnly) {
        return makeGate([chk("decommission.stopped", "pass", "decommission.control-plane-owed", { params: { stop: [...CONTROL_PLANE_STOP_COMMANDS], remove: [...CONTROL_PLANE_REMOVAL_COMMANDS] }, evidence: "operator-attested" })]);
      }
      const attested = full;
      if (first) {
        const w = this.firstListWait(obs);
        return makeGate([chk("decommission.stopped", attested ? "pass" : "fail", w.code, { params: w.params, evidence: "operator-attested" })]);
      }
      return makeGate([chk("decommission.stopped", attested ? "pass" : "fail", "decommission.stop-source", { params: { stop: [...MANAGED_STOP_COMMANDS, ...CONTROL_PLANE_STOP_COMMANDS] }, evidence: "operator-attested" })]);
    }
    if (obs.containers === null) return makeGate([chk("decommission.stopped", "unknown", "decommission.discover-failed")]);
    const running = obs.containers.filter((c) => c.running);
    return makeGate([chk("decommission.stopped", running.length === 0 ? "pass" : "fail", "decommission.still-running", { params: { containers: capHosts(running.map((c) => c.name)) }, evidence: "hub-verified" })]);
  }

  /** Stopping is not undone by the engine (the operator restarts the source themselves); nothing here is deleted either. */
  async compensate(_ctx: StepContext, _how: CompensateHow): Promise<CompResult> {
    return { outcome: "nothing-to-do" };
  }
}
