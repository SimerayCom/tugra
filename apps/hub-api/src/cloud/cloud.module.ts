import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { ServersModule } from "../servers/servers.module";
import { HetznerApiClient } from "./providers/hetzner.client";
import { DigitalOceanApiClient } from "./providers/digitalocean.client";
import { VultrApiClient } from "./providers/vultr.client";
import { CloudProviderFactory } from "./providers/provider-factory.service";
import { CloudCredentialsService } from "./cloud-credentials.service";
import { CloudCredentialsController } from "./cloud-credentials.controller";
import { ProvisioningService } from "./provisioning.service";
import { ProvisioningController } from "./provisioning.controller";
import { OobService } from "./oob.service";
import { OobController } from "./oob.controller";
import { PROVISIONING_SERVICE } from "./cloud.tokens";

// Imports ServersModule (one-directional). The reverse edge — ServersService destroying a VM on
// delete — is a lazy ModuleRef.get(PROVISIONING_SERVICE) (no static cycle). PrismaService,
// TeamAccessService and AuditService come from @Global modules.
@Module({
  imports: [CryptoModule, ServersModule],
  controllers: [CloudCredentialsController, ProvisioningController, OobController],
  providers: [
    HetznerApiClient,
    DigitalOceanApiClient,
    VultrApiClient,
    CloudProviderFactory,
    CloudCredentialsService,
    ProvisioningService,
    OobService,
    { provide: PROVISIONING_SERVICE, useExisting: ProvisioningService },
  ],
  exports: [ProvisioningService, PROVISIONING_SERVICE, CloudCredentialsService, OobService],
})
export class CloudModule {}
