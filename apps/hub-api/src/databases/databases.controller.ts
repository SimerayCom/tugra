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
} from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { SetTagsSchema, type SetTagsInput } from "../common/tags";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { DatabasesService } from "./databases.service";
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

@Controller("databases")
@UseGuards(ApiAuthGuard)
export class DatabasesController {
  constructor(private readonly databases: DatabasesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.databases.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateDatabaseSchema)) body: CreateDatabaseInput,
  ) {
    return this.databases.create(user.userId, body);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.databases.get(user.userId, id);
  }

  @Post(":id/provision")
  @HttpCode(200)
  provision(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.databases.provision(user.userId, id);
  }

  @Post(":id/stop")
  @HttpCode(200)
  async stop(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.databases.stop(user.userId, id);
    return { ok: true };
  }

  @Put(":id/environment")
  @HttpCode(200)
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
