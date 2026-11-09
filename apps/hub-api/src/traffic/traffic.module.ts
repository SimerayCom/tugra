import { Module } from "@nestjs/common";
import { ServersModule } from "../servers/servers.module";
import { HostResolverService } from "./host-resolver.service";
import { TrafficMetricsService } from "./traffic-metrics.service";
import { TrafficService } from "./traffic.service";
import { TrafficController } from "./traffic.controller";

@Module({
  imports: [ServersModule],
  controllers: [TrafficController],
  providers: [HostResolverService, TrafficMetricsService, TrafficService],
  exports: [TrafficMetricsService],
})
export class TrafficModule {}
