import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { AuditService } from "./audit.service";

@Controller("audit")
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query("teamId") teamId?: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.svc.list(user.userId, teamId, cursor);
  }
}
