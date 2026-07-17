import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";
import { MonitorsService, MonitorViewSchema } from "./monitors.service";
import {
  BulkMonitorChannelsInput,
  BulkMonitorChannelsSchema,
  CreateMonitorInput,
  CreateMonitorSchema,
  UpdateMonitorInput,
  UpdateMonitorSchema,
} from "./dto";

@ApiTags("monitors")
@ApiSecurity("pat")
@Controller("monitors")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class MonitorsController {
  constructor(private readonly monitors: MonitorsService) {}

  @Get()
  @ApiZodResponse(MonitorViewSchema, { isArray: true })
  list(@CurrentUser() user: AuthUser) {
    return this.monitors.list(user.userId);
  }

  @Post()
  @ApiZodBody(CreateMonitorSchema)
  @ApiZodResponse(MonitorViewSchema, { status: 201 })
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateMonitorSchema)) body: CreateMonitorInput,
  ) {
    return this.monitors.create(user.userId, body);
  }

  // Static segment before ":id" so it isn't matched as a monitor id.
  @Post("channels/bulk")
  @HttpCode(200)
  @ApiZodBody(BulkMonitorChannelsSchema)
  bulkChannels(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(BulkMonitorChannelsSchema)) body: BulkMonitorChannelsInput,
  ) {
    return this.monitors.setChannelsBulk(user.userId, body.monitorIds, body.channelIds);
  }

  @Get(":id")
  @ApiZodResponse(MonitorViewSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.monitors.get(user.userId, id);
  }

  @Put(":id")
  @HttpCode(200)
  @ApiZodBody(UpdateMonitorSchema)
  @ApiZodResponse(MonitorViewSchema)
  update(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateMonitorSchema)) body: UpdateMonitorInput,
  ) {
    return this.monitors.update(user.userId, id, body);
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
