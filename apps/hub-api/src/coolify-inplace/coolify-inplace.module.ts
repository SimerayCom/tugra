import { Module } from "@nestjs/common";
import { CoolifyInPlaceService } from "./coolify-inplace.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules. Lane F adds its imports and controller here.
@Module({
  providers: [CoolifyInPlaceService],
  exports: [CoolifyInPlaceService],
})
export class CoolifyInPlaceModule {}
