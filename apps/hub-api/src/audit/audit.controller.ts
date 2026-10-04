import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { AuditService } from "./audit.service";

@ApiTags("audit")
@ApiSecurity("pat")
@Controller("audit")
@UseGuards(ApiAuthGuard, ScopesGuard)
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
