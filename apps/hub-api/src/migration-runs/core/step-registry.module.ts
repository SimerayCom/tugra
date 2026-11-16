import { Global, Module } from "@nestjs/common";
import { STEP_HANDLERS } from "./run-contract";
import { StepHandlerRegistryService } from "./step-handler.registry";

/**
 * Provides the {@link STEP_HANDLERS} registry. `@Global()` so the lane step modules (imported BY the core module) can
 * inject it without importing the core module back (no cycle).
 */
@Global()
@Module({
  providers: [StepHandlerRegistryService, { provide: STEP_HANDLERS, useExisting: StepHandlerRegistryService }],
  exports: [STEP_HANDLERS, StepHandlerRegistryService],
})
export class StepRegistryModule {}
