import { Module } from "@nestjs/common";

/**
 * Lane C stub (C0): DNS_PREPARE, TLS_PREISSUE, CUTOVER, OBSERVE, FINALIZE and DECOMMISSION handlers (+ proxy swap, dark
 * probe) register themselves with the `STEP_HANDLERS` registry from here. Intentionally empty until lane C fills it.
 */
@Module({})
export class RunCutoverStepsModule {}
