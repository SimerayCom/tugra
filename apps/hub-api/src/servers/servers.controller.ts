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
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody, ApiZodResponse } from "../openapi/openapi";

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
}
import { ServerStatus } from "@prisma/client";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { SetTagsSchema, type SetTagsInput } from "../common/tags";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { parseDate, str } from "../audit/audit.controller";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { MetricsService } from "../metrics/metrics.service";
import { MetricsLiveService } from "../metrics/metrics-live.service";
import { ContainerMetricsService } from "../metrics/container-metrics.service";
import { ServersService, ServerViewSchema } from "./servers.service";
import {
  CreateServerInput,
  CreateServerSchema,
  NetworkSettingsInput,
  NetworkSettingsSchema,
  SetCapabilitiesInput,
  SetCapabilitiesSchema,
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

@ApiTags("servers")
@ApiSecurity("pat")
@Controller("servers")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ServersController {
  constructor(
    private readonly servers: ServersService,
    private readonly metrics: MetricsService,
    private readonly metricsLive: MetricsLiveService,
    private readonly containerMetrics: ContainerMetricsService,
  ) {}

  @Get()
  @ApiZodResponse(ServerViewSchema, { isArray: true })
  list(
    @CurrentUser() user: AuthUser,
    @Query("teamId") teamId?: string,
    @Query("status") status?: ServerStatus,
  ) {
    return this.servers.listForUser(user.userId, { teamId, status });
  }

  @Get(":id")
  @ApiZodResponse(ServerViewSchema)
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.servers.getForUser(user.userId, id);
  }

  // This server's audit history (every actor; team membership gates it). Optional ?action=&from=&to=&cursor=.
  @Get(":id/audit")
  listAudit(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("cursor") cursor?: string,
    @Query("action") action?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.servers.listAudit(user.userId, id, { cursor: str(cursor), action: str(action), from: parseDate(from), to: parseDate(to) });
  }

  @Get(":id/metrics")
  async getMetrics(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("limit") limit?: string,
    @Query("range") range?: string,
  ) {
    await this.servers.getForUser(user.userId, id); // authz: membership check
    // range → history (raw ≤24h / rollup 7d, LTTB); no range → live last-N (SSE-backed tab).
    return range ? this.metrics.history(id, range) : this.metrics.recent(id, limit ? Number(limit) : 60);
  }

  /** Live inventory of every container on this host (Tugra + others) with its latest stats. */
  @Get(":id/metrics/containers")
  async serverContainers(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    await this.servers.getForUser(user.userId, id); // authz: membership check (read-level)
    return this.containerMetrics.forServer(id);
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
  @ApiZodBody(CreateServerSchema)
  create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(CreateServerSchema)) body: CreateServerInput,
    @Req() req: ReqLike,
  ) {
    return this.servers.createServer(user.userId, body.name, body.teamId, publicUrlFrom(req));
  }

  // The install command embeds the server enroll token — a bearer credential that lets its holder
  // enroll as this server (takeover). Reading it is a secret read; regenerating it also mutates.
  @Get(":id/install")
  @RequireScopes("read:secrets")
  getInstall(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: ReqLike) {
    return this.servers.getInstall(user.userId, id, publicUrlFrom(req));
  }

  @Post(":id/reissue")
  @RequireScopes("write", "read:secrets")
  @HttpCode(200)
  reissue(@CurrentUser() user: AuthUser, @Param("id") id: string, @Req() req: ReqLike) {
    return this.servers.reissueEnroll(user.userId, id, publicUrlFrom(req));
  }

  @Put(":id/tags")
  @HttpCode(200)
  @ApiZodBody(SetTagsSchema)
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
  @ApiZodBody(NetworkSettingsSchema)
  async setNetwork(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(NetworkSettingsSchema)) body: NetworkSettingsInput,
  ) {
    await this.servers.setNetwork(user.userId, id, body);
    return { ok: true };
  }

  @Put(":id/capabilities")
  @HttpCode(200)
  @ApiZodBody(SetCapabilitiesSchema)
  async setCapabilities(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(SetCapabilitiesSchema)) body: SetCapabilitiesInput,
  ) {
    await this.servers.setCapabilities(user.userId, id, body.capabilities);
    return { ok: true };
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@CurrentUser() user: AuthUser, @Param("id") id: string, @Query("destroyVm") destroyVm?: string) {
    await this.servers.deleteForUser(user.userId, id, { destroyVm: destroyVm === "true" });
    return { ok: true };
  }
}
