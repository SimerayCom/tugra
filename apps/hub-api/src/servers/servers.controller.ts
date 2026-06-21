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
  Req,
  UseGuards,
} from "@nestjs/common";

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
}
import { ServerStatus } from "@prisma/client";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { SetTagsSchema, type SetTagsInput } from "../common/tags";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { MetricsService } from "../metrics/metrics.service";
import { ServersService } from "./servers.service";
import { CreateServerInput, CreateServerSchema } from "./dto/servers.schemas";

/** Best-effort public base URL of this hub from the request (proxy-aware). */
function publicUrlFrom(req: ReqLike): string | undefined {
  const fwdHost = req.headers["x-forwarded-host"];
  const host = (Array.isArray(fwdHost) ? fwdHost[0] : fwdHost) ?? req.headers.host;
  if (!host) return undefined;
  const fwdProto = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(fwdProto) ? fwdProto[0] : fwdProto)?.split(",")[0] ?? "http";
  return `${proto}://${host}`;
}

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
    @Req() req: ReqLike,
  ) {
    return this.servers.createServer(user.userId, body.name, body.teamId, publicUrlFrom(req));
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
