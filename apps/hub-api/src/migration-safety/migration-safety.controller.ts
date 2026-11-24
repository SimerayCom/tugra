import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { runActorFromAuth } from "../migration-runs/core/run-contract";
import { VerificationService } from "./verification.service";
import { RunVerificationSchema, type RunVerificationInput } from "./verification.dto";

/**
 * Migration safety: the verification report (source vs target, before the DNS change). Every route goes through the run
 * facade first, so the creator-only ownership and the team permission are the run's own; reading needs no extra scope,
 * running a fresh comparison needs `deploy` like every other act on a run.
 */
@ApiTags("import")
@ApiSecurity("pat")
@Controller("migration-runs")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class MigrationSafetyController {
  constructor(private readonly verification: VerificationService) {}

  /** The latest stored verification report (null until one ran), plus the preview addresses the owner can open. */
  @Get(":id/verification")
  verificationLatest(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.verification.latest(runActorFromAuth(user), id);
  }

  /** Compare source and target now: status and content hash of the key pages, table row counts, volume size, env keys. */
  @Post(":id/verification")
  @HttpCode(200)
  @RequireScopes("deploy")
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiZodBody(RunVerificationSchema)
  verificationRun(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body(new ZodValidationPipe(RunVerificationSchema)) body: RunVerificationInput) {
    return this.verification.run(runActorFromAuth(user), id, body.paths);
  }
}
