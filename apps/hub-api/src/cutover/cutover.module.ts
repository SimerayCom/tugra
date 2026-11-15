import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ApplicationsModule } from "../applications/applications.module";
import { DnsModule } from "../dns/dns.module";
import { DnsLookupService } from "../dns/dns-lookup.service";
import { ImporterModule } from "../importer/importer.module";
import { CutoverController } from "./cutover.controller";
import { CutoverService } from "./cutover.service";
import { NetProbe } from "./net-probe";

// SSL/DNS cutover of imported apps. Reuses the importer's op ownership (ImporterModule exports the executor and the
// cert staging service), the team DNS credentials (DnsModule), the app services (ApplicationsModule, lazily via the
// APPLICATIONS_SERVICE token) and the agent socket. PrismaService, TeamAccess, Audit, Crypto and ProxyConfig are global.
@Module({
  imports: [ImporterModule, DnsModule, ApplicationsModule, AgentGatewayModule],
  controllers: [CutoverController],
  providers: [CutoverService, NetProbe, DnsLookupService],
  exports: [CutoverService],
})
export class CutoverModule {}
