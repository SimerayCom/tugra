import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../../../agent-gateway/agent-gateway.module";
import { ApplicationsModule } from "../../../applications/applications.module";
import { DatabasesModule } from "../../../databases/databases.module";
import { DnsModule } from "../../../dns/dns.module";
import { ImporterModule } from "../../../importer/importer.module";
import { RUN_IMPORT } from "../../core/run-ports";
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
  imports: [ImporterModule, ApplicationsModule, DatabasesModule, AgentGatewayModule, DnsModule],
  providers: [
    ImportPortService,
    { provide: IMPORT_STEPS_PORT, useExisting: ImportPortService },
    { provide: RUN_IMPORT, useExisting: ImportPortService },
    PreflightStep,
    ImportStep,
    RemapEnvStep,
    DeployDarkStep,
  ],
  exports: [RUN_IMPORT, IMPORT_STEPS_PORT],
})
export class RunImportStepsModule {}
