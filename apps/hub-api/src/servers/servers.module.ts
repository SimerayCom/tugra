import { Module } from "@nestjs/common";
import { MetricsModule } from "../metrics/metrics.module";
import { ServersController } from "./servers.controller";
import { ServersService } from "./servers.service";

@Module({
  imports: [MetricsModule],
  controllers: [ServersController],
  providers: [ServersService],
  exports: [ServersService],
})
export class ServersModule {}
