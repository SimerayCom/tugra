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
  Sse,
  UseGuards,
  type MessageEvent,
} from "@nestjs/common";
import { from, interval, map, merge, mergeMap, type Observable } from "rxjs";

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
import { MetricsLiveService } from "../metrics/metrics-live.service";
import { ServersService } from "./servers.service";
import {
  CreateServerInput,
  CreateServerSchema,
  NetworkSettingsInput,
  NetworkSettingsSchema,
} from "./dto/servers.schemas";

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
    private readonly metricsLive: MetricsLiveService,
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

  /**
   * Live metrics stream (SSE). Pushes each sample the agent publishes instead of
   * polling; a periodic ping keeps the connection warm behind idle proxies. The
   * client still seeds history from GET :id/metrics and heals via a slow refetch.
   */
  @Sse(":id/metrics/stream")
  streamMetrics(@CurrentUser() user: AuthUser, @Param("id") id: string): Observable<MessageEvent> {
    return from(this.servers.getForUser(user.userId, id)).pipe(
      mergeMap(() =>
        merge(
          this.metricsLive
            .subscribe(id)
            .pipe(map((sample) => ({ data: JSON.stringify(sample) }) as MessageEvent)),
          interval(25_000).pipe(map(() => ({ data: JSON.stringify({ type: "ping" }) }) as MessageEvent)),
        ),
      ),
    );
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateServerSchema)) body: CreateServerInput,
    @Req() req: ReqLike,
  ) {
    return this.servers.createServer(user.userId, body.name, body.teamId, publicUrlFrom(req));
  }

  @Get(":id/install")
  getInstall(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: ReqLike) {
    return this.servers.getInstall(user.userId, id, publicUrlFrom(req));
  }

  @Post(":id/reissue")
  @HttpCode(200)
  reissue(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: ReqLike) {
    return this.servers.reissueEnroll(user.userId, id, publicUrlFrom(req));
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

  @Put(":id/network")
  @HttpCode(200)
  async setNetwork(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(NetworkSettingsSchema)) body: NetworkSettingsInput,
  ) {
    await this.servers.setNetwork(user.userId, id, body);
    return { ok: true };
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.servers.deleteForUser(user.userId, id);
    return { ok: true };
  }
}
