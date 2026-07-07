import { Module } from "@nestjs/common";
import { TeamDefaultsService } from "./team-defaults.service";

/**
 * Standalone so both AuthModule and TeamsModule can consume TeamDefaultsService
 * without an Auth↔Teams import cycle. Only depends on the global PrismaService.
 */
@Module({
  providers: [TeamDefaultsService],
  exports: [TeamDefaultsService],
})
export class TeamDefaultsModule {}
