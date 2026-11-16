import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../../../agent-gateway/agent-gateway.module";
import { ApplicationsModule } from "../../../applications/applications.module";
import { ClustersModule } from "../../../clusters/clusters.module";
import { CutoverModule } from "../../../cutover/cutover.module";
import { NetProbe } from "../../../cutover/net-probe";
import { ImporterModule } from "../../../importer/importer.module";
import { RunImportStepsModule } from "../import/run-import-steps.module";
import { ProxyOpsService } from "../../../server-ops/proxy-ops.service";
import { CutoverHandler } from "./cutover.handler";
import { CutoverPlanService } from "./cutover-plan.service";
import { CutoverWorld } from "./cutover-world.service";
import { DecommissionHandler } from "./decommission.handler";
import { DnsPrepareHandler } from "./dns-prepare.handler";
import { FinalizeHandler } from "./finalize.handler";
import { ObserveHandler } from "./observe.handler";
import { TlsPreissueHandler } from "./tls-preissue.handler";

/**
 * Lane C of the migration runs: DNS_PREPARE, TLS_PREISSUE, CUTOVER (DNS flip or same-host proxy swap), OBSERVE, FINALIZE
 * and the armed, stop-only DECOMMISSION. Each handler registers itself with the global step registry on module init.
 *
 * Reuses the existing services and adds none of its own beyond {@link CutoverWorld} (swap row, agent shell, read-only
 * queries): CutoverService (+ CutoverModule), CutoverCertService (ImporterModule), ApplicationsService, ProxyOpsService
 * (a second, stateless instance: ServerOpsModule does not export its own), and NetProbe (stateless, provided here as
 * CutoverModule does not export it). Prisma, TeamAccess, Audit, Config, InstanceSettings and ProxyConfig are global.
 */
@Module({
  imports: [CutoverModule, ImporterModule, ApplicationsModule, AgentGatewayModule, ClustersModule, RunImportStepsModule],
  providers: [CutoverWorld, NetProbe, ProxyOpsService, CutoverPlanService, DnsPrepareHandler, TlsPreissueHandler, CutoverHandler, ObserveHandler, FinalizeHandler, DecommissionHandler],
  exports: [CutoverPlanService],
})
export class RunCutoverStepsModule {}
