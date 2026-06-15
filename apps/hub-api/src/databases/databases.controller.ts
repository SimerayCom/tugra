import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { DatabasesService } from "./databases.service";
import { CreateDatabaseInput, CreateDatabaseSchema } from "./dto";

@Controller("databases")
@UseGuards(JwtAuthGuard)
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

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.databases.remove(user.userId, id);
    return { ok: true };
  }
}
