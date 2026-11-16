import { Module } from "@nestjs/common";
import { MigrationRunsController } from "./migration-runs.controller";
import { NotImplementedMigrationRunsFacade } from "./core/not-implemented.facade";
import { MIGRATION_RUNS_FACADE } from "./core/run-contract";
import { StepRegistryModule } from "./core/step-registry.module";
import { RunCutoverStepsModule } from "./steps/cutover/run-cutover-steps.module";
import { RunDataStepsModule } from "./steps/data/run-data-steps.module";

/**
 * One-click migration orchestrator (P7). `MigrationRun` sits above the importer's op; the step handlers live in lane
 * modules that register with the global step registry. C0: the controller is mounted and answers 501 through the stub
 * facade; lane A swaps `useClass` for the real service (and imports the import-side steps module).
 */
@Module({
  imports: [StepRegistryModule, RunDataStepsModule, RunCutoverStepsModule],
  controllers: [MigrationRunsController],
  providers: [{ provide: MIGRATION_RUNS_FACADE, useClass: NotImplementedMigrationRunsFacade }],
  exports: [MIGRATION_RUNS_FACADE, StepRegistryModule],
})
export class MigrationRunsModule {}
