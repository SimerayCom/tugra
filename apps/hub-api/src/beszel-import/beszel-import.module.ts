import { Module } from "@nestjs/common";
import { CryptoModule } from "../crypto/crypto.module";
import { MonitorsModule } from "../monitors/monitors.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { BeszelImportController } from "./beszel-import.controller";
import { BeszelImportService } from "./beszel-import.service";

// PrismaService, TeamAccessService, AuditService and ConfigService are provided by @Global modules.
@Module({
  imports: [CryptoModule, MonitorsModule, NotificationsModule],
  controllers: [BeszelImportController],
  providers: [BeszelImportService],
})
export class BeszelImportModule {}
