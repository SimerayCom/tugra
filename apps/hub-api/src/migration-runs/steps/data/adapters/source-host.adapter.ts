import { Injectable } from "@nestjs/common";
import { AgentWsServer } from "../../../../agent-gateway/agent-ws.server";
import type { SourceHostPort } from "../data-contract";

/** Run a hub-built script on a server's agent. The agent enforces the capability again locally (fail closed). */
@Injectable()
export class AgentSourceHost implements SourceHostPort {
  constructor(private readonly agents: AgentWsServer) {}

  run(serverId: string, script: string, capability: "migrate" | "database", timeoutMs: number): Promise<{ exitCode: number; output: string }> {
    return this.agents.sendCommand(serverId, script, capability, timeoutMs);
  }
}
