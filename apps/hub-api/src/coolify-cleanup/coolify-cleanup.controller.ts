import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody } from "../openapi/openapi";
import { CoolifyCleanupService } from "./coolify-cleanup.service";
import { ConfirmSchema, type ConfirmInput } from "./dto";

/**
 * The completeness checklist and the removal of Coolify's leftovers on one server. Team OWNER only for everything that acts; the
 * checklist and the list may also be read by an admin. Checking removes nothing; removal needs the owner to confirm the exact list.
 */
@ApiTags("coolify-cleanup")
@ApiSecurity("pat")
@Controller("coolify-cleanup")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class CoolifyCleanupController {
  constructor(private readonly cleanup: CoolifyCleanupService) {}

  /** The newest cleanup of a server (null when there is none). */
  @Get("servers/:serverId")
  latest(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string) {
    return this.cleanup.latest(user.userId, serverId);
  }

  /** Compare Coolify with Tugra and list the leftovers. Removes nothing. */
  @Post("servers/:serverId/check")
  @HttpCode(200)
  @RequireScopes("write")
  check(@CurrentUser() user: AuthUser, @Param("serverId") serverId: string) {
    return this.cleanup.check(user.userId, serverId);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.cleanup.get(user.userId, id);
  }

  /** Remove the listed leftovers (202: it runs in the background). Needs a complete checklist and the owner's typed confirmation. */
  @Post(":id/confirm")
  @HttpCode(202)
  @RequireScopes("write")
  @ApiZodBody(ConfirmSchema)
  confirm(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(ConfirmSchema)) body: ConfirmInput) {
    return this.cleanup.confirm(user.userId, id, body);
  }
}
