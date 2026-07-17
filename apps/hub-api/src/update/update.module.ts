import { Module } from "@nestjs/common";
import { UpdateService } from "./update.service";
import { UpdateCheckSchedulerService } from "./update-check.scheduler.service";

/**
 * Self-update version check. UpdateService depends only on @Global providers (ConfigService and the
 * @Global InstanceSettingsService), so nothing needs importing here. Exporting UpdateService lets the
 * owner-only InstanceSettingsController (declared in AppModule) inject it for GET /instance/update.
 */
@Module({
  providers: [UpdateService, UpdateCheckSchedulerService],
  exports: [UpdateService],
})
export class UpdateModule {}
