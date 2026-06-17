import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { MonitorsService } from "./monitors.service";
import { CreateMonitorInput, CreateMonitorSchema } from "./dto";

@Controller("monitors")
@UseGuards(ApiAuthGuard)
export class MonitorsController {
  constructor(private readonly monitors: MonitorsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.monitors.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateMonitorSchema)) body: CreateMonitorInput,
  ) {
    return this.monitors.create(user.userId, body);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.monitors.get(user.userId, id);
  }

  @Get(":id/heartbeats")
  heartbeats(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("limit") limit?: string,
  ) {
    return this.monitors.heartbeats(user.userId, id, limit ? Number(limit) : 60);
  }

  @Get(":id/uptime")
  uptime(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.monitors.uptime(user.userId, id);
  }

  @Post(":id/check")
  @HttpCode(200)
  check(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.monitors.check(user.userId, id);
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.monitors.remove(user.userId, id);
    return { ok: true };
  }
}
