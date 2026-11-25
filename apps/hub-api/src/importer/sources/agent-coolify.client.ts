import type { CoolifyClient } from "./coolify.source";
import type { AgentRead } from "../../coolify-takeover/coolify-agent-read";
import { AgentApiNotFound, buildAgentView, type AgentView } from "./agent-coolify.mapper";

/** Where the agent read comes from: the production one asks the agent on the Coolify host, a test hands over a canned read. */
export interface AgentReadPort {
  read(agentServerId: string): Promise<AgentRead>;
}

/**
 * A {@link CoolifyClient} that answers from ONE agent read of Coolify's own database. Every `get` of one client instance is served
 * from the same snapshot (the read is a single REPEATABLE READ transaction), so the importer's many small reads are consistent with
 * each other. A new client reads again: the drift check, the freeze and the final data pass build a new source and so read fresh.
 * It never holds a secret: the read has none (see coolify-agent-sql.ts).
 */
export class AgentCoolifyClient implements CoolifyClient {
  private view: Promise<AgentView> | undefined;

  constructor(
    private readonly port: AgentReadPort,
    readonly agentServerId: string,
  ) {}

  /** The snapshot and what is derived from it. A failed read is not remembered: the next call reads again. */
  agentView(): Promise<AgentView> {
    this.view ??= this.port
      .read(this.agentServerId)
      .then((r) => buildAgentView(r, this.agentServerId))
      .catch((e) => {
        this.view = undefined;
        throw e;
      });
    return this.view;
  }

  async get<T>(path: string): Promise<T> {
    return (await this.agentView()).route(path) as T;
  }

  async getText(path: string): Promise<string> {
    const view = await this.agentView();
    const v = path === "/version" ? view.versionText() : null;
    if (!v) throw new AgentApiNotFound(path);
    return v;
  }
}
