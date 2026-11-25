import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CoolifyMoveService } from "./coolify-move.service";
import { StatusQuerySchema, type StatusQuery } from "./dto";

/**
 * The guided "Move off Coolify" progress: one read-only view over every server of a team. Team owner or admin only. Nothing here acts on a
 * server or returns a value, key, token or address; the steps themselves stay on their own endpoints.
 */
@ApiTags("coolify-move")
@ApiSecurity("pat")
@Controller("coolify-move")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class CoolifyMoveController {
  constructor(private readonly move: CoolifyMoveService) {}

  @Get("status")
  status(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(StatusQuerySchema)) q: StatusQuery) {
    return this.move.status(user.userId, q.teamId);
  }
}
