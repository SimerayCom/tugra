import { Module } from "@nestjs/common";
import { ProjectMovesService } from "./project-moves.service";

// PrismaService, TeamAccessService and AuditService come from @Global modules. Lane H adds its imports (AppMovesModule, DatabasesModule ...) and controller here.
@Module({
  providers: [ProjectMovesService],
  exports: [ProjectMovesService],
})
export class ProjectMovesModule {}
