import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { ApplicationsModule } from "../applications/applications.module";
import { WebhooksController } from "./webhooks.controller";
import { WebhooksService } from "./webhooks.service";

@Module({
  imports: [CryptoModule, ApplicationsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}
