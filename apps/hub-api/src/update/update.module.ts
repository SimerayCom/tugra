import { Module } from "@nestjs/common";
import { UpdateService } from "./update.service";
import { UpdaterService } from "./updater.service";
import { UpdateCheckSchedulerService } from "./update-check.scheduler.service";

/**
 * Self-update. UpdateService (CHECK) + UpdaterService (APPLY) depend only on @Global providers
 * (ConfigService, the @Global InstanceSettingsService, and the @Global RedisService), so nothing needs
 * importing here. Both are exported so the owner-only InstanceSettingsController (declared in AppModule)
 * can inject them for GET/POST /instance/update + the SSE stream.
 */
@Module({
  providers: [UpdateService, UpdaterService, UpdateCheckSchedulerService],
  exports: [UpdateService, UpdaterService],
})
export class UpdateModule {}
