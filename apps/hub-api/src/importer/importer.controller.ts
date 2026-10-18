import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ImporterService } from "./importer.service";
import { ImportPlanRequestSchema, type ImportPlanRequestInput } from "./dto";

@ApiTags("import")
@ApiSecurity("pat")
@Controller("import")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ImporterController {
  constructor(private readonly importer: ImporterService) {}

  /**
   * Dry-run import plan: preview the Tugra resources an import would create, with per-item risks. No
   * mutation and no secret VALUES (only env keys/counts). The plan reveals env keys, so it requires the
   * `read:secrets` scope — the same scope as the migrator's discover — overriding the POST "write" default.
   */
  @Post("plan")
  @RequireScopes("read:secrets")
  @ApiZodBody(ImportPlanRequestSchema)
  plan(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(ImportPlanRequestSchema)) body: ImportPlanRequestInput,
  ) {
    return this.importer.plan(user.userId, body);
  }
}
