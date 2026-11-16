import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../../prisma/prisma.service";
import { CutoverService } from "../../../../cutover/cutover.service";
import type { RunSnapshot } from "../../../core/run-contract";
import type { FlipPlanLite, FlipPlanPort } from "../data-contract";
import { canonicalJson, sha256Hex } from "../data-logic";

/**
 * The plan the point-of-no-return approval is bound to.
 *  - two-box: `CutoverService.flipPlan` (the exact DNS record diff per READY host); its `planHash` is the very confirm token
 *    `flip` will demand, so an approval can never be reused for a different diff.
 *  - swap-proxy: there is no DNS write; the plan is the set of hosts the proxy swap will start serving from Tugra, digested
 *    from the cutover host rows (hostname, state, stateful) and the target server.
 * `unavailable` carries a fixed code when the plan cannot be computed yet (never the service's message).
 */
@Injectable()
export class CutoverFlipPlans implements FlipPlanPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cutover: CutoverService,
  ) {}

  async plan(run: RunSnapshot): Promise<FlipPlanLite> {
    if (!run.opId) return { planHash: null, hosts: [], statefulHosts: [], unavailable: "no-op" };
    const rows = await this.prisma.cutoverDomain.findMany({ where: { opId: run.opId }, select: { hostname: true, state: true, stateful: true }, orderBy: { hostname: "asc" } });
    const stateful = rows.filter((r) => r.stateful).map((r) => r.hostname);
    if (run.topology === "swap-proxy") {
      const hosts = rows.map((r) => r.hostname);
      return { planHash: sha256Hex(canonicalJson({ topology: "swap-proxy", server: run.targetServerId, hosts: rows.map((r) => [r.hostname, r.state, r.stateful]) })), hosts, statefulHosts: stateful, unavailable: null };
    }
    try {
      const plan = await this.cutover.flipPlan(run.actorId, run.opId, {});
      const hosts = plan.entries.map((e) => e.hostname);
      const set = new Set(stateful);
      return { planHash: plan.planHash, hosts, statefulHosts: hosts.filter((h) => set.has(h)), unavailable: null };
    } catch {
      return { planHash: null, hosts: [], statefulHosts: [], unavailable: "flip-plan-error" };
    }
  }
}
