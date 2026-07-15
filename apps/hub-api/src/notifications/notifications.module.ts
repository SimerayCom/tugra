import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationQueueService } from "./queue.service";

@Module({
  imports: [CryptoModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationQueueService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
