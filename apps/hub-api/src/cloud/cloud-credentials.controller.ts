import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CloudCredentialsService } from "./cloud-credentials.service";
import { CreateCloudCredentialInput, CreateCloudCredentialSchema, UpdateCloudCredentialInput, UpdateCloudCredentialSchema } from "./dto";

@ApiTags("cloud-credentials")
@ApiCookieAuth("session")
@Controller("cloud-credentials")
@UseGuards(JwtAuthGuard)
export class CloudCredentialsController {
  constructor(private readonly svc: CloudCredentialsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user.userId);
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
