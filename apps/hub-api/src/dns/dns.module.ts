import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { ClustersModule } from "../clusters/clusters.module";
import { CloudflareApiClient } from "../tunnel/cloudflare-api.client";
import { DnsCredentialsService } from "./dns-credentials.service";
import { DnsCredentialsController } from "./dns-credentials.controller";
import { DnsAutomationService } from "./dns-automation.service";
import { DnsLookupService } from "./dns-lookup.service";

/**
 * DNS automation (custom-domain one-click auto-setup). v1 = Cloudflare. CloudflareApiClient is a stateless
 * client provided here directly (TunnelModule does not export it); PrismaService, TeamAccessService and
 * AuditService come from @Global modules; CryptoModule supplies token encryption; ClustersModule supplies
 * SwarmProxyService for resolving a cluster app's ingress IPs. DnsAutomationService + DnsCredentialsService
 * are exported for the REST/MCP slices that drive them.
 */
@Module({
  imports: [CryptoModule, ClustersModule],
  controllers: [DnsCredentialsController],
  providers: [DnsCredentialsService, DnsAutomationService, DnsLookupService, CloudflareApiClient],
  exports: [DnsCredentialsService, DnsAutomationService, CloudflareApiClient],
})
export class DnsModule {}
