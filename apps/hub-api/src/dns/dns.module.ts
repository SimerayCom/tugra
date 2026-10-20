import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { ClustersModule } from "../clusters/clusters.module";
import { CloudflareApiClient } from "../tunnel/cloudflare-api.client";
import { DnsCredentialsService } from "./dns-credentials.service";
import { DnsCredentialsController } from "./dns-credentials.controller";
import { DnsAutomationService } from "./dns-automation.service";
import { DnsLookupService } from "./dns-lookup.service";
import { MailDnsService } from "./mail-dns.service";
import { MailDnsController } from "./mail-dns.controller";

/**
 * DNS automation (custom-domain one-click auto-setup + mail-deliverability DNS). v1 = Cloudflare.
 * CloudflareApiClient is a stateless client provided here directly (TunnelModule does not export it);
 * PrismaService, TeamAccessService and AuditService come from @Global modules; CryptoModule supplies token
 * encryption; ClustersModule supplies SwarmProxyService for resolving a cluster app's ingress IPs.
 * DnsAutomationService, MailDnsService + DnsCredentialsService are exported for the REST/MCP layers that drive them.
 */
@Module({
  imports: [CryptoModule, ClustersModule],
  controllers: [DnsCredentialsController, MailDnsController],
  providers: [DnsCredentialsService, DnsAutomationService, DnsLookupService, MailDnsService, CloudflareApiClient],
  exports: [DnsCredentialsService, DnsAutomationService, MailDnsService, CloudflareApiClient],
})
export class DnsModule {}
