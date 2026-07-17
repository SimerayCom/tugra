import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { SetTagsSchema, type SetTagsInput } from "../common/tags";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { RedactSecretsInterceptor } from "../api-tokens/redact-secrets.interceptor";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { DatabasesService, DatabaseViewSchema } from "./databases.service";
import {
  CreateDatabaseInput,
  CreateDatabaseSchema,
  RenameInput,
  RenameSchema,
  SetDatabaseLimitsInput,
  SetDatabaseLimitsSchema,
  SetDatabasePortInput,
  SetDatabasePortSchema,
  SetEnvironmentInput,
  SetEnvironmentSchema,
} from "./dto";

@ApiTags("databases")
@ApiSecurity("pat")
@Controller("databases")
@UseGuards(ApiAuthGuard, ScopesGuard)
@UseInterceptors(new RedactSecretsInterceptor(["password", "connectionUri", "username", "internalHost"]))
export class DatabasesController {
  constructor(private readonly databases: DatabasesService) {}

  @Get()
  @ApiZodResponse(DatabaseViewSchema, { isArray: true })
  list(@CurrentUser() user: AuthUser) {
    return this.databases.list(user.userId);
  }

  @Post()
  @ApiZodBody(CreateDatabaseSchema)
  @ApiZodResponse(DatabaseViewSchema, { status: 201 })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateDatabaseSchema)) body: CreateDatabaseInput,
  ) {
    return this.databases.create(user.userId, body);
  }

  @Get(":id")
  @ApiZodResponse(DatabaseViewSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.databases.get(user.userId, id);
  }

  @Post(":id/provision")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodResponse(DatabaseViewSchema)
  provision(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.databases.provision(user.userId, id);
  }

  @Post(":id/stop")
  @RequireScopes("deploy")
  @HttpCode(200)
  async stop(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.databases.stop(user.userId, id);
    return { ok: true };
  }

  @Put(":id/environment")
  @HttpCode(200)
  @ApiZodBody(SetEnvironmentSchema)
  async setEnvironment(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetEnvironmentSchema)) body: SetEnvironmentInput,
  ) {
    await this.databases.setEnvironment(user.userId, id, body.environmentId);
    return { ok: true };
  }

  @Put(":id/tags")
  @HttpCode(200)
  @ApiZodBody(SetTagsSchema)
  async setTags(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetTagsSchema)) body: SetTagsInput,
  ) {
    await this.databases.setTags(user.userId, id, body.tags);
    return { ok: true };
  }

  @Put(":id/limits")
  @HttpCode(200)
  @ApiZodBody(SetDatabaseLimitsSchema)
  async setLimits(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDatabaseLimitsSchema)) body: SetDatabaseLimitsInput,
  ) {
    await this.databases.setLimits(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/name")
  @HttpCode(200)
  @ApiZodBody(RenameSchema)
  async rename(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RenameSchema)) body: RenameInput,
  ) {
    await this.databases.rename(user.userId, id, body.name);
    return { ok: true };
  }

  @Put(":id/port")
  @HttpCode(200)
  @ApiZodBody(SetDatabasePortSchema)
  async setPort(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetDatabasePortSchema)) body: SetDatabasePortInput,
  ) {
    await this.databases.setPort(user.userId, id, body.hostPort);
    return { ok: true };
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.databases.remove(user.userId, id);
    return { ok: true };
  }
}
