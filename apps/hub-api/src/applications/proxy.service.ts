import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AgentWsServer } from "../agent-gateway/agent-ws.server";
import { buildProxySetupScript } from "../deploy/deploy-script";

/** Ensures the Traefik reverse-proxy is running on a server (idempotent). */
@Injectable()
export class ProxyService {
  constructor(
    private readonly config: ConfigService,
    private readonly agentWs: AgentWsServer,
  ) {}

  async ensureProxy(serverId: string): Promise<void> {
    const email = this.config.get<string>("ACME_EMAIL");
    await this.agentWs.sendCommand(
      serverId,
      buildProxySetupScript(email),
      "deploy",
      60_000,
    );
  }
}
