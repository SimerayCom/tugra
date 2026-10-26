import { Global, Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { ProxyConfigService } from "./proxy-config.service";

// Global: both the applications module (ProxyService) and the server-ops module (ProxyOpsService), plus the
// panel-TLS service, resolve proxy config through this one service — exporting it globally keeps them from
// re-importing and guarantees a single shared resolver (no Traefik-flag drift). Prisma, Config and
// InstanceSettings are already global; only CryptoModule needs importing here.
@Global()
@Module({
  imports: [CryptoModule],
  providers: [ProxyConfigService],
  exports: [ProxyConfigService],
})
export class ProxyConfigModule {}
