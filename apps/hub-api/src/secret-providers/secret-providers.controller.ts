import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Paginated } from "../common/pagination.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireEdition, RequireEditionGuard } from "../common/edition";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { SecretProvidersService } from "./secret-providers.service";
import {
  CreateSecretProviderInput,
  CreateSecretProviderSchema,
  UpdateSecretProviderInput,
  UpdateSecretProviderSchema,
} from "./dto";

/** Team-scoped external secret-store providers (HashiCorp Vault in v1). Behind ApiAuthGuard+ScopesGuard so
 *  BOTH a browser session (web UI) and a PAT (CLI/API) can manage them (scope defaults: GET=read, POST/PUT=write,
 *  DELETE=admin); the service additionally enforces the `integrations` team permission. The token is never
 *  returned. CONFIGURING a provider (create/update/test) is PRO-EDITION ONLY (RequireEditionGuard → 403 on
 *  Community) — this is an open-core governance feature; list + delete stay open so a downgraded instance can
 *  still see and remove what it has, and the deploy-time resolver keeps working so running apps don't break. */
@ApiTags("secret-providers")
@ApiSecurity("pat")
@Controller("secret-providers")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class SecretProvidersController {
  constructor(private readonly svc: SecretProvidersService) {}

  @Get()
  @Paginated()
  list(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.svc.list(user.userId, q);
  }

  @Post()
  @RequireEdition("pro")
  @UseGuards(RequireEditionGuard)
  @ApiZodBody(CreateSecretProviderSchema)
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateSecretProviderSchema)) body: CreateSecretProviderInput) {
    return this.svc.create(user.userId, body);
  }

  @Put(":id")
  @HttpCode(200)
  @RequireEdition("pro")
  @UseGuards(RequireEditionGuard)
  @ApiZodBody(UpdateSecretProviderSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateSecretProviderSchema)) body: UpdateSecretProviderInput,
  ) {
    return this.svc.update(user.userId, id, body);
  }

  @Post(":id/test")
  @HttpCode(200)
  @RequireEdition("pro")
  @UseGuards(RequireEditionGuard)
  test(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.test(user.userId, id);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.svc.remove(user.userId, id);
    return { ok: true };
  }
}
