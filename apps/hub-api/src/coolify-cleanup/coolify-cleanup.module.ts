import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { CryptoModule } from "../crypto/crypto.module";
import { DnsLookupService } from "../dns/dns-lookup.service";
import { NetProbe } from "../cutover/net-probe";
import { ServersModule } from "../servers/servers.module";
import { CoolifyCleanupController } from "./coolify-cleanup.controller";
import { CoolifyCleanupService } from "./coolify-cleanup.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules.
@Module({
  imports: [AgentGatewayModule, CryptoModule, ServersModule],
  controllers: [CoolifyCleanupController],
  providers: [CoolifyCleanupService, DnsLookupService, NetProbe],
  exports: [CoolifyCleanupService],
})
export class CoolifyCleanupModule {}
