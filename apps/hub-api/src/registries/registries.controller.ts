import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiTags, ApiCookieAuth } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { RegistriesService } from "./registries.service";
import { CreateRegistryInput, CreateRegistrySchema, UpdateRegistryInput, UpdateRegistrySchema } from "./dto";

@ApiTags("registries")
@ApiCookieAuth("session")
@Controller("registries")
@UseGuards(JwtAuthGuard)
export class RegistriesController {
  constructor(private readonly svc: RegistriesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user.userId);
  }

  @Post()
  @ApiZodBody(CreateRegistrySchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateRegistrySchema)) body: CreateRegistryInput,
  ) {
    return this.svc.create(user.userId, body);
  }

  @Put(":id")
  @HttpCode(200)
  @ApiZodBody(UpdateRegistrySchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateRegistrySchema)) body: UpdateRegistryInput,
  ) {
    return this.svc.update(user.userId, id, body);
  }

  @Post(":id/test")
  @HttpCode(200)
  test(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.testLogin(user.userId, id);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.svc.remove(user.userId, id);
    return { ok: true };
  }
}
