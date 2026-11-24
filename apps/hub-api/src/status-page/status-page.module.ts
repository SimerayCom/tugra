import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { StatusPageController } from "./status-page.controller";
import { PublicStatusController } from "./public-status.controller";
import { StatusPageService } from "./status-page.service";
import { StatusSubscribersService } from "./status-subscribers.service";

@Module({
  imports: [CryptoModule],
  controllers: [StatusPageController, PublicStatusController],
  providers: [StatusPageService, StatusSubscribersService],
  exports: [StatusSubscribersService],
})
export class StatusPageModule {}
