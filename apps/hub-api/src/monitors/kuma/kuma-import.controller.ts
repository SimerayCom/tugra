import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CurrentUser } from "../../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../../api-tokens/api-auth.guard";
import { ScopesGuard } from "../../api-tokens/scopes.guard";
import { RequireScopes } from "../../api-tokens/require-scopes.decorator";
import { AuthUser } from "../../auth/strategies/jwt.strategy";
import { ApiZodBody } from "../../openapi/openapi";
import { KumaImportService } from "./kuma-import.service";
import {
  KumaApplySchema,
  KumaDetectSchema,
  KumaPreviewSchema,
  type KumaApplyInput,
  type KumaDetectInput,
  type KumaPreviewInput,
} from "./dto";

/**
 * Import monitors and their notification links from Uptime Kuma. Preview is a dry run (nothing is written);
 * apply writes. Both read the source's notification secrets to build channels, so they need `read:secrets`
 * as well as `write` for a token; team and server permissions are enforced in the service.
 */
@ApiTags("monitors")
@ApiSecurity("pat")
@Controller("monitors/import/kuma")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class KumaImportController {
  constructor(private readonly kuma: KumaImportService) {}

  /** Find Uptime Kuma containers on one of the team's servers (nothing is read from them yet). */
  @Post("detect")
  @HttpCode(200)
  @RequireScopes("write")
  @ApiZodBody(KumaDetectSchema)
  detect(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(KumaDetectSchema)) body: KumaDetectInput) {
    return this.kuma.detect(user.userId, body);
  }

  /** Dry run: what would be imported, what already exists, what cannot be carried over. */
  @Post("preview")
  @HttpCode(200)
  @RequireScopes("write", "read:secrets")
  @ApiZodBody(KumaPreviewSchema)
  preview(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(KumaPreviewSchema)) body: KumaPreviewInput) {
    return this.kuma.preview(user.userId, body);
  }

  /** Create the monitors (and the channels the caller confirmed). */
  @Post("apply")
  @HttpCode(200)
  @RequireScopes("write", "read:secrets")
  @ApiZodBody(KumaApplySchema)
  apply(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(KumaApplySchema)) body: KumaApplyInput) {
    return this.kuma.apply(user.userId, body);
  }
}
