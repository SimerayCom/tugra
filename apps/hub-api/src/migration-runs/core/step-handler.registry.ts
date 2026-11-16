import { Injectable } from "@nestjs/common";
import { STEP_KEYS, STEP_MANIFEST, isStepKey, stepKeysForMode, type AnyStepHandler, type RunMode, type StepHandlerRegistry, type StepKey } from "./run-contract";

/**
 * The in-memory handler registry (contract: {@link StepHandlerRegistry}). Handlers register in `onModuleInit`; every
 * registration is validated against the static manifest so a lane cannot drift from the contract unnoticed.
 */
@Injectable()
export class StepHandlerRegistryService implements StepHandlerRegistry {
  private readonly handlers = new Map<StepKey, AnyStepHandler>();

  register(handler: AnyStepHandler): void {
    const key: unknown = handler.key;
    if (!isStepKey(key)) throw new Error(`migration-runs: unknown step key "${String(key)}"`);
    const m = STEP_MANIFEST[key];
    if (this.handlers.has(key)) throw new Error(`migration-runs: step handler for ${key} registered twice`);
    if (handler.kind !== m.kind) throw new Error(`migration-runs: ${key} handler kind "${handler.kind}" != manifest "${m.kind}"`);
    if (handler.rollback !== m.rollback) throw new Error(`migration-runs: ${key} handler rollback "${handler.rollback}" != manifest "${m.rollback}"`);
    if ((handler.skippable ?? false) !== (m.skippable ?? false)) throw new Error(`migration-runs: ${key} handler skippable differs from the manifest`);
    this.handlers.set(key, handler);
  }

  get(key: StepKey): AnyStepHandler | undefined {
    return this.handlers.get(key);
  }

  require(key: StepKey): AnyStepHandler {
    const h = this.handlers.get(key);
    if (!h) throw new Error(`migration-runs: no handler registered for ${key}`);
    return h;
  }

  list(): AnyStepHandler[] {
    return STEP_KEYS.flatMap((k) => {
      const h = this.handlers.get(k);
      return h ? [h] : [];
    });
  }

  missing(mode: RunMode = "takeover"): StepKey[] {
    return stepKeysForMode(mode).filter((k) => !this.handlers.has(k));
  }
}
