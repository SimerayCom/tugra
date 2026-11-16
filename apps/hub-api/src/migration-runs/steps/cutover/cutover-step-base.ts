import type { OnModuleInit } from "@nestjs/common";
import { StepFailure, type AnyStepHandler, type RunSnapshot, type StepHandlerRegistry } from "../../core/run-contract";

/** Base of the cutover-side handlers: self-registers with the step registry on module init (the lane contract). */
export abstract class CutoverStepBase implements OnModuleInit {
  protected constructor(private readonly registry: StepHandlerRegistry) {}

  onModuleInit(): void {
    this.registry.register(this as unknown as AnyStepHandler);
  }
}

/** The import op the cutover steps work on; IMPORT passed before any of them runs, so a missing one is a deterministic failure. */
export function requireOpId(run: RunSnapshot, code: string): string {
  if (!run.opId) throw new StepFailure(code, {}, false);
  return run.opId;
}

/** Poll interval of the polling `act`s (the engine clamps to 1..60 s). */
export const POLL_MS = 30_000;
