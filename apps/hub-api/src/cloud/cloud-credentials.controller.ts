import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { Paginated } from "../common/pagination.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CloudCredentialsService } from "./cloud-credentials.service";
import { CreateCloudCredentialInput, CreateCloudCredentialSchema, UpdateCloudCredentialInput, UpdateCloudCredentialSchema } from "./dto";

@ApiTags("cloud-credentials")
@ApiSecurity("pat")
@Controller("cloud-credentials")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class CloudCredentialsController {
  constructor(private readonly svc: CloudCredentialsService) {}

  @Get()
  @Paginated()
  list(@CurrentUser() user: AuthUser, @Query("q") q?: string) {
    return this.svc.list(user.userId, q);
  }

  @Post()
  @ApiZodBody(CreateCloudCredentialSchema)
  create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateCloudCredentialSchema)) body: CreateCloudCredentialInput) {
    return this.svc.create(user.userId, body);
  }

  @Put(":id")
  @HttpCode(200)
  @ApiZodBody(UpdateCloudCredentialSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateCloudCredentialSchema)) body: UpdateCloudCredentialInput,
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
