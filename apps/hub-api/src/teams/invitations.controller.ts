import { Controller, Get, Param } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { TeamsService } from "./teams.service";

/**
 * PUBLIC (unauthenticated) invitation preview. Separate from TeamsController because that controller
 * is class-guarded by ApiAuthGuard+ScopesGuard (session or PAT) and there's no per-route bypass. A GET
 * passes the global CSRF / email-verification guards untouched; an explicit throttle caps token probing.
 */
@ApiTags("invitations")
@Controller("invitations")
export class InvitationsController {
  constructor(private readonly teams: TeamsService) {}

  @Get(":token")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  preview(@Param("token") token: string) {
    return this.teams.previewInvitation(token);
  }
}
