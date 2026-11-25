import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../agent-gateway/agent-gateway.module";
import { ServersModule } from "../servers/servers.module";
import { CryptoModule } from "../crypto/crypto.module";
import { CoolifySecretsController } from "./coolify-secrets.controller";
import { CoolifySecretsService } from "./coolify-secrets.service";
import { CoolifyTakeoverController } from "./coolify-takeover.controller";
import { CoolifySshController } from "./coolify-ssh.controller";
import { CoolifyTakeoverService } from "./coolify-takeover.service";
import { CoolifyHostGrantService } from "./coolify-host-grant.service";
import { CoolifySshInstallService } from "./coolify-ssh-install.service";
import { HostMatchService } from "./host-match.service";
import { SealedChannelService } from "./sealed-channel.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules.
@Module({
  imports: [AgentGatewayModule, ServersModule, CryptoModule],
  controllers: [CoolifyTakeoverController, CoolifySecretsController, CoolifySshController],
  // Lane B: SealedChannelService, CoolifyHostGrantService. Lane C: CoolifySshInstallService. Lane D: HostMatchService. Empty skeletons until those lanes land.
  providers: [CoolifyTakeoverService, SealedChannelService, CoolifyHostGrantService, CoolifySecretsService, CoolifySshInstallService, HostMatchService],
  exports: [SealedChannelService, CoolifyHostGrantService, CoolifySecretsService, CoolifySshInstallService, HostMatchService],
})
export class CoolifyTakeoverModule {}
