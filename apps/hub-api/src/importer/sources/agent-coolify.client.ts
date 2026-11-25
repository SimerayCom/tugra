import type { CoolifyClient } from "./coolify.source";
import type { AgentRead } from "../../coolify-takeover/coolify-agent-read";
import { AgentApiNotFound, buildAgentView, type AgentView, type AgentViewOptions } from "./agent-coolify.mapper";
import { NO_OVERLAY, type SecretOverlay } from "./agent-secrets";

/** Where the agent read comes from: the production one asks the agent on the Coolify host, a test hands over a canned read. */
export interface AgentReadPort {
  read(agentServerId: string): Promise<AgentRead>;
}

/**
 * A {@link CoolifyClient} that answers from ONE agent read of Coolify's own database. Every `get` of one client instance is served
 * from the same snapshot (the read is a single REPEATABLE READ transaction), so the importer's many small reads are consistent with
 * each other. A new client reads again: the drift check, the freeze and the final data pass build a new source and so read fresh.
 *
 * It holds no secret. What the plan may see of the sealed values (the compose text of an app or a service) comes in through `planOverlay`,
 * and only that; the paths that carry values are served by {@link AgentSensitiveClient}, which the apply side uses.
 */
export class AgentCoolifyClient implements CoolifyClient {
  private view: Promise<AgentView> | undefined;
  /** What the plan may see of the opened secrets (compose text). Unset = nothing. */
  planOverlay: SecretOverlay = NO_OVERLAY;

  constructor(
    private readonly port: AgentReadPort,
    readonly agentServerId: string,
    private readonly viewOptions: AgentViewOptions = {},
  ) {}

  /** The snapshot and what is derived from it. A failed read is not remembered: the next call reads again. */
  agentView(): Promise<AgentView> {
    this.view ??= this.port
      .read(this.agentServerId)
      .then((r) => buildAgentView(r, this.agentServerId, this.viewOptions))
      .catch((e) => {
        this.view = undefined;
        throw e;
      });
    return this.view;
  }

  async get<T>(path: string): Promise<T> {
    return (await this.agentView()).route(path, this.planOverlay) as T;
  }

  async getText(path: string): Promise<string> {
    const view = await this.agentView();
    const v = path === "/version" ? view.versionText() : null;
    if (!v) throw new AgentApiNotFound(path);
    return v;
  }
}

/**
 * The same snapshot, answering as a token that may read sensitive fields: env values, service variables and files, scheduled tasks,
 * notification tokens, shared variables, and the Dockerfile, labels and engine config text. The values come from the opened secrets of
 * the import session; a value that is not there (not consented, could not be opened) is absent, exactly like a token without the right.
 */
export class AgentSensitiveClient implements CoolifyClient {
  constructor(
    private readonly base: AgentCoolifyClient,
    private readonly overlay: SecretOverlay,
  ) {}

  async get<T>(path: string): Promise<T> {
    return (await this.base.agentView()).route(path, this.overlay, true) as T;
  }
}
