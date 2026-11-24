import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodResponse } from "../openapi/openapi";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { DashboardService } from "./dashboard.service";
import { DashboardInsightsSchema } from "./dto";

/** Read-only digests for the Command Center cards. Read-level (no extra scope): the service itself limits every
 *  query to the caller's teams and, for project-restricted members, to the apps/databases they were granted. */
@ApiTags("dashboard")
@ApiSecurity("pat")
@Controller("dashboard")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("insights")
  @ApiZodResponse(DashboardInsightsSchema)
  insights(@CurrentUser() user: AuthUser, @Query("teamId") teamId?: string) {
    return this.dashboard.insights(user.userId, typeof teamId === "string" && teamId ? teamId : undefined);
  }
}
