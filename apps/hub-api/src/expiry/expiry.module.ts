import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { ExpiryRunnerService } from "./expiry-runner.service";
import { ExpirySchedulerService } from "./expiry.scheduler.service";

@Module({
  imports: [NotificationsModule],
  providers: [ExpiryRunnerService, ExpirySchedulerService],
})
export class ExpiryModule {}
