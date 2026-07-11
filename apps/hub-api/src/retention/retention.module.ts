import { Module } from "@nestjs/common";
import { RetentionRunnerService } from "./retention-runner.service";
import { RetentionSchedulerService } from "./retention-scheduler.service";

// PrismaService / RedisService / ConfigService are all @Global, so no imports are needed.
@Module({
  providers: [RetentionRunnerService, RetentionSchedulerService],
})
export class RetentionModule {}
