import { Module } from "@nestjs/common";
import { AgentGatewayModule } from "../../agent-gateway/agent-gateway.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { MonitorsModule } from "../monitors.module";
import { KumaImportController } from "./kuma-import.controller";
import { KumaImportService } from "./kuma-import.service";

// PrismaService, TeamAccessService, AuditService and ConfigService come from @Global modules.
@Module({
  imports: [AgentGatewayModule, MonitorsModule, NotificationsModule],
  controllers: [KumaImportController],
  providers: [KumaImportService],
})
export class KumaImportModule {}
