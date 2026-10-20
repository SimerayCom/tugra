import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CleanupService } from "./cleanup.service";
import { PatchService } from "./patch.service";
import { CleanupConfigBulkInput, CleanupConfigBulkSchema, FleetPatchInput, FleetPatchSchema } from "./dto";

/** Fleet-wide bulk operations (cross-team, role-gated per server). */
@ApiTags("servers")
@ApiSecurity("pat")
@Controller("fleet")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class FleetController {
  constructor(
    private readonly cleanup: CleanupService,
    private readonly patch: PatchService,
  ) {}

  @Post("cleanup-config")
  @HttpCode(200)
  @ApiZodBody(CleanupConfigBulkSchema)
  bulkCleanupConfig(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CleanupConfigBulkSchema)) body: CleanupConfigBulkInput,
  ) {
    return this.cleanup.setConfigBulk(user.userId, body.serverIds, body);
  }

  // Check OS package updates across many servers at once (each role-gated; non-writable skipped).
  @Post("updates/check")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(FleetPatchSchema)
  bulkCheckUpdates(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(FleetPatchSchema)) body: FleetPatchInput,
  ) {
    return this.patch.checkUpdatesBulk(user.userId, body.serverIds);
  }

  // Apply all OS package updates across many servers at once. Reboots are never automatic.
  @Post("updates/apply")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(FleetPatchSchema)
  bulkUpgradeAll(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(FleetPatchSchema)) body: FleetPatchInput,
  ) {
    return this.patch.upgradeAllBulk(user.userId, body.serverIds);
  }
}
