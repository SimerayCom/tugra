import { Module } from "@nestjs/common";
import { CoolifyCleanupService } from "./coolify-cleanup.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules. Lane G adds its imports and controller here.
@Module({
  providers: [CoolifyCleanupService],
  exports: [CoolifyCleanupService],
})
export class CoolifyCleanupModule {}
