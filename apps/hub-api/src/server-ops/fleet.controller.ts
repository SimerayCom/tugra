import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CleanupService } from "./cleanup.service";
import { CleanupConfigBulkInput, CleanupConfigBulkSchema } from "./dto";

/** Fleet-wide bulk operations (cross-team, role-gated per server). */
@ApiTags("servers")
@ApiSecurity("pat")
@Controller("fleet")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class FleetController {
  constructor(private readonly cleanup: CleanupService) {}

  @Post("cleanup-config")
  @HttpCode(200)
  @ApiZodBody(CleanupConfigBulkSchema)
  bulkCleanupConfig(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CleanupConfigBulkSchema)) body: CleanupConfigBulkInput,
  ) {
    return this.cleanup.setConfigBulk(user.userId, body.serverIds, body);
  }
}
