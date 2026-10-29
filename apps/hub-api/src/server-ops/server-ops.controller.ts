import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  type MessageEvent,
  Param,
  Post,
  Put,
  Query,
  Sse,
  UseGuards,
} from "@nestjs/common";
import { concat, EMPTY, from, map, mergeMap, type Observable } from "rxjs";
import { ApiTags, ApiSecurity } from "@nestjs/swagger";
import { ApiZodBody } from "../openapi/openapi";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { ApiAuthGuard } from "../api-tokens/api-auth.guard";
import { ScopesGuard } from "../api-tokens/scopes.guard";
import { RequireScopes } from "../api-tokens/require-scopes.decorator";
import { AuthUser } from "../auth/strategies/jwt.strategy";
import { CleanupService } from "./cleanup.service";
import { PatchService } from "./patch.service";
import { LogDrainService } from "./log-drain.service";
import { ProxyOpsService } from "./proxy-ops.service";
import { ContainerOpsService } from "./container-ops.service";
import { ContainerLogStreamGuard } from "./container-log-stream.guard";
import {
  CleanupConfigInput,
  CleanupConfigSchema,
  ContainerActionInput,
  ContainerActionSchema,
  CreateLogDrainInput,
  CreateLogDrainSchema,
  UpdateLogDrainInput,
  UpdateLogDrainSchema,
} from "./dto";

@ApiTags("servers")
@ApiSecurity("pat")
@Controller("servers/:id")
@UseGuards(ApiAuthGuard, ScopesGuard)
export class ServerOpsController {
  constructor(
    private readonly cleanup: CleanupService,
    private readonly patch: PatchService,
    private readonly logDrains: LogDrainService,
    private readonly proxy: ProxyOpsService,
    private readonly containerOps: ContainerOpsService,
  ) {}

  /**
   * Live logs of ANY container on this host (from the Containers tab). Writer-only; logs may contain
   * secrets. The guard authorizes BEFORE @Sse commits a 200 stream, and the container is validated
   * against the host's live inventory so only a container actually on this server can be targeted.
   */
  @Sse("containers/logs/stream")
  @RequireScopes("read:secrets")
  @UseGuards(ContainerLogStreamGuard)
  async containerLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("container") container: string,
    @Query("tail") tail?: string,
    @Query("follow") follow?: string,
    @Query("since") since?: string,
    @Query("search") search?: string,
  ): Promise<Observable<MessageEvent>> {
    const stream = await this.containerOps.streamLogs(user.userId, id, container, {
      tail: tail ? Number(tail) : undefined,
      follow: follow !== "0",
      since,
      search,
    });
    return stream.pipe(map((event) => ({ data: JSON.stringify(event) }) as MessageEvent));
  }

  /** Host-wide container list INCLUDING stopped ones (so the tab can offer Start). Writer-level service-side. */
  @Get("containers/all")
  listContainers(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.containerOps.list(user.userId, id);
  }

  /** Lifecycle action on a container (start / restart / stop / remove). Writer-only; strong guards service-side. */
  @Post("containers/action")
  @RequireScopes("deploy")
  @HttpCode(200)
  @ApiZodBody(ContainerActionSchema)
  async containerAction(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ContainerActionSchema)) body: ContainerActionInput,
  ) {
    await this.containerOps.action(user.userId, id, body.container, body.action, body.confirmName);
    return { ok: true };
  }

  /** One-shot container-log export (writer-only) — a downloadable text file. */
  @Get("containers/logs/download")
  @RequireScopes("read:secrets")
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="container.log"')
  downloadContainerLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("container") container: string,
    @Query("tail") tail?: string,
    @Query("since") since?: string,
  ): Promise<string> {
    return this.containerOps.downloadLogs(user.userId, id, container, {
      tail: tail ? Number(tail) : undefined,
      since,
    });
  }

  @Get("proxy")
  proxyStatus(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.status(user.userId, id);
  }

  @Post("proxy/start")
  @RequireScopes("deploy")
  @HttpCode(200)
  proxyStart(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.start(user.userId, id);
  }

  @Post("proxy/stop")
  @RequireScopes("deploy")
  @HttpCode(200)
  proxyStop(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.stop(user.userId, id);
  }

  @Post("proxy/restart")
  @RequireScopes("deploy")
  @HttpCode(200)
  proxyRestart(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.proxy.restart(user.userId, id);
  }

  @Get("proxy/logs")
  proxyLogs(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Query("tail") tail?: string,
  ) {
    return this.proxy.logs(user.userId, id, tail ? Number(tail) : undefined);
  }

  @Get("log-drains")
  listLogDrains(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.logDrains.list(user.userId, id);
  }

  @Post("log-drains")
  @ApiZodBody(CreateLogDrainSchema)
  createLogDrain(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CreateLogDrainSchema)) body: CreateLogDrainInput,
  ) {
    return this.logDrains.create(user.userId, id, body);
  }

  @Put("log-drains/:drainId")
  @HttpCode(200)
  @ApiZodBody(UpdateLogDrainSchema)
  updateLogDrain(
    @CurrentUser() user: AuthUser,
    @Param("drainId") drainId: string,
    @Body(new ZodValidationPipe(UpdateLogDrainSchema)) body: UpdateLogDrainInput,
  ) {
    return this.logDrains.update(user.userId, drainId, body);
  }

  @Delete("log-drains/:drainId")
  @HttpCode(200)
  async deleteLogDrain(@CurrentUser() user: AuthUser, @Param("drainId") drainId: string) {
    await this.logDrains.remove(user.userId, drainId);
    return { ok: true };
  }

  // deploy-tier: the check now runs a PRIVILEGED host `apt-get update` (host-exec), so it must not be
  // reachable by a read-only PAT — it is a host mutation surface, not a plain read.
  @Get("updates")
  @RequireScopes("deploy")
  checkUpdates(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.patch.checkUpdates(user.userId, id);
  }

  @Post("updates/apply")
  @RequireScopes("deploy")
  @HttpCode(200)
  upgradeAll(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.patch.upgradeAll(user.userId, id);
  }

  @Post("updates/apply/:pkg")
  @RequireScopes("deploy")
  @HttpCode(200)
  upgradeOne(@CurrentUser() user: AuthUser, @Param("id") id: string, @Param("pkg") pkg: string) {
    return this.patch.upgradeOne(user.userId, id, pkg);
  }

  /** Live patch-log stream (SSE). Completes when no patch run is active. */
  @Sse("updates/stream")
  streamLogs(@CurrentUser() user: AuthUser, @Param("id") id: string): Observable<MessageEvent> {
    return from(this.patch.streamLogs(user.userId, id)).pipe(
      mergeMap((sub) => (sub ? concat(from(sub.replay), sub.live) : EMPTY)),
      map((event) => ({ data: JSON.stringify(event) }) as MessageEvent),
    );
  }

  @Post("cleanup")
  @RequireScopes("deploy")
  @HttpCode(200)
  cleanupNow(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.cleanup.cleanupNow(user.userId, id);
  }

  @Put("cleanup-config")
  @HttpCode(200)
  @ApiZodBody(CleanupConfigSchema)
  async setConfig(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(CleanupConfigSchema)) body: CleanupConfigInput,
  ) {
    await this.cleanup.setConfig(user.userId, id, body);
    return { ok: true };
  }
}
