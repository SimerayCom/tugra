import { Module } from "@nestjs/common";
import { ApplicationsModule } from "../applications/applications.module";
import { CoolifyInPlaceModule } from "../coolify-inplace/coolify-inplace.module";
import { ImporterModule } from "../importer/importer.module";
import { MigrationRunsController } from "./migration-runs.controller";
import { MigrationRunsService } from "./core/migration-runs.service";
import { MIGRATION_RUNS_FACADE } from "./core/run-contract";
import { RunEngineService } from "./core/run-engine.service";
import { RunEnvService, RunSinkService } from "./core/run-env.service";
import { RUN_ENV, RUN_SINK, RUN_STORE } from "./core/run-ports";
import { RunRecoveryService } from "./core/run-recovery.service";
import { PrismaRunStore } from "./core/run-store.prisma";
import { StepRegistryModule } from "./core/step-registry.module";
import { RunCutoverStepsModule } from "./steps/cutover/run-cutover-steps.module";
import { RunDataStepsModule } from "./steps/data/run-data-steps.module";
import { RunImportStepsModule } from "./steps/import/run-import-steps.module";

/**
 * One-click migration orchestrator (P7). `MigrationRun` sits above the importer's op; the step handlers live in lane
 * modules that register with the global step registry (lane A: the import side; lanes B and C: data and cutover).
 * The facade the controller (and the MCP tools) call is the real service; the engine drives runs under a boot-id lease and
 * `RunRecoveryService` re-drives them after a restart.
 */
@Module({
  imports: [StepRegistryModule, ImporterModule, ApplicationsModule, RunImportStepsModule, RunDataStepsModule, RunCutoverStepsModule, CoolifyInPlaceModule],
  controllers: [MigrationRunsController],
  providers: [
    PrismaRunStore,
    { provide: RUN_STORE, useExisting: PrismaRunStore },
    RunEnvService,
    { provide: RUN_ENV, useExisting: RunEnvService },
    RunSinkService,
    { provide: RUN_SINK, useExisting: RunSinkService },
    RunEngineService,
    RunRecoveryService,
    MigrationRunsService,
    { provide: MIGRATION_RUNS_FACADE, useExisting: MigrationRunsService },
  ],
  exports: [MIGRATION_RUNS_FACADE, StepRegistryModule],
})
export class MigrationRunsModule {}
