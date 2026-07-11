import { Module } from "@nestjs/common";
import { MetricsService } from "./metrics.service";
import { MetricsLiveService } from "./metrics-live.service";
import { ContainerMetricsService } from "./container-metrics.service";

@Module({
  providers: [MetricsService, MetricsLiveService, ContainerMetricsService],
  exports: [MetricsService, MetricsLiveService, ContainerMetricsService],
})
export class MetricsModule {}
