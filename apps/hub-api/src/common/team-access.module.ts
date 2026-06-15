import { Global, Module } from "@nestjs/common";
import { TeamAccessService } from "./team-access.service";

@Global()
@Module({
  providers: [TeamAccessService],
  exports: [TeamAccessService],
})
export class TeamAccessModule {}
