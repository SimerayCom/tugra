import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards, UseInterceptors } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { RedactSecretsInterceptor } from "../api-tokens/redact-secrets.interceptor";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody } from "../openapi/openapi";
import { CoolifyHostGrantService } from "./coolify-host-grant.service";
import { ListQuerySchema, SecretsGrantSchema, type ListQuery, type SecretsGrantInput } from "./dto";

/**
 * Consent for the sealed secret read of a Coolify host. Creating or revoking a grant is team OWNER only (checked in the service, which
 * also asks for the typed host name); listing is OWNER/ADMIN. There is deliberately NO endpoint that returns a secret value, a key or an
 * envelope: the views carry the consent (classes, window, status) and nothing else. The interceptor is defense in depth for the key
 * columns should a future view ever carry them.
 */
@ApiTags("coolify-takeover")
@ApiSecurity("pat")
@Controller("coolify-takeover/secrets")
@UseGuards(ApiAuthGuard, ScopesGuard)
@UseInterceptors(new RedactSecretsInterceptor(["recipientKeyEnc", "recipientPublicKey", "recipientKey", "runId"]))
export class CoolifySecretsController {
  constructor(private readonly grants: CoolifyHostGrantService) {}

  /** The consent grants of a team (active, expired, revoked). */
  @Get("grants")
  list(@CurrentUser() user: AuthUser, @Query(new ZodValidationPipe(ListQuerySchema)) q: ListQuery) {
    return this.grants.list(user.userId, q.teamId);
  }

  /** Consent to the sealed read of Coolify's secrets on one host: owner only, typed host name, time limited. */
  @Post("grants")
  @HttpCode(200)
  @RequireScopes("write", "read:secrets")
  @ApiZodBody(SecretsGrantSchema)
  grant(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(SecretsGrantSchema)) body: SecretsGrantInput) {
    return this.grants.createSecretsGrant(user.userId, body);
  }

  /** Withdraw consent now: the capability drops and the run key is destroyed. */
  @Delete("grants/:grantId")
  @RequireScopes("write")
  revoke(@CurrentUser() user: AuthUser, @Param("grantId") grantId: string) {
    return this.grants.revoke(user.userId, grantId);
  }
}
