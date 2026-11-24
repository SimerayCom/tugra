import { Module } from "@nestjs/common";
import { MetricsModule } from "../metrics/metrics.module";
import { ServersModule } from "../servers/servers.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";

// PrismaService and TeamAccessService come from @Global modules.
@Module({
  imports: [MetricsModule, ServersModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
