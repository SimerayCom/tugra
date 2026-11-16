import { Injectable } from "@nestjs/common";
import { ImporterService } from "../../../../importer/importer.service";
import type { RunSnapshot } from "../../../core/run-contract";
import type { DriftPort } from "../data-contract";

/**
 * Re-discover the source and compare it with the plan the run was created from. The importer's plan is read-only; `changed`
 * means the plan hash differs now (an app, database or domain was added, removed or changed on the source since the review).
 * An expired session or an unreachable source is `unknown`, never `same`.
 */
@Injectable()
export class ImporterDrift implements DriftPort {
  constructor(private readonly importer: ImporterService) {}

  async check(run: RunSnapshot): Promise<{ result: "same" | "changed" | "unknown" }> {
    if (!run.sessionId || (run.sourceKind !== "coolify" && run.sourceKind !== "dokploy")) return { result: "unknown" };
    try {
      const modes = run.applyInput.dbDataModes;
      const plan = await this.importer.plan(run.actorId, { sourceKind: run.sourceKind, sessionId: run.sessionId, ...(modes ? { dbDataModes: modes } : {}) });
      return { result: plan.planHash === run.planHash ? "same" : "changed" };
    } catch {
      return { result: "unknown" };
    }
  }
}
