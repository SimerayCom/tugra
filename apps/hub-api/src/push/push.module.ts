import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { PushController } from "./push.controller";
import { PushService } from "./push.service";

@Module({
  imports: [CryptoModule],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
