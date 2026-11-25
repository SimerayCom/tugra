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
import { COOLIFY_HOST_IDENTITY, type CoolifyHostIdentityReader } from "./coolify-ssh-plan";
import { hostIdentityReaderOf } from "./coolify-host-identity";
import { ServersService } from "../servers/servers.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules.
@Module({
  imports: [AgentGatewayModule, ServersModule, CryptoModule],
  controllers: [CoolifyTakeoverController, CoolifySecretsController, CoolifySshController],
  // Lane B: SealedChannelService, CoolifyHostGrantService. Lane C: CoolifySshInstallService. Lane D: HostMatchService. Empty skeletons until those lanes land.
  providers: [
    CoolifyTakeoverService,
    SealedChannelService,
    CoolifyHostGrantService,
    CoolifySecretsService,
    CoolifySshInstallService,
    HostMatchService,
    // What a freshly enrolled agent says about its own sshd host keys (it reports them with its host info): the post-install cross-check
    // compares them with the key the Coolify host saw on the wire. Without a report the check falls back to the address and never blocks.
    {
      provide: COOLIFY_HOST_IDENTITY,
      useFactory: (servers: ServersService): CoolifyHostIdentityReader => hostIdentityReaderOf(servers),
      inject: [ServersService],
    },
  ],
  exports: [SealedChannelService, CoolifyHostGrantService, CoolifySecretsService, CoolifySshInstallService, HostMatchService],
})
export class CoolifyTakeoverModule {}
