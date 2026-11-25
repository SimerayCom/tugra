import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../../../agent-gateway/agent-gateway.module";
import { ApplicationsModule } from "../../../applications/applications.module";
import { DatabasesModule } from "../../../databases/databases.module";
import { DnsModule } from "../../../dns/dns.module";
import { ImporterModule } from "../../../importer/importer.module";
import { RUN_IMPORT } from "../../core/run-ports";
import { RunDataStepsModule } from "../data/run-data-steps.module";
import { RunInPlaceStepsModule } from "../inplace/run-inplace-steps.module";
import { PostPonrRelease } from "./baseline/post-ponr";
import { RunSafetyController } from "./baseline/safety.controller";
import { PrismaRunHints, RUN_HINTS } from "./baseline/run-hints";
import { DeployDarkStep } from "./deploy-dark.step";
import { IMPORT_STEPS_PORT } from "./import-ports";
import { ImportPortService } from "./import-port.service";
import { ImportStep } from "./import.step";
import { PreflightStep } from "./preflight.step";
import { RemapEnvStep } from "./remap-env.step";

/**
 * Lane A's step handlers (PREFLIGHT, IMPORT, REMAP_ENV, DEPLOY_DARK). Each handler registers itself with the global step
 * registry on module init; the shared adapter binds the import port to the existing services and also serves the core's
 * `RUN_IMPORT` port.
 */
@Module({
  // RunDataStepsModule exports the host report store PREFLIGHT reads for the inventory cross-check (R2/C6)
  imports: [ImporterModule, ApplicationsModule, DatabasesModule, AgentGatewayModule, DnsModule, RunDataStepsModule, RunInPlaceStepsModule],
  controllers: [RunSafetyController],
  providers: [
    ImportPortService,
    { provide: IMPORT_STEPS_PORT, useExisting: ImportPortService },
    { provide: RUN_IMPORT, useExisting: ImportPortService },
    PrismaRunHints,
    { provide: RUN_HINTS, useExisting: PrismaRunHints },
    PostPonrRelease,
    PreflightStep,
    ImportStep,
    RemapEnvStep,
    DeployDarkStep,
  ],
  exports: [RUN_IMPORT, IMPORT_STEPS_PORT, RUN_HINTS, PostPonrRelease],
})
export class RunImportStepsModule {}
