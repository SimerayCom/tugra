import { Injectable } from "@nestjs/common";
import { CutoverService } from "../../../cutover/cutover.service";
import type { RunSnapshot } from "../../core/run-contract";
import { CutoverWorld } from "./cutover-world.service";
import { swapPlanHash } from "./proxy-swap";
import { inspectSourceProxy } from "./swap-runtime";
import { actionableEntries, cutoverPlanHash, hostIsStateful } from "./run-cutover-logic";

/**
 * The plan the PONR approval is bound to, for VERIFY (lane B) to fold into its `inputHash`
 * (`H(verifyReportHash ‖ planHash ‖ statefulHosts)`): the cutover service's flip-plan hash (two-box) or the swap plan hash
 * (swap-proxy: the exact source proxy that would be stopped + the hosts that move with it), plus the stateful host set.
 * `null` when the plan cannot be computed yet (no import op, the source proxy is unreadable): the approval is then not possible.
 * Read-only: it never writes to a provider or to the host.
 */
@Injectable()
export class CutoverPlanService {
  constructor(
    private readonly cutover: CutoverService,
    private readonly world: CutoverWorld,
  ) {}

  async planHash(run: Pick<RunSnapshot, "id" | "opId" | "actorId" | "topology" | "targetServerId">): Promise<{ planHash: string; statefulHosts: string[] } | null> {
    if (!run.opId) return null;
    const [view, apps] = await Promise.all([this.cutover.view(run.actorId, run.opId), this.world.opApps(run.opId)]);
    const dataApps = new Set(apps.filter((a) => a.hasData).map((a) => a.appId));
    if (run.topology === "swap-proxy") {
      const hosts = actionableEntries(view.entries);
      const ident = await inspectSourceProxy(this.world, run.targetServerId);
      if (!ident.ok) return null;
      const planHash = swapPlanHash({ runId: run.id, serverId: run.targetServerId, proxy: ident.snapshot, hosts: hosts.map((e) => ({ hostname: e.hostname, stateful: hostIsStateful(e, dataApps) })) });
      const statefulHosts = hosts.filter((e) => hostIsStateful(e, dataApps)).map((e) => e.hostname);
      return { planHash: cutoverPlanHash({ topology: run.topology, planHash, statefulHosts }), statefulHosts };
    }
    const plan = await this.cutover.flipPlan(run.actorId, run.opId, {});
    const live = new Set(plan.entries.map((e) => e.hostname));
    const statefulHosts = view.entries.filter((e) => live.has(e.hostname) && hostIsStateful(e, dataApps)).map((e) => e.hostname);
    return { planHash: cutoverPlanHash({ topology: run.topology, planHash: plan.planHash, statefulHosts }), statefulHosts };
  }
}
