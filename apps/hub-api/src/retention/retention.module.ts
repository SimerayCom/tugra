import { Module } from "@nestjs/common";
import { MetricsRollupRunnerService } from "./metrics-rollup-runner.service";
import { MetricsRollupSchedulerService } from "./metrics-rollup-scheduler.service";
import { RetentionRunnerService } from "./retention-runner.service";
import { RetentionSchedulerService } from "./retention-scheduler.service";

// PrismaService / RedisService / ConfigService are all @Global, so no imports are needed.
@Module({
  providers: [
    RetentionRunnerService,
    RetentionSchedulerService,
    MetricsRollupRunnerService,
    MetricsRollupSchedulerService,
  ],
})
export class RetentionModule {}
