import type { AgentPlanAdditions } from "@tugra/shared";
import type { ForeignFleet } from "../foreign-fleet";
import type { ImportSourceCapabilities } from "../import-source";
import { CoolifySource } from "./coolify.source";
import type { AgentCoolifyClient } from "./agent-coolify.client";

/**
 * The Coolify source read through the agent on the Coolify host. It is the API-token source with a different client, so the fleet,
 * the plan and the plan hash come out of the very same code. It adds the facts only the agent read knows (the Coolify team of each
 * project, the schema version, secret counts) as the plan's additive, hash-excluded block.
 */
export class AgentCoolifySource extends CoolifySource {
  constructor(private readonly agentClient: AgentCoolifyClient) {
    super(agentClient);
  }

  override capabilities(): ImportSourceCapabilities {
    return { apiRead: true, sshRead: false, dbDataDump: false, volumeRead: false };
  }

  /** Reachable = the agent answered and the read confirmed a read-only, REPEATABLE READ session. */
  override async verify(): Promise<{ ok: boolean; version?: string; detail?: string }> {
    try {
      const view = await this.agentClient.agentView();
      const version = view.versionText();
      return version ? { ok: true, version } : { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "verification failed" };
    }
  }

  override async discover(): Promise<ForeignFleet> {
    const [fleet, view] = await Promise.all([super.discover(), this.agentClient.agentView()]);
    return { ...fleet, warnings: [...fleet.warnings.map(agentWarning), ...view.warnings] };
  }

  /** The block the plan carries on top of the API-path plan. */
  async agentPlan(): Promise<AgentPlanAdditions> {
    const view = await this.agentClient.agentView();
    return { agentRead: view.meta, ...(view.teams.length ? { teams: view.teams } : {}) };
  }
}

/** A token path tells the user to use a `read:sensitive` token; on the agent path the same text is read by the sealed secret step. */
function agentWarning(w: string): string {
  return w.replace(/need a read:sensitive token to fetch their compose file before import/, "have their compose file read by the sealed secret step (not read yet)");
}
