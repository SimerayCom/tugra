import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { AppTunnelController, TunnelController } from "./tunnel.controller";
import { TunnelService } from "./tunnel.service";
import { CloudflareApiClient } from "./cloudflare-api.client";
import { TUNNEL_SERVICE } from "./tunnel.tokens";

@Module({
  imports: [AgentGatewayModule, CryptoModule],
  controllers: [TunnelController, AppTunnelController],
  providers: [TunnelService, CloudflareApiClient, { provide: TUNNEL_SERVICE, useExisting: TunnelService }],
  exports: [TunnelService, TUNNEL_SERVICE],
})
export class TunnelModule {}
