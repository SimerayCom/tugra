import { Module } from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { MetricsLiveService } from "./metrics-live.service";

@Module({
  providers: [MetricsService, MetricsLiveService],
  exports: [MetricsService, MetricsLiveService],
})
export class MetricsModule {}
