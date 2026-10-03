import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { CloudflareApiClient } from "../tunnel/cloudflare-api.client";
import { DnsCredentialsService } from "./dns-credentials.service";
import { DnsCredentialsController } from "./dns-credentials.controller";

/**
 * DNS automation (custom-domain one-click auto-setup). v1 = Cloudflare. CloudflareApiClient is a stateless
 * client provided here directly (TunnelModule does not export it); PrismaService, TeamAccessService and
 * AuditService come from @Global modules; CryptoModule supplies token encryption. DnsCredentialsService +
 * the client are exported for the DnsAutomationService that lands in a later slice (preview/apply records).
 */
@Module({
  imports: [CryptoModule],
  controllers: [DnsCredentialsController],
  providers: [DnsCredentialsService, CloudflareApiClient],
  exports: [DnsCredentialsService, CloudflareApiClient],
})
export class DnsModule {}
