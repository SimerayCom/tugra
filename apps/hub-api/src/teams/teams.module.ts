import { Module } from "@nestjs/common";
import { TeamsController } from "./teams.controller";
import { InvitationsController } from "./invitations.controller";
import { TeamsService } from "./teams.service";

@Module({
  controllers: [TeamsController, InvitationsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
