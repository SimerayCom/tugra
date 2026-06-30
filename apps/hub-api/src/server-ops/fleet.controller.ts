import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CleanupService } from "./cleanup.service";
import { CleanupConfigBulkInput, CleanupConfigBulkSchema } from "./dto";

/** Fleet-wide bulk operations (cross-team, role-gated per server). */
@Controller("fleet")
@UseGuards(ApiAuthGuard)
export class FleetController {
  constructor(private readonly cleanup: CleanupService) {}

  @Post("cleanup-config")
  @HttpCode(200)
  bulkCleanupConfig(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CleanupConfigBulkSchema)) body: CleanupConfigBulkInput,
  ) {
    return this.cleanup.setConfigBulk(user.userId, body.serverIds, body);
  }
}
