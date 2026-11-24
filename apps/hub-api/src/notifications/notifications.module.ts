import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationQueueService } from "./queue.service";
import { NotifI18nService } from "./notif-i18n.service";
import { DigestController } from "./digest.controller";
import { DigestService } from "./digest.service";
import { DigestSchedulerService } from "./digest.scheduler";

@Module({
  imports: [CryptoModule],
  controllers: [NotificationsController, DigestController],
  providers: [NotificationsService, NotificationQueueService, NotifI18nService, DigestService, DigestSchedulerService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
