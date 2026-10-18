import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiSecurity, ApiTags } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Paginated } from "../common/pagination.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { DnsCredentialsService } from "./dns-credentials.service";
import { CreateDnsCredentialInput, CreateDnsCredentialSchema, UpdateDnsCredentialInput, UpdateDnsCredentialSchema } from "./dto";

/** Team-scoped DNS-provider credentials. Behind ApiAuthGuard+ScopesGuard so BOTH a browser session (web UI) and
 *  a PAT (CLI/API) can manage them (scope defaults: GET=read, POST/PUT=write, DELETE=admin); the service
 *  additionally enforces the `integrations` team permission. The token is never returned. */
@ApiTags("dns-credentials")
@ApiSecurity("pat")
@Controller("dns-credentials")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class DnsCredentialsController {
  constructor(private readonly svc: DnsCredentialsService) {}

  @Get()
  @Paginated()
  list(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.svc.list(user.userId, q);
  }

  @Post()
  @ApiZodBody(CreateDnsCredentialSchema)
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateDnsCredentialSchema)) body: CreateDnsCredentialInput) {
    return this.svc.create(user.userId, body);
  }

  @Put(":id")
  @HttpCode(200)
  @ApiZodBody(UpdateDnsCredentialSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateDnsCredentialSchema)) body: UpdateDnsCredentialInput,
  ) {
    return this.svc.update(user.userId, id, body);
  }

  @Post(":id/test")
  @HttpCode(200)
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
