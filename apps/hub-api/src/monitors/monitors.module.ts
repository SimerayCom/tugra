import { Module } from "@nestjs/common";
import { NotificationsModule } from "../notifications/notifications.module";
import { MonitorsController } from "./monitors.controller";
import { MonitorsService } from "./monitors.service";
import { MONITORS_SERVICE } from "./monitors.tokens";
import { MonitorRunnerService } from "./runner.service";
import { MonitorSchedulerService } from "./scheduler.service";

@Module({
  imports: [NotificationsModule],
  controllers: [MonitorsController],
  providers: [
    MonitorsService,
    MonitorRunnerService,
    MonitorSchedulerService,
    // String-token alias so ServersService can resolve this lazily via ModuleRef (no static module edge).
    { provide: MONITORS_SERVICE, useExisting: MonitorsService },
  ],
  exports: [MonitorsService, MONITORS_SERVICE],
})
export class MonitorsModule {}
