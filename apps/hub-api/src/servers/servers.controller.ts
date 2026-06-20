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
import { ServerStatus } from "@prisma/client";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { SetTagsSchema, type SetTagsInput } from "../common/tags";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { MetricsService } from "../metrics/metrics.service";
import { ServersService } from "./servers.service";
import { CreateServerInput, CreateServerSchema } from "./dto/servers.schemas";

@Controller("servers")
@UseGuards(ApiAuthGuard)
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly metrics: MetricsService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query("teamId") teamId?: string,
    @Query("status") status?: ServerStatus,
  ) {
    return this.servers.listForUser(user.userId, { teamId, status });
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.servers.getForUser(user.userId, id);
  }

  @Get(":id/metrics")
  async getMetrics(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("limit") limit?: string,
  ) {
    await this.servers.getForUser(user.userId, id); // authz: membership check
    return this.metrics.recent(id, limit ? Number(limit) : 60);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateServerSchema)) body: CreateServerInput,
  ) {
    return this.servers.createServer(user.userId, body.name, body.teamId);
  }

  @Put(":id/tags")
  @HttpCode(200)
  async setTags(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetTagsSchema)) body: SetTagsInput,
  ) {
    await this.servers.setTags(user.userId, id, body.tags);
    return { ok: true };
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.servers.deleteForUser(user.userId, id);
    return { ok: true };
  }
}
