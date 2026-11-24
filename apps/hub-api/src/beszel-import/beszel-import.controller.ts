import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { BeszelImportService } from "./beszel-import.service";
import { BeszelApplySchema, BeszelConnectSchema, BeszelPreviewSchema, type BeszelApplyInput, type BeszelConnectInput, type BeszelPreviewInput } from "./dto";

/**
 * Import from a Beszel hub: connect (sign in, credentials stored encrypted), preview (dry-run, nothing written) and apply
 * (bound to the reviewed preview). Team scoping and per-part permissions are enforced in the service.
 */
@ApiTags("import")
@ApiSecurity("pat")
@Controller("import/beszel")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class BeszelImportController {
  constructor(private readonly beszel: BeszelImportService) {}

  /** Sign in to a Beszel hub and keep the credentials encrypted for the import (1 h, or 30 days when asked). */
  @Post("connect")
  @RequireScopes("write")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiZodBody(BeszelConnectSchema)
  connect(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(BeszelConnectSchema)) body: BeszelConnectInput) {
    return this.beszel.connect(user.userId, body);
  }

  /** The caller's kept Beszel connections (opt-in "keep credentials"), newest first. No secret is returned. */
  @Get("sessions")
  list(@CurrentUser() user: AuthUser) {
    return this.beszel.listKept(user.userId);
  }

  /** Dry-run: systems and how they match Tugra servers, alert rules, channels and the history that would be imported. */
  @Post("preview")
  @HttpCode(200)
  @RequireScopes("write")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiZodBody(BeszelPreviewSchema)
  preview(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(BeszelPreviewSchema)) body: BeszelPreviewInput) {
    return this.beszel.preview(user.userId, body);
  }

  /** Apply the reviewed preview. `previewHash` must match a fresh re-plan or the apply is refused (409). */
  @Post("apply")
  @HttpCode(200)
  @RequireScopes("write")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiZodBody(BeszelApplySchema)
  apply(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(BeszelApplySchema)) body: BeszelApplyInput) {
    return this.beszel.apply(user.userId, body);
  }

  /** Drop the stored Beszel credentials now. */
  @Delete("sessions/:sessionId")
  @HttpCode(204)
  @RequireScopes("write")
  async disconnect(@CurrentUser() user: AuthUser, @Param("sessionId") sessionId: string): Promise<void> {
    await this.beszel.disconnect(user.userId, sessionId);
  }
}
