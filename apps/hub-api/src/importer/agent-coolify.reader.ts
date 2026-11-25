import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { buildAgentReadScript } from "../coolify-takeover/coolify-agent-sql";
import { parseAgentRead, type AgentRead } from "../coolify-takeover/coolify-agent-read";
import { CoolifyReadError } from "../coolify-takeover/coolify-inventory";
import type { AgentReadPort } from "./sources/agent-coolify.client";

const READ_TIMEOUT_MS = 240_000;
const MAX_OUTPUT_BYTES = 96 * 1024 * 1024;

/**
 * Runs the agent-read script on the Coolify host through the existing signed `command` channel (capability `database`, the same one
 * the v1 "Read this Coolify" uses; the agent has no new frame for a read without secrets). The output is streamed into memory and
 * parsed strictly; it is never stored here and never logged.
 */
@Injectable()
export class AgentCoolifyReader implements AgentReadPort {
  constructor(private readonly agentWs: AgentWsServer) {}

  async read(agentServerId: string): Promise<AgentRead> {
    if (!this.agentWs.isOnline(agentServerId)) throw new ConflictException({ code: "agent_offline", message: "The agent on the Coolify server is offline" });
    try {
      let streamed = "";
      let over = false;
      const r = await this.agentWs.sendCommand(agentServerId, buildAgentReadScript(), "database", READ_TIMEOUT_MS, (chunk) => {
        if (streamed.length + chunk.length > MAX_OUTPUT_BYTES) over = true;
        else streamed += chunk;
      });
      if (over) throw new CoolifyReadError("unreadable");
      return parseAgentRead(streamed.length >= r.output.length ? streamed : r.output);
    } catch (e) {
      // A fixed message with a stable code: the agent's own error text is never passed on.
      if (e instanceof CoolifyReadError) throw new BadRequestException({ code: e.failure, message: `Could not read Coolify (${e.failure})` });
      if (e instanceof ConflictException || e instanceof BadRequestException) throw e;
      throw new ConflictException({ code: "agent_unavailable", message: "The agent on the Coolify server did not answer" });
    }
  }
}
