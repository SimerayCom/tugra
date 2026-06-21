import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { MonitorsController } from "./monitors.controller";
import { MonitorsService } from "./monitors.service";
import { MonitorRunnerService } from "./runner.service";
import { MonitorSchedulerService } from "./scheduler.service";

@Module({
  imports: [NotificationsModule],
  controllers: [MonitorsController],
  providers: [MonitorsService, MonitorRunnerService, MonitorSchedulerService],
  exports: [MonitorsService],
})
export class MonitorsModule {}
